import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
for (const file of ["query.js", "panelmodel.js"]) {
  vm.runInNewContext(readFileSync(new URL(`../experiments/search/${file}`, import.meta.url), "utf8"), context);
}
const { parse, print } = context.qolSearchQuery;
const { rowsFromQuery, queryFromRows, hasCriteria } = context.qolSearchPanelModel;

const plain = (value) => JSON.parse(JSON.stringify(value));
const rowsOf = (text) => plain(rowsFromQuery(parse(text)));
const chip = (value, extra = {}) => ({ value, negated: false, phrase: false, orBefore: false, ...extra });

function roundTrip(text) {
  const query = plain(parse(text));
  const rows = rowsFromQuery(query);
  assert.deepEqual(plain(rows.kept), [], text);
  assert.deepEqual(plain(queryFromRows(rows)), query, text);
}

test("an empty query gives empty rows and back", () => {
  const rows = rowsOf("");
  assert.deepEqual(rows, {
    from: [], to: [], subject: [], body: [], folder: [], tags: [],
    after: null, before: null, attachment: "any", unread: "any", flagged: "any", kept: [],
  });
  assert.deepEqual(plain(queryFromRows(rowsFromQuery(parse("")))), { and: [] });
});

test("single fields land in their rows", () => {
  const rows = rowsOf('from:matt to:anna subject:"big news" in:Inbox tag:work hello "exact phrase"');
  assert.deepEqual(rows.from, [chip("matt")]);
  assert.deepEqual(rows.to, [chip("anna")]);
  assert.deepEqual(rows.subject, [chip("big news", { phrase: true })]);
  assert.deepEqual(rows.folder, [chip("Inbox")]);
  assert.deepEqual(rows.tags, [chip("work")]);
  assert.deepEqual(rows.body, [chip("hello"), chip("exact phrase", { phrase: true })]);
});

test("negated terms keep their sign", () => {
  const rows = rowsOf("-from:matt -tag:work -spam");
  assert.deepEqual(rows.from, [chip("matt", { negated: true })]);
  assert.deepEqual(rows.tags, [chip("work", { negated: true })]);
  assert.deepEqual(rows.body, [chip("spam", { negated: true })]);
});

test("OR within one field marks the following chip", () => {
  const rows = rowsOf("from:matt OR from:danny");
  assert.deepEqual(rows.from, [chip("matt"), chip("danny", { orBefore: true })]);
  assert.deepEqual(rows.kept, []);
});

test("an OR group within one field shows as or between its chips", () => {
  const rows = rowsOf("von:alice OR von:bob rechnung ist:ungelesen");
  assert.deepEqual(rows.from, [chip("alice"), chip("bob", { orBefore: true })]);
  assert.deepEqual(rows.body, [chip("rechnung")]);
  assert.equal(rows.unread, "yes");
  assert.deepEqual(rows.kept, []);
});

test("chips of different groups in one row are not joined by or", () => {
  const rows = rowsOf("from:a from:b OR from:c from:d");
  assert.deepEqual(rows.from, [chip("a"), chip("b"), chip("c", { orBefore: true }), chip("d")]);
});

test("flags become tri-state", () => {
  const rows = rowsOf("has:attachment -is:unread is:flagged");
  assert.equal(rows.attachment, "yes");
  assert.equal(rows.unread, "no");
  assert.equal(rows.flagged, "yes");
  assert.equal(rowsOf("x").unread, "any");
});

test("dates become chips, invalid dates keep their raw text", () => {
  const rows = rowsOf("after:1.10.2026 before:2026-13-45");
  assert.deepEqual(rows.after, chip("2026-10-01"));
  assert.deepEqual(rows.before, chip(null, { raw: "2026-13-45", error: "date" }));
});

const keptText = (text) => rowsOf(text).kept.map((group) => print({ and: [group] }, "en"));

test("an OR group across fields is kept as it is, outside the rows", () => {
  assert.deepEqual(keptText("from:matt OR subject:x"), ["from:matt OR subject:x"]);
  assert.deepEqual(keptText("from:matt a OR from:danny"), ["a OR from:danny"]);
  assert.deepEqual(keptText("is:unread OR is:unread"), ["is:unread OR is:unread"]);
  assert.deepEqual(keptText("after:2026-01-01 OR after:2026-02-01"), ["after:2026-01-01 OR after:2026-02-01"]);
  const rows = rowsOf("from:matt OR subject:x");
  assert.deepEqual([rows.from, rows.subject], [[], []]);
});

