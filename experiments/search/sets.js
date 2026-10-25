// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolSearchSets = (() => {
  function leafKey(leaf) {
    return leaf.field + "\u0000" + leaf.value;
  }

  // "in:" leaves narrow the scope and error leaves are skipped; neither takes part here.
  function isCombinable(leaf) {
    return !leaf.error && leaf.field !== "in";
  }

  // leafSets: leafKey -> ids matching that leaf (a missing key counts as empty). A group
  // without combinable leaves sets no condition; a query without any matches the universe.
  function evaluate(query, leafSets, universe) {
    let result = null;
    for (const group of query.and) {
      const leaves = group.filter(isCombinable);
      if (!leaves.length) continue;
      const matching = new Set();
      for (const leaf of leaves) {
        const hits = leafSets.get(leafKey(leaf)) || new Set();
        for (const id of leaf.negated ? universe : hits) {
          if (!leaf.negated || !hits.has(id)) matching.add(id);
        }
      }
      result = result === null ? matching : new Set([...matching].filter((id) => result.has(id)));
    }
    if (result === null) return new Set(query.and.length ? universe : []);
    return result;
  }

  // Whether evaluate reads the universe: for a negated leaf, or when no leaf sets a condition.
  function needsUniverse(query) {
    const leaves = query.and.flat().filter(isCombinable);
    return leaves.some((leaf) => leaf.negated) || (query.and.length > 0 && !leaves.length);
  }

  return { leafKey, evaluate, needsUniverse };
})();
