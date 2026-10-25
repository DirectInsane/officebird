// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolSearchPanelModel = (() => {
  // Query field -> rows key, in the order queryFromRows writes the leaves of a conjunction.
  const CHIP_ROWS = { from: "from", to: "to", subject: "subject", body: "body", in: "folder", tag: "tags" };
  const DATE_ROWS = { after: "after", before: "before" };
  const FLAG_ROWS = { attachment: "attachment", unread: "unread", flagged: "flagged" };
  const FIELD_ORDER = ["from", "to", "subject", "body", "in", "tag", "after", "before", "attachment", "unread", "flagged"];

  function chipFromLeaf(leaf, orBefore) {
    const chip = { value: leaf.value, negated: leaf.negated, phrase: leaf.phrase, orBefore };
    if (leaf.error) {
      chip.error = leaf.error;
      chip.raw = leaf.raw;
    }
    return chip;
  }

  function leafFromChip(field, chip) {
    const leaf = { field, value: chip.value, negated: chip.negated, phrase: chip.phrase };
    if (chip.error) {
      leaf.error = chip.error;
      leaf.raw = chip.raw;
    }
    return leaf;
  }

  // An OR the panel can show is one whose conjunctions only hold chips of a single field:
  // the chips then read as one row, with orBefore starting each further alternative.
  function crossFields(groups) {
    if (groups.length < 2) return [];
    const fields = new Set(groups.flat().map((leaf) => leaf.field));
    if (fields.size === 1 && Object.hasOwn(CHIP_ROWS, [...fields][0])) return [];
    return FIELD_ORDER.filter((field) => fields.has(field));
  }

  function rowsFromQuery(query) {
    const rows = {
      from: [], to: [], subject: [], body: [], folder: [], tags: [],
      after: null, before: null, attachment: "any", unread: "any", flagged: "any", crossOr: [],
    };
    const groups = query.or;
    rows.crossOr = crossFields(groups);
    groups.forEach((group) => {
      group.forEach((leaf, index) => {
        if (Object.hasOwn(CHIP_ROWS, leaf.field)) {
          const row = rows[CHIP_ROWS[leaf.field]];
          row.push(chipFromLeaf(leaf, index === 0 && row.length > 0 && !rows.crossOr.length));
        } else if (Object.hasOwn(DATE_ROWS, leaf.field)) {
          rows[DATE_ROWS[leaf.field]] = chipFromLeaf(leaf, false);
        } else if (Object.hasOwn(FLAG_ROWS, leaf.field)) {
          rows[FLAG_ROWS[leaf.field]] = leaf.negated ? "no" : "yes";
        }
      });
    });
    return rows;
  }

  // Alternatives of one chip row: orBefore starts a new conjunction.
  function alternatives(field, chips) {
    const result = [];
    for (const chip of chips) {
      if (chip.orBefore || !result.length) result.push([]);
      result[result.length - 1].push(leafFromChip(field, chip));
    }
    return result;
  }

  // Rows are ANDed across fields; ORs within a row expand to every combination.
  function queryFromRows(rows) {
    let combos = [[]];
    const add = (options) => {
      if (!options.length) return;
      combos = combos.flatMap((combo) => options.map((option) => combo.concat(option)));
    };
    for (const field of FIELD_ORDER) {
      if (Object.hasOwn(CHIP_ROWS, field)) {
        add(alternatives(field, rows[CHIP_ROWS[field]]));
      } else if (Object.hasOwn(DATE_ROWS, field)) {
        const chip = rows[DATE_ROWS[field]];
        if (chip) add([[leafFromChip(field, chip)]]);
      } else {
        const state = rows[FLAG_ROWS[field]];
        if (state === "yes" || state === "no") {
          add([[{ field, value: true, negated: state === "no", phrase: false }]]);
        }
      }
    }
    return { or: combos.filter((combo) => combo.length) };
  }

  return { rowsFromQuery, queryFromRows };
})();
