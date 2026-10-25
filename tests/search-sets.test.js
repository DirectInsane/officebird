import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/search/sets.js", import.meta.url), "utf8"), context);
const { leafKey, evaluate, needsUniverse } = context.qolSearchSets;

const leaf = (field, value, negated = false) => ({ field, value, negated, phrase: false });
// Each argument is an OR group; the groups are ANDed.
const query = (...groups) => ({ and: groups });
const sets = (obj) => new Map(Object.entries(obj).map(([key, ids]) => [key, new Set(ids)]));
const ids = (set) => [...set].sort();
const universe = new Set(["1", "2", "3", "4", "5"]);
const A = leaf("from", "a");
const B = leaf("subject", "b");
const C = leaf("tag", "c");
const leafSets = sets({
  [leafKey(A)]: ["1", "2", "3"],
  [leafKey(B)]: ["2", "3", "4"],
  [leafKey(C)]: ["5"],
});

test("leafKey joins field and value with NUL and ignores negation", () => {
  assert.equal(leafKey(leaf("from", "x")), "from\u0000x");
  assert.equal(leafKey(leaf("from", "x", true)), "from\u0000x");
});

test("AND intersects the groups", () => {
  assert.deepEqual(ids(evaluate(query([A], [B]), leafSets, universe)), ["2", "3"]);
});

test("OR unions within a group", () => {
  assert.deepEqual(ids(evaluate(query([A, C]), leafSets, universe)), ["1", "2", "3", "5"]);
});

test("NOT is the universe minus the set", () => {
  assert.deepEqual(ids(evaluate(query([leaf("from", "a", true)]), leafSets, universe)), ["4", "5"]);
});

test("c OR a b reads as (c OR a) AND b", () => {
  assert.deepEqual(ids(evaluate(query([C, A], [B]), leafSets, universe)), ["2", "3"]);
});

test("positive and negated leaves combine", () => {
  assert.deepEqual(ids(evaluate(query([A], [leaf("subject", "b", true)]), leafSets, universe)), ["1"]);
});

test("a negated leaf inside an OR group", () => {
  assert.deepEqual(ids(evaluate(query([leaf("from", "a", true), C]), leafSets, universe)), ["4", "5"]);
  assert.deepEqual(ids(evaluate(query([leaf("from", "a", true), C], [B]), leafSets, universe)), ["4"]);
  assert.deepEqual(ids(evaluate(query([leaf("tag", "c", true), A]), leafSets, universe)), ["1", "2", "3", "4"]);
});

test("a missing leaf set counts as empty", () => {
  assert.deepEqual(ids(evaluate(query([A], [leaf("from", "zz")]), leafSets, universe)), []);
  assert.deepEqual(ids(evaluate(query([A, leaf("from", "zz")]), leafSets, universe)), ["1", "2", "3"]);
  assert.deepEqual(ids(evaluate(query([leaf("from", "zz", true)]), leafSets, universe)), ids(universe));
});

test("an empty query matches nothing", () => {
  assert.deepEqual(ids(evaluate(query(), leafSets, universe)), []);
});

test("error leaves and in: leaves are skipped", () => {
  const bad = { field: "after", value: null, raw: "x", error: "date", negated: false, phrase: false };
  assert.deepEqual(ids(evaluate(query([A], [bad], [leaf("in", "Inbox")]), leafSets, universe)), ["1", "2", "3"]);
  assert.deepEqual(ids(evaluate(query([A, bad, leaf("in", "Inbox")]), leafSets, universe)), ["1", "2", "3"]);
});

test("a query with no remaining leaves matches the universe", () => {
  assert.deepEqual(ids(evaluate(query([leaf("in", "Inbox")]), leafSets, universe)), ids(universe));
});

test("a group with no remaining leaves does not need the universe", () => {
  // The engine enumerates the universe only when a query needs it.
  assert.deepEqual(ids(evaluate(query([leaf("in", "Inbox")], [A]), leafSets, new Set())), ["1", "2", "3"]);
});

test("evaluating again after a leaf set grew adds the new ids", () => {
  const live = sets({ [leafKey(A)]: ["1"] });
  assert.deepEqual(ids(evaluate(query([A]), live, universe)), ["1"]);
  live.get(leafKey(A)).add("4");
  assert.deepEqual(ids(evaluate(query([A]), live, universe)), ["1", "4"]);
});

test("the universe is needed for a negated leaf or a query without set leaves", () => {
  assert.equal(needsUniverse(query([A], [B, C])), false);
  assert.equal(needsUniverse(query([A, leaf("tag", "c", true)])), true);
  assert.equal(needsUniverse(query([leaf("in", "Inbox")])), true);
  assert.equal(needsUniverse(query([leaf("in", "Inbox")], [A])), false);
  assert.equal(needsUniverse(query([leaf("in", "Inbox", true)], [A])), false);
  assert.equal(needsUniverse(query()), false);
});
