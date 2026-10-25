// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolSearchPanelModel = (() => {
  // Query field -> rows key, in the order queryFromRows writes the groups.
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

  // An OR group the rows can show holds chips of a single field: they read as one row,
  // with orBefore joining a chip to the one before it. Any other OR group (across
  // fields, or of flags or dates) is kept as it is in `kept`, outside the rows, so
  // editing the rows leaves it untouched.
  function isKeptGroup(group) {
    return group.length > 1 && !(Object.hasOwn(CHIP_ROWS, group[0].field) && group.every((leaf) => leaf.field === group[0].field));
  }

  function rowsFromQuery(query) {
    const rows = {
      from: [], to: [], subject: [], body: [], folder: [], tags: [],
      after: null, before: null, attachment: "any", unread: "any", flagged: "any", kept: [],
    };
    for (const group of query.and) {
      if (isKeptGroup(group)) {
        rows.kept.push(group.map((leaf) => ({ ...leaf })));
        continue;
      }
      group.forEach((leaf, index) => {
        if (Object.hasOwn(CHIP_ROWS, leaf.field)) {
          rows[CHIP_ROWS[leaf.field]].push(chipFromLeaf(leaf, index > 0));
        } else if (Object.hasOwn(DATE_ROWS, leaf.field)) {
          rows[DATE_ROWS[leaf.field]] = chipFromLeaf(leaf, false);
        } else if (Object.hasOwn(FLAG_ROWS, leaf.field)) {
          rows[FLAG_ROWS[leaf.field]] = leaf.negated ? "no" : "yes";
        }
      });
    }
    return rows;
  }

  function hasCriteria(rows) {
    return (
      Object.values(CHIP_ROWS).some((key) => rows[key].length) ||
      Object.values(DATE_ROWS).some((key) => rows[key]) ||
      Object.values(FLAG_ROWS).some((key) => rows[key] !== "any") ||
      rows.kept.length > 0
    );
  }

  // The OR groups of one chip row: orBefore joins a chip to the group before it.
  function groupsOf(field, chips) {
    const groups = [];
    for (const chip of chips) {
      if (!chip.orBefore || !groups.length) groups.push([]);
      groups[groups.length - 1].push(leafFromChip(field, chip));
    }
    return groups;
  }

  // Rows are ANDed, and so are the groups within a row; kept groups follow unchanged.
  function queryFromRows(rows) {
    const and = [];
    for (const field of FIELD_ORDER) {
      if (Object.hasOwn(CHIP_ROWS, field)) {
        and.push(...groupsOf(field, rows[CHIP_ROWS[field]]));
      } else if (Object.hasOwn(DATE_ROWS, field)) {
        const chip = rows[DATE_ROWS[field]];
        if (chip) and.push([leafFromChip(field, chip)]);
      } else {
        const state = rows[FLAG_ROWS[field]];
        if (state === "yes" || state === "no") {
          and.push([{ field, value: true, negated: state === "no", phrase: false }]);
        }
      }
    }
    for (const group of rows.kept) and.push(group.map((leaf) => ({ ...leaf })));
    return { and };
  }

  return { rowsFromQuery, queryFromRows, hasCriteria };
})();
