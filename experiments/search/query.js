// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolSearchQuery = (() => {
  // Keyword (either language, lower case) -> field. The first keyword listed per
  // field and language is the one print() writes.
  const VALUE_KEYWORDS = {
    from: "from", von: "from",
    to: "to", an: "to",
    subject: "subject", betreff: "subject",
    in: "in",
    tag: "tag", schlagwort: "tag",
    after: "after", nach: "after",
    before: "before", vor: "before",
  };
  // "has:"/"is:" value (either language) -> flag field.
  const FLAG_KEYWORDS = {
    has: { attachment: "attachment", anhang: "attachment" },
    hat: { attachment: "attachment", anhang: "attachment" },
    is: { unread: "unread", ungelesen: "unread", flagged: "flagged", markiert: "flagged" },
    ist: { unread: "unread", ungelesen: "unread", flagged: "flagged", markiert: "flagged" },
  };
  const PRINT = {
    en: {
      or: "OR", from: "from", to: "to", subject: "subject", in: "in", tag: "tag",
      after: "after", before: "before", attachment: "has:attachment",
      unread: "is:unread", flagged: "is:flagged",
    },
    de: {
      or: "ODER", from: "von", to: "an", subject: "betreff", in: "in", tag: "schlagwort",
      after: "nach", before: "vor", attachment: "hat:anhang",
      unread: "ist:ungelesen", flagged: "ist:markiert",
    },
  };
  const DATE_FIELDS = new Set(["after", "before"]);
  const FLAG_FIELDS = new Set(["attachment", "unread", "flagged"]);

  // Splits into { text, quoted, negated }. A quote right after a colon opens the
  // value of a keyword ('in:"My Folder"'); elsewhere inside a word it is a plain character.
  function tokenize(text) {
    const tokens = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (/\s/.test(text[i])) { i++; continue; }
      let negated = false;
      if (text[i] === "-" && i + 1 < n && !/\s/.test(text[i + 1])) { negated = true; i++; }
      if (text[i] === '"') {
        const end = text.indexOf('"', i + 1);
        const stop = end < 0 ? n : end;
        tokens.push({ text: text.slice(i + 1, stop), quoted: true, prefix: "", negated });
        i = stop + 1;
        continue;
      }
      let word = "";
      let quotedValue = null;
      while (i < n && !/\s/.test(text[i])) {
        if (text[i] === '"' && word.endsWith(":")) {
          const end = text.indexOf('"', i + 1);
          const stop = end < 0 ? n : end;
          quotedValue = text.slice(i + 1, stop);
          i = stop + 1;
          break;
        }
        word += text[i++];
      }
      if (quotedValue !== null) tokens.push({ text: quotedValue, quoted: true, prefix: word, negated });
      else tokens.push({ text: word, quoted: false, prefix: "", negated });
    }
    return tokens;
  }

  // "YYYY-MM-DD" or "D.M.YYYY" -> "YYYY-MM-DD", or null for anything else or an impossible date.
  function normalizeDate(text) {
    let y, m, d;
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (match) [, y, m, d] = match;
    else if ((match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text))) [, d, m, y] = match;
    else return null;
    y = Number(y); m = Number(m); d = Number(d);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function leafFromToken(token) {
    const { negated } = token;
    if (token.quoted && !token.prefix) {
      return token.text ? { field: "body", value: token.text, negated, phrase: true } : null;
    }
    const colon = token.quoted ? token.prefix.length - 1 : token.text.indexOf(":");
    if (colon > 0) {
      const keyword = (token.quoted ? token.prefix : token.text).slice(0, colon).toLowerCase();
      const value = token.quoted ? token.text : token.text.slice(colon + 1);
      if (Object.hasOwn(FLAG_KEYWORDS, keyword) && !token.quoted) {
        const field = FLAG_KEYWORDS[keyword][value.toLowerCase()];
        if (field) return { field, value: true, negated, phrase: false };
      } else if (Object.hasOwn(VALUE_KEYWORDS, keyword) && value) {
        const field = VALUE_KEYWORDS[keyword];
        if (DATE_FIELDS.has(field)) {
          const date = normalizeDate(value);
          if (date) return { field, value: date, negated, phrase: false };
          return { field, value: null, raw: value, negated, phrase: false, error: "date" };
        }
        return { field, value, negated, phrase: token.quoted };
      } else if (token.quoted && !value) {
        return null;
      }
    }
    return { field: "body", value: token.quoted ? token.prefix + token.text : token.text, negated, phrase: false };
  }

  function parse(text) {
    const or = [];
    let group = [];
    const flush = () => { if (group.length) or.push(group); group = []; };
    for (const token of tokenize(String(text ?? ""))) {
      if (!token.quoted && !token.negated && (token.text === "OR" || token.text === "ODER")) {
        flush();
        continue;
      }
      const leaf = leafFromToken(token);
      if (leaf) group.push(leaf);
    }
    flush();
    return { or };
  }

  function quote(value) {
    return `"${value}"`;
  }

  function printLeaf(leaf, words) {
    const sign = leaf.negated ? "-" : "";
    if (FLAG_FIELDS.has(leaf.field)) return sign + words[leaf.field];
    const value = leaf.error === "date" ? leaf.raw : leaf.value;
    const shown = leaf.phrase || /\s/.test(value) || value === "" ? quote(value) : value;
    if (leaf.field === "body") return sign + shown;
    return `${sign}${words[leaf.field]}:${shown}`;
  }

  function print(query, lang) {
    const words = PRINT[lang] || PRINT.en;
    return query.or.map((group) => group.map((leaf) => printLeaf(leaf, words)).join(" ")).join(` ${words.or} `);
  }

  return { parse, print };
})();
