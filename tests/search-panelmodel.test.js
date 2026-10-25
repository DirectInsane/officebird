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
  assert.deepEqual(rows.crossOr, []);
});

test("an OR group within one field shows as or between its chips", () => {
  const rows = rowsOf("von:alice OR von:bob rechnung ist:ungelesen");
  assert.deepEqual(rows.from, [chip("alice"), chip("bob", { orBefore: true })]);
  assert.deepEqual(rows.body, [chip("rechnung")]);
  assert.equal(rows.unread, "yes");
  assert.deepEqual(rows.crossOr, []);
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

test("OR across different fields is reported in crossOr", () => {
  assert.deepEqual(rowsOf("from:matt OR subject:x").crossOr, ["from", "subject"]);
  assert.deepEqual(rowsOf("from:matt a OR from:danny").crossOr, ["from", "body"]);
  assert.deepEqual(rowsOf("is:unread OR is:unread").crossOr, ["unread"]);
  assert.deepEqual(rowsOf("after:2026-01-01 OR after:2026-02-01").crossOr, ["after"]);
});

test("terms outside a cross-field OR group are shown as they are", () => {
  const rows = rowsOf("from:a OR subject:b rechnung is:unread");
  assert.deepEqual(rows.crossOr, ["from", "subject"]);
  assert.deepEqual(rows.from, [chip("a")]);
  assert.deepEqual(rows.subject, [chip("b")]);
  assert.deepEqual(rows.body, [chip("rechnung")]);
  assert.equal(rows.unread, "yes");
});

test("an OR group within one field keeps its or next to a cross-field group", () => {
  const rows = rowsOf("from:a OR subject:b from:c OR from:d");
  assert.deepEqual(rows.crossOr, ["from", "subject"]);
  assert.deepEqual(rows.from, [chip("a"), chip("c"), chip("d", { orBefore: true })]);
});

test("flags and dates in a cross-field OR group are not shown as applying to all results", () => {
  const flags = rowsOf("from:a OR is:unread OR -has:attachment is:flagged");
  assert.deepEqual(flags.crossOr, ["from", "attachment", "unread"]);
  assert.equal(flags.unread, "any");
  assert.equal(flags.attachment, "any");
  assert.equal(flags.flagged, "yes");
  const dates = rowsOf("from:a OR after:2026-01-01 before:2026-02-01");
  assert.deepEqual(dates.crossOr, ["from", "after"]);
  assert.equal(dates.after, null);
  assert.deepEqual(dates.before, chip("2026-02-01"));
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

test("a cross-field OR still produces all its leaves", () => {
  const query = plain(queryFromRows(rowsFromQuery(parse("from:matt OR subject:x"))));
  assert.deepEqual(query.and.flat().map((leaf) => leaf.field).sort(), ["from", "subject"]);
});
