import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/search/sets.js", import.meta.url), "utf8"), context);
const { leafKey, evaluate } = context.qolSearchSets;

const leaf = (field, value, negated = false) => ({ field, value, negated, phrase: false });
const query = (...conjunctions) => ({ or: conjunctions });
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

test("AND intersects", () => {
  assert.deepEqual(ids(evaluate(query([A, B]), leafSets, universe)), ["2", "3"]);
});

test("OR unions", () => {
  assert.deepEqual(ids(evaluate(query([A], [C]), leafSets, universe)), ["1", "2", "3", "5"]);
});

test("NOT is the universe minus the set", () => {
  assert.deepEqual(ids(evaluate(query([leaf("from", "a", true)]), leafSets, universe)), ["4", "5"]);
});

test("a b OR c reads as (a b) OR c", () => {
  assert.deepEqual(ids(evaluate(query([A, B], [C]), leafSets, universe)), ["2", "3", "5"]);
});

test("positive and negated leaves combine", () => {
  assert.deepEqual(ids(evaluate(query([A, leaf("subject", "b", true)]), leafSets, universe)), ["1"]);
});

test("a missing leaf set counts as empty", () => {
  assert.deepEqual(ids(evaluate(query([A, leaf("from", "zz")]), leafSets, universe)), []);
  assert.deepEqual(ids(evaluate(query([leaf("from", "zz", true)]), leafSets, universe)), ids(universe));
});

test("an empty query matches nothing", () => {
  assert.deepEqual(ids(evaluate(query(), leafSets, universe)), []);
});

test("error leaves and in: leaves are skipped", () => {
  const bad = { field: "after", value: null, raw: "x", error: "date", negated: false, phrase: false };
  assert.deepEqual(ids(evaluate(query([A, bad, leaf("in", "Inbox")]), leafSets, universe)), ["1", "2", "3"]);
});

test("a conjunction with no remaining leaves matches the universe", () => {
  assert.deepEqual(ids(evaluate(query([leaf("in", "Inbox")]), leafSets, universe)), ids(universe));
});

test("evaluating again after a leaf set grew adds the new ids", () => {
  const live = sets({ [leafKey(A)]: ["1"] });
  assert.deepEqual(ids(evaluate(query([A]), live, universe)), ["1"]);
  live.get(leafKey(A)).add("4");
  assert.deepEqual(ids(evaluate(query([A]), live, universe)), ["1", "4"]);
});