test("terms outside a kept OR group are shown as they are", () => {
  const rows = rowsOf("from:a OR subject:b rechnung is:unread");
  assert.deepEqual(keptText("from:a OR subject:b rechnung is:unread"), ["from:a OR subject:b"]);
  assert.deepEqual(rows.from, []);
  assert.deepEqual(rows.subject, []);
  assert.deepEqual(rows.body, [chip("rechnung")]);
  assert.equal(rows.unread, "yes");
});

test("an OR group within one field keeps its or next to a kept group", () => {
  const rows = rowsOf("from:a OR subject:b from:c OR from:d");
  assert.deepEqual(rows.from, [chip("c"), chip("d", { orBefore: true })]);
  assert.equal(rows.kept.length, 1);
});

test("flags and dates of a kept group are not shown as applying to all results", () => {
  const flags = rowsOf("from:a OR is:unread OR -has:attachment is:flagged");
  assert.equal(flags.unread, "any");
  assert.equal(flags.attachment, "any");
  assert.equal(flags.flagged, "yes");
  const dates = rowsOf("from:a OR after:2026-01-01 before:2026-02-01");
  assert.equal(dates.after, null);
  assert.deepEqual(dates.before, chip("2026-02-01"));
});

// Rows edited by `edit`, then written back as text.
function edited(text, edit) {
  const rows = rowsFromQuery(parse(text));
  edit(rows);
  return print(queryFromRows(rows), "en");
}

test("editing other rows keeps a kept group intact", () => {
  assert.equal(edited("after:2024-01-01 OR from:a", (rows) => rows.to.push(chip("z"))), "to:z after:2024-01-01 OR from:a");
  assert.equal(edited("has:attachment OR is:unread", (rows) => (rows.flagged = "yes")), "is:flagged has:attachment OR is:unread");
  assert.equal(edited("from:a OR subject:b c", (rows) => rows.body.push(chip("d"))), "c d from:a OR subject:b");
});

test("a query with kept groups means the same after the rows", () => {
  const groups = (query) => plain(query).and.map((group) => JSON.stringify(group)).sort();
  for (const text of [
    "from:a OR subject:b c", "has:attachment OR is:unread", "after:2024-01-01 OR from:a",
    "from:a OR subject:b from:c OR from:d is:flagged", "-is:unread OR -has:attachment OR tag:x",
  ]) {
    assert.deepEqual(groups(queryFromRows(rowsFromQuery(parse(text)))), groups(parse(text)), text);
  }
});

test("round trip for every query without cross-field OR", () => {
  for (const text of [
    "", "from:matt", "-from:matt", "to:anna subject:report", "hello world", '"exact phrase" -spam',
    "from:matt OR from:danny", "from:matt from:danny OR from:eve", "tag:a tag:b -tag:c",
    "has:attachment is:unread is:flagged", "-has:attachment -is:unread -is:flagged",
    "after:2026-01-02 before:2026-03-04", "-after:2026-01-02", "after:nope before:1.2.2026",
    "in:Inbox in:Archive", 'in:"My Folder"', "from:a to:b subject:c hello in:d tag:e after:2026-01-01 is:flagged",
    "body1 OR body2 OR body3", "von:alice OR von:bob rechnung ist:ungelesen",
    "from:a OR from:b subject:c OR subject:d", "a OR b c", "in:A OR in:B", "-from:a OR from:b from:c",
  ]) roundTrip(text);
});

test("rows are ANDed, the or chips of a row form one group", () => {
  const rows = rowsFromQuery(parse("from:a OR from:b"));
  rows.subject = [plain(chip("x"))];
  const query = plain(queryFromRows(rows));
  assert.deepEqual(query.and.map((group) => group.map((leaf) => `${leaf.field}:${leaf.value}`)),
    [["from:a", "from:b"], ["subject:x"]]);
});

test("a leading or in a row starts no empty group", () => {
  const rows = rowsFromQuery(parse(""));
  rows.from = [plain(chip("a", { orBefore: true })), plain(chip("b", { orBefore: true }))];
  assert.deepEqual(plain(queryFromRows(rows)).and.map((group) => group.map((leaf) => leaf.value)), [["a", "b"]]);
});

test("hasCriteria counts rows and kept groups", () => {
  assert.equal(hasCriteria(rowsOf("")), false);
  assert.equal(hasCriteria(rowsOf("in:Inbox")), true);
  assert.equal(hasCriteria(rowsOf("-is:unread")), true);
  assert.equal(hasCriteria(rowsOf("before:2026-01-01")), true);
  assert.equal(hasCriteria(rowsOf("is:unread OR has:attachment")), true);
});
