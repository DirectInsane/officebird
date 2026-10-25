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

  // leafSets: leafKey -> ids matching that leaf (a missing key counts as empty).
  function evaluate(query, leafSets, universe) {
    const result = new Set();
    for (const conjunction of query.or) {
      let acc = null;
      for (const leaf of conjunction.filter(isCombinable)) {
        const hits = leafSets.get(leafKey(leaf)) || new Set();
        const matching = leaf.negated ? [...universe].filter((id) => !hits.has(id)) : [...hits];
        acc = acc === null ? new Set(matching) : new Set(matching.filter((id) => acc.has(id)));
      }
      for (const id of acc === null ? universe : acc) result.add(id);
    }
    return result;
  }

  return { leafKey, evaluate };
})();
