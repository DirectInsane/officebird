// Classic script, not a module: the experiment loads it into a sandbox, the tests with vm.
"use strict";

var qolSearchLabels = (() => {
  const en = {
    placeholder: "Search mail",
    clearField: "Clear search",
    filters: "Filters",
    from: "From",
    to: "To",
    subject: "Subject",
    contains: "Contains",
    date: "Date",
    dateFrom: "from",
    dateBefore: "before",
    folder: "Folder",
    tags: "Tags",
    attachments: "Attachments",
    unread: "Unread",
    flagged: "Flagged",
    thisFolder: "This folder",
    allMailboxes: "All mailboxes",
    clear: "Clear",
    search: "Search",
    results: "Search results",
    stillSearching: "Still searching…",
    noResults: "No mails found",
    searchAll: "Search all mailboxes",
    tip: "Click a term to exclude it · type OR between terms",
    chipExclude: "Click to exclude",
    chipInclude: "Click to include",
    or: "or",
    anyOf: "Any of",
    glodaOff: "Full-text index is off: body search is slower and misses some encoded mails.",
    turnOn: "Turn on",
    glodaRestart: "Restart Thunderbird to build the full-text index.",
    closeNotice: "Close",
    glodaIndexing: "Full-text index is still being built ({percent} %): body search may miss some mails.",
    offline: "Server not reachable: folders searched only locally: {count}",
    badDate: "Unknown date",
    unknownFolder: "No folder named {name}",
    phName: "name or address",
    phWords: "words or \"exact phrase\"",
    phFolder: "any folder",
  };

  const de = {
    placeholder: "E-Mails durchsuchen",
    clearField: "Suche löschen",
    filters: "Filter",
    from: "Von",
    to: "An",
    subject: "Betreff",
    contains: "Enthält",
    date: "Datum",
    dateFrom: "ab",
    dateBefore: "vor",
    folder: "Ordner",
    tags: "Schlagwörter",
    attachments: "Anhänge",
    unread: "Ungelesen",
    flagged: "Markiert",
    thisFolder: "Dieser Ordner",
    allMailboxes: "Alle Postfächer",
    clear: "Zurücksetzen",
    search: "Suchen",
    results: "Suchergebnisse",
    stillSearching: "Suche läuft…",
    noResults: "Keine E-Mails gefunden",
    searchAll: "Alle Postfächer durchsuchen",
    tip: "Begriff anklicken zum Ausschließen · ODER zwischen Begriffen verwenden",
    chipExclude: "Klicken zum Ausschließen",
    chipInclude: "Klicken zum Einschließen",
    or: "oder",
    anyOf: "Eins von",
    glodaOff: "Der Volltextindex ist deaktiviert: Die Suche im Nachrichtentext ist langsamer und übersieht einige kodierte E-Mails.",
    turnOn: "Einschalten",
    glodaRestart: "Starte Thunderbird neu, um den Volltextindex aufzubauen.",
    closeNotice: "Schließen",
    glodaIndexing: "Der Volltextindex wird noch aufgebaut ({percent} %): Die Suche im Nachrichtentext findet evtl. nicht alle E-Mails.",
    offline: "Server nicht erreichbar: nur lokal durchsuchte Ordner: {count}",
    badDate: "Unbekanntes Datum",
    unknownFolder: "Kein Ordner mit dem Namen {name}",
    phName: "Name oder Adresse",
    phWords: "Wörter oder \"genaue Wortfolge\"",
    phFolder: "beliebiger Ordner",
  };

  const STRINGS = { en, de };

  function pickLanguage(locale) {
    return /^de(?:$|[-_])/i.test(String(locale || "")) ? "de" : "en";
  }

  function label(lang, key, vars) {
    const text = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
  }

  return { STRINGS, pickLanguage, label };
})();
