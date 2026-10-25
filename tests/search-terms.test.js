import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/search/terms.js", import.meta.url), "utf8"), context);
const { sessionTerm, glodaTerms, scopeFolders, matchFolders } = context.qolSearchTerms;

const leaf = (field, value, extra = {}) => ({ field, value, negated: false, phrase: false, ...extra });
const plain = (obj) => (obj === null ? null : { attrib: obj.attrib, op: obj.op, value: obj.value });

test("sessionTerm maps text fields", () => {
  assert.deepEqual(plain(sessionTerm(leaf("from", "ann"))), { attrib: "Sender", op: "Contains", value: "ann" });
  assert.deepEqual(plain(sessionTerm(leaf("to", "bob"))), { attrib: "ToOrCC", op: "Contains", value: "bob" });
  assert.deepEqual(plain(sessionTerm(leaf("subject", "plan"))), { attrib: "Subject", op: "Contains", value: "plan" });
  assert.deepEqual(plain(sessionTerm(leaf("body", "hello"))), { attrib: "Body", op: "Contains", value: "hello" });
  assert.deepEqual(plain(sessionTerm(leaf("tag", "important"))), { attrib: "Keywords", op: "Contains", value: "important" });
});

test("sessionTerm maps dates", () => {
  assert.deepEqual(plain(sessionTerm(leaf("after", "2026-10-01"))), { attrib: "Date", op: "IsAfter", value: "2026-10-01" });
  assert.deepEqual(plain(sessionTerm(leaf("before", "2026-10-01"))), { attrib: "Date", op: "IsBefore", value: "2026-10-01" });
});

test("sessionTerm maps flags to the positive form", () => {
  assert.deepEqual(plain(sessionTerm(leaf("unread", true))), { attrib: "MsgStatus", op: "Isnt", value: "Read" });
  assert.deepEqual(plain(sessionTerm(leaf("flagged", true))), { attrib: "MsgStatus", op: "Is", value: "Marked" });
  assert.deepEqual(plain(sessionTerm(leaf("attachment", true))), { attrib: "MsgStatus", op: "Is", value: "Attachment" });
});

test("sessionTerm ignores negation", () => {
  assert.deepEqual(plain(sessionTerm(leaf("from", "ann", { negated: true }))), { attrib: "Sender", op: "Contains", value: "ann" });
});

test("sessionTerm returns null for in, errors and unknown fields", () => {
  assert.equal(sessionTerm(leaf("in", "Inbox")), null);
  assert.equal(sessionTerm(leaf("after", null, { error: "date" })), null);
  assert.equal(sessionTerm(leaf("nope", "x")), null);
});

test("glodaTerms adds prefix stars for body leaves", () => {
  assert.deepEqual(Array.from(glodaTerms(leaf("body", "rechn"))), ["rechn*"]);
  assert.deepEqual(Array.from(glodaTerms(leaf("body", "exact phrase", { phrase: true }))), ["exact*", "phrase*"]);
  assert.deepEqual(Array.from(glodaTerms(leaf("body", "  two   words "))), ["two*", "words*"]);
});

test("glodaTerms is null for non-body leaves", () => {
  assert.equal(glodaTerms(leaf("subject", "x")), null);
  assert.equal(glodaTerms(leaf("unread", true)), null);
});

const f = (uri, parent, kind, name, account = "acc") => ({ uri, parent, kind, name, account });
const folders = [
  f("a/inbox", null, "inbox", "Inbox", "a"),
  f("a/projects", null, "other", "Projects", "a"),
  f("a/projects/x", "a/projects", "other", "X", "a"),
  f("a/projects/x/deep", "a/projects/x", "other", "Deep", "a"),
  f("a/trash", null, "trash", "Trash", "a"),
  f("a/junk", null, "junk", "Junk", "a"),
  f("a/virtual", null, "virtual", "Unread", "a"),
  f("b/inbox", null, "inbox", "Inbox", "b"),
  f("b/trash", null, "trash", "Trash", "b"),
  f("n/news", null, "news", "group", "n"),
  f("r/feed", null, "feed", "Blog", "r"),
];
const scope = (opts) => Array.from(scopeFolders(folders, { scope: "all", current: "a/inbox", chosen: [], excluded: [], ...opts })).sort();

test("folder scope is the current folder only", () => {
  assert.deepEqual(scope({ scope: "folder" }), ["a/inbox"]);
});

test("all scope skips trash, junk, virtual, news and feed", () => {
  assert.deepEqual(scope({}), ["a/inbox", "a/projects", "a/projects/x", "a/projects/x/deep", "b/inbox"]);
});

test("all scope includes the trash kind when current is trash", () => {
  const got = scope({ current: "a/trash" });
  assert.ok(got.includes("a/trash"));
  assert.ok(!got.includes("a/junk"));
  assert.ok(got.includes("a/inbox"));
});

test("all scope includes junk when current is junk", () => {
  const got = scope({ current: "a/junk" });
  assert.ok(got.includes("a/junk"));
  assert.ok(!got.includes("a/trash"));
});

test("chosen folders replace the scope and bring their descendants", () => {
  assert.deepEqual(scope({ chosen: ["a/projects"] }), ["a/projects", "a/projects/x", "a/projects/x/deep"]);
  assert.deepEqual(scope({ scope: "folder", chosen: ["a/projects/x"] }), ["a/projects/x", "a/projects/x/deep"]);
});

test("chosen may name a trash folder", () => {
  assert.deepEqual(scope({ chosen: ["a/trash"] }), ["a/trash"]);
});

test("excluded folders and their descendants are removed", () => {
  assert.deepEqual(scope({ excluded: ["a/projects"] }), ["a/inbox", "b/inbox"]);
  assert.deepEqual(scope({ scope: "folder", excluded: ["a/inbox"] }), []);
  assert.deepEqual(scope({ chosen: ["a/projects"], excluded: ["a/projects/x"] }), ["a/projects"]);
});

test("matchFolders matches names case-insensitively", () => {
  assert.deepEqual(Array.from(matchFolders(folders, "inbox")).sort(), ["a/inbox", "b/inbox"]);
  assert.deepEqual(Array.from(matchFolders(folders, "PROJECTS")), ["a/projects"]);
});

test("matchFolders falls back to account/name paths", () => {
  assert.deepEqual(Array.from(matchFolders(folders, "b/Inbox")), ["b/inbox"]);
  assert.deepEqual(Array.from(matchFolders(folders, "A/projects")), ["a/projects"]);
});

test("matchFolders returns an empty array without a match", () => {
  assert.deepEqual(Array.from(matchFolders(folders, "nothing")), []);
  assert.deepEqual(Array.from(matchFolders(folders, "")), []);
});
