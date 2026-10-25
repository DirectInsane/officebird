import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/search/query.js", import.meta.url), "utf8"), context);
const { parse, print } = context.qolSearchQuery;

const leaf = (field, value, extra = {}) => ({ field, value, negated: false, phrase: false, ...extra });
// Objects from the vm context have another prototype; compare as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a keyword and a bare word", () => {
  assert.deepEqual(plain(parse("from:matt invoice")), {
    or: [[leaf("from", "matt"), leaf("body", "invoice")]],
  });
});

test("German keywords", () => {
  const q = parse("von:matt betreff:Angebot hat:anhang ist:ungelesen ist:markiert schlagwort:wichtig");
  assert.deepEqual(plain(q.or[0]).map((l) => l.field),
    ["from", "subject", "attachment", "unread", "flagged", "tag"]);
  assert.deepEqual(plain(q.or[0]).map((l) => l.value),
    ["matt", "Angebot", true, true, true, "wichtig"]);
});

test("remaining keywords in both languages", () => {
  const q = parse("to:a an:b in:Inbox after:2026-01-02 nach:2026-01-03 before:2026-01-04 vor:2026-01-05");
  assert.deepEqual(plain(q.or[0]).map((l) => l.field),
    ["to", "to", "in", "after", "after", "before", "before"]);
});

test("keywords are case-insensitive, values keep their case", () => {
  assert.deepEqual(plain(parse("FROM:Matt")), { or: [[leaf("from", "Matt")]] });
  assert.equal(parse("Has:Attachment").or[0][0].field, "attachment");
});

test("OR and ODER split conjunctions, lowercase or is a word", () => {
  const expected = { or: [[leaf("body", "a"), leaf("body", "b")], [leaf("body", "c")]] };
  assert.deepEqual(plain(parse("a b OR c")), expected);
  assert.deepEqual(plain(parse("a b ODER c")), expected);
  assert.deepEqual(plain(parse("a or c")), { or: [[leaf("body", "a"), leaf("body", "or"), leaf("body", "c")]] });
});

test("minus negates words, keywords and flags", () => {
  const q = parse("-newsletter -from:amazon -is:unread");
  assert.deepEqual(plain(q.or[0]), [
    leaf("body", "newsletter", { negated: true }),
    leaf("from", "amazon", { negated: true }),
    leaf("unread", true, { negated: true }),
  ]);
});

test("quoted phrases", () => {
  const q = parse('"exact phrase" x');
  assert.deepEqual(plain(q.or[0][0]), leaf("body", "exact phrase", { phrase: true }));
  assert.deepEqual(plain(q.or[0][1]), leaf("body", "x"));
});

test("quoted values for in: and tag:", () => {
  const q = parse('in:"My Folder" tag:"to do" -in:"A B"');
  assert.deepEqual(plain(q.or[0]).map((l) => [l.field, l.value, l.negated]),
    [["in", "My Folder", false], ["tag", "to do", false], ["in", "A B", true]]);
});

test("dates in both formats", () => {
  assert.equal(parse("after:2026-10-01").or[0][0].value, "2026-10-01");
  assert.equal(parse("nach:1.10.2026").or[0][0].value, "2026-10-01");
  assert.equal(parse("before:01.10.2026").or[0][0].value, "2026-10-01");
});

test("invalid dates keep their text and carry an error", () => {
  const l = plain(parse("before:32.13.2026").or[0][0]);
  assert.equal(l.field, "before");
  assert.equal(l.error, "date");
  assert.equal(l.raw, "32.13.2026");
  assert.equal(plain(parse("after:2026-02-30").or[0][0]).error, "date");
});

test("unknown keywords and unknown flag values are text", () => {
  assert.deepEqual(plain(parse("foo:bar")), { or: [[leaf("body", "foo:bar")]] });
  assert.deepEqual(plain(parse("has:foo")), { or: [[leaf("body", "has:foo")]] });
  assert.deepEqual(plain(parse("from:")), { or: [[leaf("body", "from:")]] });
});

test("empty text and stray OR", () => {
  assert.deepEqual(plain(parse("")), { or: [] });
  assert.deepEqual(plain(parse("   \t ")), { or: [] });
  assert.deepEqual(plain(parse("a OR")), { or: [[leaf("body", "a")]] });
  assert.deepEqual(plain(parse("OR a OR OR b")), { or: [[leaf("body", "a")], [leaf("body", "b")]] });
});

test("print uses the keywords of the language", () => {
  assert.equal(print(parse("von:matt"), "en"), "from:matt");
  assert.equal(print(parse("from:matt"), "de"), "von:matt");
  const text = "from:a to:b subject:c in:d after:2026-01-01 before:2026-02-01 tag:e has:attachment is:unread is:flagged";
  assert.equal(print(parse(text), "de"),
    "von:a an:b betreff:c in:d nach:2026-01-01 vor:2026-02-01 schlagwort:e hat:anhang ist:ungelesen ist:markiert");
  assert.equal(print(parse("a OR b"), "de"), "a ODER b");
  assert.equal(print(parse("a ODER b"), "en"), "a OR b");
  assert.equal(print(parse("nach:1.10.2026"), "en"), "after:2026-10-01");
});

test("print quotes values with spaces and phrases, and keeps bad dates", () => {
  assert.equal(print(parse('in:"My Folder" "a b" -tag:"x y"'), "en"), 'in:"My Folder" "a b" -tag:"x y"');
  assert.equal(print(parse("before:32.13.2026"), "en"), "before:32.13.2026");
});

const INPUTS = [
  "from:matt invoice",
  "von:matt betreff:Angebot hat:anhang ist:ungelesen ist:markiert schlagwort:wichtig",
  "FROM:Matt",
  "a b OR c",
  "a b ODER c",
  "a or c",
  "-newsletter -from:amazon -is:unread",
  '"exact phrase" x',
  'in:"My Folder" tag:"to do" -in:"A B"',
  "after:2026-10-01",
  "nach:1.10.2026",
  "before:32.13.2026",
  "foo:bar",
  "from:",
  "a OR",
  "",
  "--x - \"OR\" a\"b",
  '"from:matt"',
];

test("round trip: parse(print(parse(x))) equals parse(x)", () => {
  for (const x of INPUTS) {
    for (const lang of ["en", "de"]) {
      assert.deepEqual(plain(parse(print(parse(x), lang))), plain(parse(x)), `${lang}: ${x}`);
    }
  }
});

test("inherited object property names are not flag values", () => {
  for (const x of ["has:constructor", "is:toString", "is:__proto__"]) {
    assert.deepEqual(plain(parse(x)), { or: [[leaf("body", x)]] }, x);
    assert.deepEqual(plain(parse(print(parse(x), "en"))), plain(parse(x)), x);
  }
});
