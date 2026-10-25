import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
for (const file of ["query.js", "panelmodel.js"]) {
  vm.runInNewContext(readFileSync(new URL(`../experiments/search/${file}`, import.meta.url), "utf8"), context);
}
const { parse } = context.qolSearchQuery;
const { rowsFromQuery, queryFromRows } = context.qolSearchPanelModel;

const plain = (value) => JSON.parse(JSON.stringify(value));
const rowsOf = (text) => plain(rowsFromQuery(parse(text)));
const chip = (value, extra = {}) => ({ value, negated: false, phrase: false, orBefore: false, ...extra });

function roundTrip(text) {
  const query = plain(parse(text));
  const rows = rowsFromQuery(query);
  assert.deepEqual(plain(rows.crossOr), [], text);
  assert.deepEqual(plain(queryFromRows(rows)), query, text);
}

test("an empty query gives empty rows and back", () => {
  const rows = rowsOf("");
  assert.deepEqual(rows, {
    from: [], to: [], subject: [], body: [], folder: [], tags: [],
    after: null, before: null, attachment: "any", unread: "any", flagged: "any", crossOr: [],
  });
  assert.deepEqual(plain(queryFromRows(rowsFromQuery(parse("")))), { or: [] });
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
  assert.deepEqual(rows.crossOr, []);
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

test("OR across different fields is reported in crossOr", () => {
  assert.deepEqual(rowsOf("from:matt OR subject:x").crossOr, ["from", "subject"]);
  assert.deepEqual(rowsOf("from:matt a OR from:danny").crossOr, ["from", "body"]);
  assert.deepEqual(rowsOf("is:unread OR is:unread").crossOr, ["unread"]);
});

test("round trip for every query without cross-field OR", () => {
  for (const text of [
    "", "from:matt", "-from:matt", "to:anna subject:report", "hello world", '"exact phrase" -spam',
    "from:matt OR from:danny", "from:matt from:danny OR from:eve", "tag:a tag:b -tag:c",
    "has:attachment is:unread is:flagged", "-has:attachment -is:unread -is:flagged",
    "after:2026-01-02 before:2026-03-04", "-after:2026-01-02", "after:nope before:1.2.2026",
    "in:Inbox in:Archive", 'in:"My Folder"', "from:a to:b subject:c hello in:d tag:e after:2026-01-01 is:flagged",
    "body1 OR body2 OR body3",
  ]) roundTrip(text);
});

test("rows with OR chips in several fields expand to every combination", () => {
  const rows = rowsFromQuery(parse("from:a OR from:b"));
  rows.subject = [plain(chip("x"))];
  const query = plain(queryFromRows(rows));
  assert.deepEqual(query.or.map((group) => group.map((leaf) => `${leaf.field}:${leaf.value}`)),
    [["from:a", "subject:x"], ["from:b", "subject:x"]]);
});

test("a cross-field OR still produces all its leaves", () => {
  const query = plain(queryFromRows(rowsFromQuery(parse("from:matt OR subject:x"))));
  assert.deepEqual(query.or.flat().map((leaf) => leaf.field).sort(), ["from", "subject"]);
});
