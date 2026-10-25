// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolSearchTerms = (() => {
  const TEXT_TERMS = {
    from: "Sender",
    to: "ToOrCC",
    subject: "Subject",
    body: "Body",
    tag: "Keywords",
  };
  const DATE_OPS = { after: "IsAfter", before: "IsBefore" };
  const FLAG_TERMS = {
    unread: { op: "Isnt", value: "Read" },
    flagged: { op: "Is", value: "Marked" },
    attachment: { op: "Is", value: "Attachment" },
  };
  // Folders "all" leaves out unless the search starts in one of the same kind.
  const OPT_IN_KINDS = new Set(["trash", "junk"]);
  const SKIPPED_KINDS = new Set(["virtual", "news", "feed"]);

  // Always the positive form: negation is applied to the result sets.
  function sessionTerm(leaf) {
    if (leaf.error) return null;
    if (TEXT_TERMS[leaf.field]) return { attrib: TEXT_TERMS[leaf.field], op: "Contains", value: leaf.value };
    if (DATE_OPS[leaf.field]) return { attrib: "Date", op: DATE_OPS[leaf.field], value: leaf.value };
    const flag = FLAG_TERMS[leaf.field];
    if (flag) return { attrib: "MsgStatus", op: flag.op, value: flag.value };
    return null;
  }

  // Gloda matches whole tokens; a trailing star turns each word into a prefix match.
  function glodaTerms(leaf) {
    if (leaf.field !== "body" || typeof leaf.value !== "string") return null;
    return leaf.value.split(/\s+/).filter(Boolean).map((word) => word + "*");
  }

  function withDescendants(folders, uris) {
    const result = new Set(uris);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of folders) {
        if (!result.has(folder.uri) && folder.parent !== null && result.has(folder.parent)) {
          result.add(folder.uri);
          grew = true;
        }
      }
    }
    return result;
  }

  function scopeFolders(folders, opts) {
    const known = new Set(folders.map((folder) => folder.uri));
    let selected;
    if (opts.chosen.length) {
      selected = withDescendants(folders, opts.chosen.filter((uri) => known.has(uri)));
    } else if (opts.scope === "folder") {
      selected = new Set(known.has(opts.current) ? [opts.current] : []);
    } else {
      const current = folders.find((folder) => folder.uri === opts.current);
      const allowed = current && OPT_IN_KINDS.has(current.kind) ? current.kind : null;
      const blocked = withDescendants(
        folders,
        folders
          .filter((folder) => SKIPPED_KINDS.has(folder.kind) || (OPT_IN_KINDS.has(folder.kind) && folder.kind !== allowed))
          .map((folder) => folder.uri)
      );
      selected = new Set(folders.filter((folder) => !blocked.has(folder.uri)).map((folder) => folder.uri));
    }
    for (const uri of withDescendants(folders, opts.excluded)) selected.delete(uri);
    return [...selected];
  }

  // Folder name first; the "account/name" path only when no name matches.
  function matchFolders(folders, name) {
    const wanted = String(name).trim().toLowerCase();
    if (!wanted) return [];
    const byName = folders.filter((folder) => folder.name.toLowerCase() === wanted);
    const matches = byName.length
      ? byName
      : folders.filter((folder) => (folder.account + "/" + folder.name).toLowerCase() === wanted);
    return matches.map((folder) => folder.uri);
  }

  // Thunderbird's default names of its default tags, in English and German: a query
  // written in one UI language still finds them in the other.
  const DEFAULT_TAG_NAMES = {
    $label1: ["important", "wichtig"],
    $label2: ["work", "dienstlich"],
    $label3: ["personal", "persönlich"],
    $label4: ["to do", "zu erledigen"],
    $label5: ["later", "später"],
  };

  // Tag name -> keys of the tags ({ key, tag }) it names, case-insensitively: the current
  // name first, then the key, then a default name.
  function matchTags(tags, name) {
    const wanted = String(name).trim().toLowerCase();
    if (!wanted) return [];
    for (const named of [
      (tag) => tag.tag.toLowerCase() === wanted,
      (tag) => tag.key.toLowerCase() === wanted,
      (tag) => Object.hasOwn(DEFAULT_TAG_NAMES, tag.key) && DEFAULT_TAG_NAMES[tag.key].includes(wanted),
    ]) {
      const matches = tags.filter(named);
      if (matches.length) return matches.map((tag) => tag.key);
    }
    return [];
  }

  return { sessionTerm, glodaTerms, scopeFolders, matchFolders, matchTags };
})();
