// Search integration suite (test-search.sh); returns { passed, failed: [{ name, error }] }.
// Needs the data from search-setup.js.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
const { AddonManager, AddonManagerPrivate } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");

// Helpers

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    let value;
    try {
      value = fn();
    } catch (e) {
      value = false;
    }
    if (value) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`timed out after ${ms} ms waiting for: ${fn.toString()}`);
    }
    await sleep(25);
  }
}

function assert(cond, msg = "assertion failed") {
  if (!cond) {
    throw new Error(msg);
  }
}

function assertEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`expected ${e}, got ${a}`);
  }
}

const ADDON_ID = "officebird@directinsane.github.io";

const mainWindow = Services.wm.getMostRecentWindow("mail:3pane");
mainWindow.gTabmail.switchToTab(0);

// The add-on's own modules, through the search experiment's controller on the window.
function libs() {
  const lib = mainWindow.qolSearch?.libs;
  assert(lib, "the search experiment is not attached to the main window");
  return lib;
}

let results = null;
let query = null;
let engine = null;
let loadError = null;

function background() {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  return [...ext.views].find(view => view.viewType === "background").xulBrowser.contentWindow.wrappedJSObject;
}

async function storage() {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  return ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext));
}

// Like an options page change: the background passes it on through updateConfig.
async function setSearch(search) {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const db = await storage();
  const { settings = {} } = await db.get(["settings"]);
  const next = { ...settings, search: { ...(settings.search || {}), ...search } };
  const changes = await db.set({ settings: next });
  if (changes) {
    ExtensionStorageIDB.notifyListeners(ext.id, changes);
  }
  if ("enabled" in search) {
    await waitFor(() => Boolean(mainWindow.document.getElementById("qol-search")) === search.enabled, 5000);
  }
}

const win = mainWindow.gTabmail.currentAbout3Pane;

const testRoot = MailServices.accounts.localFoldersServer.rootFolder.getChildNamed("Search Test");
assert(testRoot, "no Search Test folder; run search-setup.js");
const inbox = testRoot.getChildNamed("Inbox");
const archive = testRoot.getChildNamed("Archive");

function hdrs(folder) {
  return [...folder.messages].sort((a, b) => b.date - a.date);
}

function shownKeys() {
  const keys = [];
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    const hdr = win.gDBView.getMsgHdrAt(i);
    keys.push(`${hdr.folder.URI}#${hdr.messageKey}`);
  }
  return keys.sort();
}

function keyOf(hdr) {
  return `${hdr.folder.URI}#${hdr.messageKey}`;
}

async function openFolder(folder) {
  win.displayFolder(folder);
  await waitFor(() => win.gFolder?.URI === folder.URI && win.gDBView && !win.gViewWrapper.isSearch && win.dbViewWrapperListener.allMessagesLoaded);
}

// Collects script errors reported to the console while `fn` runs.
async function consoleErrors(fn) {
  const errors = [];
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIConsoleListener"]),
    observe(message) {
      if (message instanceof Ci.nsIScriptError && !(message.flags & Ci.nsIScriptError.warningFlag)) {
        errors.push(`${message.errorMessage} (${message.sourceName}:${message.lineNumber})`);
      }
    },
  };
  Services.console.registerListener(listener);
  try {
    await fn();
    await sleep(100);
  } finally {
    Services.console.unregisterListener(listener);
  }
  return errors;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// Tests

test("show displays exactly the given hits from two folders", async () => {
  const hits = [...hdrs(inbox).slice(0, 2), hdrs(archive)[0]];
  results.show(win, hits);
  assert(results.isActive(win), "search not active");
  assert(win.gViewWrapper.isSearch, "not a search view");
  assert(!win.gViewWrapper.showGroupedBySort, "results are grouped");
  assertEqual(win.gDBView.rowCount, 3);
  assertEqual(shownKeys(), hits.map(keyOf).sort());
});

test("end restores folder, selection, scroll and sort", async () => {
  const { threadTree, gViewWrapper } = win;
  // A short window, so the few test mails overflow the list.
  const height = mainWindow.outerHeight;
  mainWindow.resizeTo(mainWindow.outerWidth, 420);
  threadTree.selectedIndex = 5;
  win.sortController.sortThreadPane("subjectCol");
  try {
    await waitFor(() => threadTree.scrollHeight > threadTree.clientHeight + 50);
    threadTree.scrollTop = threadTree.scrollHeight;
    await sleep(100);
    const before = {
      folder: win.gFolder.URI,
      selected: keyOf(win.gDBView.hdrForFirstSelectedMessage),
      scrollTop: threadTree.scrollTop,
      sortType: win.gViewWrapper.primarySortType,
      sortOrder: win.gViewWrapper.primarySortOrder,
    };
    assert(before.scrollTop > 0, "the message list does not scroll");
    assertEqual(before.sortType, Ci.nsMsgViewSortType.bySubject);

    results.show(win, [hdrs(archive)[0]]);
    await sleep(50);
    results.end(win);
    assert(!results.isActive(win), "search still active");
    await waitFor(() => win.threadTree.scrollTop === before.scrollTop);
    assertEqual(
      {
        folder: win.gFolder.URI,
        selected: keyOf(win.gDBView.hdrForFirstSelectedMessage),
        scrollTop: win.threadTree.scrollTop,
        sortType: win.gViewWrapper.primarySortType,
        sortOrder: win.gViewWrapper.primarySortOrder,
      },
      before,
    );
    assert(win.gViewWrapper !== gViewWrapper || !win.gViewWrapper.isSearch, "still the search view");
  } finally {
    win.gViewWrapper?.sort("dateCol", Ci.nsMsgViewSortOrder.descending);
    mainWindow.resizeTo(mainWindow.outerWidth, height);
  }
});

test("add appends hits to an active view", async () => {
  const [first, second] = hdrs(inbox);
  results.show(win, [first]);
  assertEqual(win.gDBView.rowCount, 1);
  results.add(win, [second, hdrs(archive)[1]]);
  assertEqual(win.gDBView.rowCount, 3);
  assertEqual(shownKeys(), [first, second, hdrs(archive)[1]].map(keyOf).sort());
});

test("folder click while active ends the search", async () => {
  const errors = await consoleErrors(async () => {
    results.show(win, hdrs(inbox).slice(0, 2));
    win.displayFolder(archive);
    await waitFor(() => win.gFolder?.URI === archive.URI && win.gDBView);
    assert(!results.isActive(win), "search still active");
    assertEqual(win.gDBView.rowCount, archive.getTotalMessages(false));
    results.end(win);
    assertEqual(win.gFolder.URI, archive.URI);
  });
  assertEqual(errors, []);
});

test("deleting a shown folder's mail leaves no exception", async () => {
  // A mail of its own, so the seeded data stays as it is.
  const id = `search-temp-${Date.now()}@example.org`;
  const text = [`From: Temp Sender <temp@example.org>`, `Subject: Temporary`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${id}>`, ``, `Temporary mail.`, ``].join("\r\n");
  inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(text);
  const temp = inbox.msgDatabase.getMsgHdrForMessageID(id);
  assert(temp, "temporary mail not added");
  const other = hdrs(archive)[0];
  const errors = await consoleErrors(async () => {
    results.show(win, [temp, other]);
    assertEqual(win.gDBView.rowCount, 2);
    inbox.deleteMessages([temp], null, true, false, null, false);
    await waitFor(() => win.gDBView.rowCount === 1);
    assertEqual(shownKeys(), [keyOf(other)]);
    results.end(win);
    await waitFor(() => win.gFolder?.URI === inbox.URI && !win.gViewWrapper.isSearch);
    assertEqual(win.gDBView.rowCount, inbox.getTotalMessages(false));
  });
  assertEqual(errors, []);
});

// Engine

const secondInbox = MailServices.accounts.findServer("searchsecond", "search.test", "none").rootFolder.getChildNamed("Inbox");
const seededFolders = [inbox, archive, secondInbox];

// Seeded mails by their number in search-setup.js (Message-ID search-N@example.org).
function seededHdr(n) {
  for (const folder of seededFolders) {
    const hdr = folder.msgDatabase.getMsgHdrForMessageID(`search-${n}@example.org`);
    if (hdr) {
      return hdr;
    }
  }
  throw new Error(`seeded mail ${n} not found`);
}

function seeded(n) {
  return keyOf(seededHdr(n));
}

function seededSet(...numbers) {
  return numbers.map(seeded).sort();
}

// Runs a query to the end and returns every progress state it reported.
async function search(text, { current = inbox, scopeDefault = "folder" } = {}) {
  const calls = [];
  const run = engine.run(win, query.parse(text), { current, scopeDefault }, state => calls.push(state));
  // A search that never finishes fails the test instead of the whole suite.
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`search for ${text} did not finish`)), 30000);
  });
  try {
    await Promise.race([run.done, timeout]);
  } finally {
    clearTimeout(timer);
    run.cancel();
  }
  return { calls, last: calls.at(-1) };
}

const sortedIds = ids => [...ids].sort();

function includesAll(ids, wanted) {
  return wanted.every(id => ids.has(id));
}

// A local folder of its own under Search Test, removed again (also from the trash) after `fn`.
async function withTempFolder(name, fn) {
  const folder = testRoot.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder(name);
  try {
    await fn(folder);
  } finally {
    folder.deleteSelf(null);
    const trash = MailServices.accounts.localFoldersServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
    trash?.getChildNamed(name)?.deleteSelf(null);
  }
}

let glodaReady = null;
// Gloda indexes new local mail on its own after a while; asking for the seeded folders
// directly keeps the tests from waiting for that sweep.
function glodaIndexed() {
  glodaReady ??= (async () => {
    const { GlodaIndexer } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaIndexer.sys.mjs");
    const { GlodaMsgIndexer } = ChromeUtils.importESModule("resource:///modules/gloda/IndexMsg.sys.mjs");
    const pending = () => seededFolders.filter(folder => [...folder.messages].some(hdr => !GlodaMsgIndexer.isMessageIndexed(hdr)));
    for (const folder of pending()) {
      GlodaMsgIndexer.indexFolder(folder);
    }
    await waitFor(() => !pending().length && !GlodaIndexer.indexing, 60000);
  })();
  return glodaReady;
}

test("header search finds sender in both scopes", async () => {
  const { last } = await search("from:alice");
  assertEqual(last.searching, false);
  assertEqual(sortedIds(last.folderIds), seededSet(1, 5));
  assertEqual(sortedIds(last.allIds), seededSet(1, 5, 10, 13));
  const hdr = last.hdr(seeded(10));
  assertEqual(hdr?.messageId, "search-10@example.org");
});

test("body word in base64 mail is found through Gloda", async () => {
  await glodaIndexed();
  const { calls, last } = await search("Krankenversicherungsbeitrag");
  // The first report comes after Gloda and before the scan.
  assert(calls[0].searching && calls[0].allIds.has(seeded(2)), `Gloda found ${sortedIds(calls[0].allIds)}`);
  assert(includesAll(last.allIds, seededSet(1, 2)), `got ${sortedIds(last.allIds)}`);
});

test("word beginning finds a compound", async () => {
  await glodaIndexed();
  const { calls, last } = await search("kranken");
  assert(calls[0].searching && calls[0].allIds.has(seeded(1)), `Gloda found ${sortedIds(calls[0].allIds)}`);
  assert(last.allIds.has(seeded(1)), `got ${sortedIds(last.allIds)}`);
});

test("fragment in a plain mail is found by the scan", async () => {
  await glodaIndexed();
  const { last } = await search("versicherung");
  // Gloda matches word beginnings only, so this hit comes from the scan.
  assert(last.allIds.has(seeded(1)), `got ${sortedIds(last.allIds)}`);
});

test("phrase in base64 mail matches when all words occur", async () => {
  await glodaIndexed();
  const { calls, last } = await search('"Rechnungsnummer 4711"');
  assert(calls[0].searching && calls[0].allIds.has(seeded(2)), `Gloda found ${sortedIds(calls[0].allIds)}`);
  assert(last.allIds.has(seeded(2)), `got ${sortedIds(last.allIds)}`);
});

test("OR and minus combine", async () => {
  const { last } = await search("from:alice OR from:bob -tag:$label1");
  assertEqual(sortedIds(last.folderIds), seededSet(1, 2, 5));
  assertEqual(sortedIds(last.allIds), seededSet(1, 2, 5, 10, 11, 13));
});

test("OR binds tighter than AND", async () => {
  const { last } = await search("from:alice OR from:bob subject:Notiz");
  assertEqual(sortedIds(last.allIds), seededSet(11));
  const groups = await search("from:alice OR from:bob subject:Rechnung OR subject:Archivierte");
  assertEqual(sortedIds(groups.last.allIds), seededSet(2, 10, 11));
});

test("tag names match case-insensitively and unknown tags match nothing", async () => {
  const name = MailServices.tags.getTagForKey("$label1");
  const { last } = await search(`tag:"${name.toUpperCase()}"`);
  assertEqual(sortedIds(last.allIds), seededSet(6));
  const unknown = await search("tag:nosuchtag");
  assertEqual(unknown.last.allIds.size, 0);
});

test("default tags match their default names in English and German", async () => {
  for (const text of ["tag:Important", "schlagwort:wichtig", 'tag:"WICHTIG"']) {
    const { last } = await search(text);
    assertEqual(sortedIds(last.allIds), seededSet(6));
  }
  setText(fieldInput(), "schlagwort:Wichtig tag:important");
  const panel = await openPanel();
  try {
    const tags = row(panel, "tags");
    assert(!tags.querySelector('.qol-tag[data-key="$label1"]').classList.contains("off"), "the Important tag is off");
    assertEqual(tags.querySelectorAll(".qol-chip:not(.qol-tag)").length, 0);
  } finally {
    panel.hidePopup();
  }
});

test("before excludes the given day and after includes it", async () => {
  await withTempFolder("Search Dates", async folder => {
    // Local times around 2026-10-10; the search compares calendar days in local time.
    const times = [new Date(2026, 9, 9, 23, 30), new Date(2026, 9, 10, 0, 30), new Date(2026, 9, 10, 23, 30), new Date(2026, 9, 11, 0, 30)];
    const ids = times.map((time, i) => {
      const messageId = `search-date-${i}@example.org`;
      const text = [`From: Date Sender <dates@example.org>`, `Subject: Date ${i}`, `Date: ${time.toUTCString().replace("GMT", "+0000")}`, `Message-ID: <${messageId}>`, ``, `Date mail.`, ``].join("\r\n");
      folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(text);
      return keyOf(folder.msgDatabase.getMsgHdrForMessageID(messageId));
    });
    const before = await search('in:"Search Dates" before:2026-10-10');
    assertEqual(sortedIds(before.last.allIds), [ids[0]]);
    const after = await search('in:"Search Dates" after:2026-10-10');
    assertEqual(sortedIds(after.last.allIds), [ids[1], ids[2], ids[3]].sort());
    const day = await search('in:"Search Dates" nach:10.10.2026 vor:11.10.2026');
    assertEqual(sortedIds(day.last.allIds), [ids[1], ids[2]].sort());
  });
});

test("cancel stops progress", async () => {
  let calls = 0;
  let run = null;
  run = engine.run(win, query.parse("Grüße"), { current: inbox, scopeDefault: "all" }, () => {
    calls++;
    run.cancel();
  });
  await run.done;
  await sleep(2000);
  assertEqual(calls, 1);
});

// A folder "Search Bulk" of 5000 headers without bodies.
async function withBulkFolder(fn) {
  await withTempFolder("Search Bulk", async folder => {
    const db = folder.msgDatabase;
    for (let key = 1; key <= 5000; key++) {
      const hdr = db.createNewHdrWithSpecificMsgKey(key);
      hdr.author = "Bulk Sender <bulk@example.org>";
      hdr.subject = `Bulk ${key}`;
      hdr.date = Date.UTC(2026, 0, 1) * 1000;
      db.addNewHdrToDB(hdr, true);
    }
    await fn(folder);
  });
}

test("negated-only query on all mailboxes yields to the UI", async () => {
  await withBulkFolder(async () => {
    // Only the folder's universe, no search session that would yield on its own.
    let fired = false;
    setTimeout(() => (fired = true), 0);
    const run = engine.run(win, query.parse('in:"Search Bulk"'), { current: inbox, scopeDefault: "all" }, () => {});
    let doneFirst = false;
    await run.done.then(() => (doneFirst = !fired));
    assert(!doneFirst, "the search finished before a timer could run");
    const bulk = await search('in:"Search Bulk"');
    assertEqual(bulk.last.allIds.size, 5000);
    const { last } = await search("-from:nobody", { scopeDefault: "all" });
    assert(last.allIds.size >= 5015, `only ${last.allIds.size} mails`);
    assertEqual(last.folderIds.size, inbox.getTotalMessages(false));
  });
});

test("search characters of the full-text index stay plain text", async () => {
  await glodaIndexed();
  const odd = await search('(x"y: NOT -* ^:');
  assertEqual(odd.last.searching, false);
  const { calls } = await search('"Rechnungsnummer 4711-0815"');
  assert(calls[0].searching && calls[0].allIds.has(seeded(2)), `Gloda found ${sortedIds(calls[0].allIds)}`);
});

test("a saved search as current folder searches its folders", async () => {
  const { VirtualFolderHelper } = ChromeUtils.importESModule("resource:///modules/VirtualFolderWrapper.sys.mjs");
  const saved = VirtualFolderHelper.createNewVirtualFolder("Search Saved", testRoot, [inbox, archive], "ALL", false).virtualFolder;
  try {
    const { last } = await search("from:alice", { current: saved });
    assertEqual(sortedIds(last.folderIds), seededSet(1, 5, 10));
    assertEqual(sortedIds(last.allIds), seededSet(1, 5, 10, 13));
  } finally {
    saved.deleteSelf(null);
    MailServices.accounts.localFoldersServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash)?.getChildNamed("Search Saved")?.deleteSelf(null);
  }
});

test("unknown folder reports and does not search", async () => {
  const { calls } = await search("in:nosuchfolder from:alice");
  assertEqual(calls.length, 1);
  assertEqual(calls[0].searching, false);
  assertEqual(calls[0].notices, [{ kind: "unknownFolder", name: "nosuchfolder" }]);
  assertEqual(calls[0].allIds.size, 0);
});

test("gloda off reports notice", async () => {
  const pref = "mailnews.database.global.indexer.enabled";
  const was = Services.prefs.getBoolPref(pref, true);
  Services.prefs.setBoolPref(pref, false);
  try {
    const { last } = await search("Krankenversicherungsbeitrag");
    assert(last.notices.some(notice => notice.kind === "glodaOff"), `notices ${JSON.stringify(last.notices)}`);
    assert(last.folderIds.has(seeded(1)), "scan result missing");
    const header = await search("from:alice");
    assertEqual(header.last.notices, []);
  } finally {
    Services.prefs.setBoolPref(pref, was);
  }
});

// Field and panel

const doc = mainWindow.document;

// The test profile may run in either UI language.
function label(key) {
  const { qolSearchLabels } = libs();
  return qolSearchLabels.label(qolSearchLabels.pickLanguage(Services.locale.appLocaleAsBCP47), key);
}

function printed(text) {
  return query.print(query.parse(text), libs().qolSearchLabels.pickLanguage(Services.locale.appLocaleAsBCP47));
}

function field() {
  return doc.getElementById("qol-search");
}

function fieldInput() {
  return field().querySelector("input.qol-search-input");
}

function globalSearchBar() {
  return doc.querySelector("#unifiedToolbarContent global-search-bar");
}

function shown(element) {
  return Boolean(element) && element.getBoundingClientRect().width > 0 && mainWindow.getComputedStyle(element).display !== "none";
}

function key(target, key, init = {}) {
  target.dispatchEvent(new mainWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

function setText(input, text) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new mainWindow.InputEvent("input", { bubbles: true }));
}

function chipRow() {
  return win.document.getElementById("qol-search-results");
}

function scopeChip(scope) {
  return chipRow()?.querySelector(`.qol-scope-chip[data-scope="${scope}"]`);
}

function headerText() {
  return win.document.getElementById("threadPaneFolderName").textContent;
}

// Types into the field and presses Enter; resolves when the search has finished.
async function searchFor(text) {
  setText(fieldInput(), text);
  key(fieldInput(), "Enter");
  await waitFor(() => results.isActive(win) && chipRow() && !chipRow().querySelector(".qol-searching:not([hidden])"), 10000);
}

// Replaces qolSearchEngine.run while `fn` runs; `wrap` gets the real run.
async function withRun(wrap, fn) {
  const lib = libs().qolSearchEngine;
  const real = lib.run;
  lib.run = wrap(real);
  try {
    await fn();
  } finally {
    lib.run = real;
  }
}

async function openPanel() {
  const panel = mainWindow.qolSearch.controller.panel.panel;
  field().querySelector(".qol-search-filter").click();
  await waitFor(() => panel.state === "open", 5000);
  return panel;
}

function row(panel, name) {
  return panel.querySelector(`[data-row="${name}"]`);
}

test("field replaces Thunderbird's search bar", async () => {
  assert(shown(field()), "Officebird's field is not visible");
  assert(field().closest('li[item-id="search-bar"]'), "the field is not where Thunderbird's search bar was");
  assert(!shown(globalSearchBar()), "Thunderbird's search bar is still visible");
  assertEqual(fieldInput().placeholder, label("placeholder"));
});

test("typing and Enter shows results and chips", async () => {
  const folderHeader = headerText();
  const expected = (await search("from:alice")).last;
  await searchFor("from:alice");
  assertEqual(shownKeys(), sortedIds(expected.folderIds));
  assertEqual(headerText(), `${label("results")} · ${expected.folderIds.size}`);
  assertEqual(scopeChip("folder").textContent, `${inbox.localizedName} · ${expected.folderIds.size}`);
  assertEqual(scopeChip("all").textContent, `${label("allMailboxes")} · ${expected.allIds.size}`);
  assert(scopeChip("folder").classList.contains("active"), "This folder is not the active chip");
  assert(!scopeChip("all").classList.contains("active"), "All mailboxes is active too");
  key(fieldInput(), "Escape");
  await waitFor(() => !results.isActive(win));
  await waitFor(() => headerText() === folderHeader);
});

test("panel and field stay in sync", async () => {
  setText(fieldInput(), "from:alice");
  const panel = await openPanel();
  const from = row(panel, "from");
  assertEqual([...from.querySelectorAll(".qol-chip")].map(chip => chip.textContent), ["alice"]);
  const input = from.querySelector("input");
  setText(input, "bob");
  key(input, "Enter");
  const bob = await waitFor(() => [...from.querySelectorAll(".qol-chip")].find(chip => chip.textContent.endsWith("bob")));
  bob.click();
  await waitFor(() => [...from.querySelectorAll(".qol-chip.excluded")].some(chip => chip.textContent.endsWith("bob")));
  panel.querySelector(".qol-panel-search").click();
  assertEqual(fieldInput().value, printed("from:alice -from:bob"));
  await waitFor(() => panel.state === "closed");
  await waitFor(() => results.isActive(win) && !chipRow().querySelector(".qol-searching:not([hidden])"), 10000);
  assertEqual(shownKeys(), seededSet(1, 5));
});

test("the panel keeps a query it cannot show unless it is edited", async () => {
  const text = "from:alice OR subject:Rechnung";
  setText(fieldInput(), text);
  const panel = await openPanel();
  assertEqual(keptGroups(panel), [[printed("from:alice"), printed("subject:Rechnung")]]);
  panel.querySelector(".qol-panel-search").click();
  assertEqual(fieldInput().value, text);
  await waitFor(() => results.isActive(win) && !chipRow().querySelector(".qol-searching:not([hidden])"), 10000);
  assertEqual(shownKeys(), seededSet(1, 2, 5));
});

// The rows whose "or" marker shows.
function orMarkedRows(panel) {
  return [...panel.querySelectorAll(".qol-row-or:not([hidden])")].map(marker => marker.closest("[data-row]").dataset.row);
}

// The read-only OR groups the rows cannot show, as the texts of their chips.
function keptGroups(panel) {
  const line = row(panel, "kept").querySelector(".qol-kept");
  if (line.hidden) {
    return [];
  }
  return [...line.querySelectorAll(".qol-kept-group")].map(group => [...group.querySelectorAll(".qol-chip")].map(chip => chip.textContent));
}

function flagState(panel, flag) {
  return panel.querySelector(`.qol-flag[data-flag="${flag}"]`).dataset.state;
}

test("the panel shows an OR group of one field and the terms after it", async () => {
  setText(fieldInput(), "from:alice OR from:bob subject:Rechnung -is:unread");
  const panel = await openPanel();
  try {
    assertEqual([...row(panel, "from").querySelectorAll(".qol-chip")].map(chip => chip.textContent), ["alice", "bob"]);
    assertEqual(row(panel, "from").querySelectorAll(".qol-chip-gap.or").length, 1);
    assertEqual(row(panel, "subject").querySelectorAll(".qol-chip").length, 1);
    assertEqual(orMarkedRows(panel), []);
    assertEqual(keptGroups(panel), []);
    assertEqual(flagState(panel, "unread"), "no");
  } finally {
    panel.hidePopup();
  }
});

test("a cross-field OR shows as a read-only group, the other terms in their rows", async () => {
  setText(fieldInput(), "from:alice OR is:unread subject:Rechnung has:attachment");
  const panel = await openPanel();
  try {
    assertEqual(keptGroups(panel), [[printed("from:alice"), printed("is:unread")]]);
    assertEqual(orMarkedRows(panel), []);
    assertEqual(row(panel, "from").querySelectorAll(".qol-chip").length, 0);
    assertEqual(row(panel, "subject").querySelectorAll(".qol-chip").length, 1);
    assertEqual(flagState(panel, "unread"), "any");
    assertEqual(flagState(panel, "attachment"), "yes");
  } finally {
    panel.hidePopup();
  }
});

test("editing the panel keeps an OR group of flags", async () => {
  const text = "has:attachment OR is:unread";
  const expected = (await search(text)).last;
  setText(fieldInput(), text);
  assert(field().querySelector(".qol-search-filter").classList.contains("active"), "the filter button is not active");
  const panel = await openPanel();
  // Flagged on and off again: an edit that changes nothing.
  const flagged = panel.querySelector('.qol-flag[data-flag="flagged"]');
  flagged.click();
  flagged.click();
  assertEqual(flagState(panel, "flagged"), "any");
  panel.querySelector(".qol-panel-search").click();
  assertEqual(fieldInput().value, printed(text));
  await waitFor(() => results.isActive(win) && !chipRow().querySelector(".qol-searching:not([hidden])"), 10000);
  assertEqual(shownKeys(), sortedIds(expected.folderIds));
  assertEqual(shownKeys(), seededSet(3, 5));
});

test("the folder chip names the folder chosen with in:", async () => {
  const name = archive.localizedName;
  const others = [...MailServices.accounts.allFolders].filter(folder => !folder.isServer && folder.URI !== archive.URI && folder.localizedName === name);
  await searchFor(`in:${name.toLowerCase()}`);
  assertEqual(scopeChip("folder").textContent, `${others.length ? `${name} · ${archive.server.prettyName}` : name} · 3`);
  // A second folder of that name: the account tells them apart.
  const secondRoot = secondInbox.server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const twin = secondRoot.createLocalSubfolder(archive.name);
  try {
    await searchFor(`in:"${archive.server.prettyName}/${name.toLowerCase()}"`);
    assertEqual(scopeChip("folder").textContent, `${name} · ${archive.server.prettyName} · 3`);
    // Both folders searched: the name alone.
    await searchFor(`in:${name.toLowerCase()}`);
    assertEqual(scopeChip("folder").textContent, `${name} · 3`);
  } finally {
    results.end(win);
    twin.deleteSelf(null);
    secondRoot.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash)?.getChildNamed(archive.name)?.deleteSelf(null);
  }
});

test("chip click switches scope without new search", async () => {
  await searchFor("from:alice");
  let runs = 0;
  await withRun(real => (...args) => (runs++, real(...args)), async () => {
    scopeChip("all").click();
    await waitFor(() => win.gDBView.rowCount === 4);
    assertEqual(shownKeys(), seededSet(1, 5, 10, 13));
    assert(scopeChip("all").classList.contains("active"), "All mailboxes is not active");
    assertEqual(headerText(), `${label("results")} · 4`);
    scopeChip("folder").click();
    await waitFor(() => win.gDBView.rowCount === 2);
  });
  assertEqual(runs, 0);
});

test("hits arriving later are added to the list", async () => {
  const lib = libs().qolSearchResults;
  const calls = { show: 0, add: 0 };
  const realShow = lib.show;
  const realAdd = lib.add;
  lib.show = (...args) => (calls.show++, realShow(...args));
  lib.add = (...args) => (calls.add++, realAdd(...args));
  try {
    // The first report holds only the first hit, the next one all of them.
    await withRun(real => (w, q, opts, onProgress) => {
      let reports = 0;
      return real(w, q, opts, state => {
        if (reports++ === 0) {
          const [first] = sortedIds(state.folderIds);
          onProgress({ ...state, searching: true, folderIds: new Set([first]), allIds: new Set([first]) });
        }
        onProgress(state);
      });
    }, async () => {
      await searchFor("from:alice");
    });
    assertEqual(shownKeys(), seededSet(1, 5));
    assertEqual(calls.show, 1);
    assert(calls.add >= 1, "no hits were added");
  } finally {
    lib.show = realShow;
    lib.add = realAdd;
  }
});

// The hits in the order the list shows them.
function rowOrder() {
  const keys = [];
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    keys.push(keyOf(win.gDBView.getMsgHdrAt(i)));
  }
  return keys;
}

test("results come newest first, also after a scope switch and later hits", async () => {
  // Hits reported oldest first, held back until `release`.
  let release = null;
  await withRun(real => (w, q, opts, onProgress) => {
    let final = null;
    let held = true;
    release = () => {
      held = false;
      onProgress({ ...final, allIds: new Set([...final.allIds].reverse()) });
    };
    return real(w, q, opts, state => {
      if (!held) {
        return onProgress(state);
      }
      if (!final) {
        onProgress({ ...state, searching: true, folderIds: new Set([seeded(1)]), allIds: new Set([seeded(13), seeded(5)]) });
      }
      final = state;
    });
  }, async () => {
    setText(fieldInput(), "from:alice");
    key(fieldInput(), "Enter");
    await waitFor(() => results.isActive(win) && win.gDBView.rowCount === 1, 10000);
    await waitFor(() => release && scopeChip("all"));
    scopeChip("all").click();
    await waitFor(() => win.gDBView.rowCount === 2);
    assertEqual(rowOrder(), [seeded(5), seeded(13)]);
    release();
    await waitFor(() => win.gDBView.rowCount === 4);
    await sleep(100);
    assertEqual(rowOrder(), [1, 5, 10, 13].map(seeded));
  });
  // The user's sort stays for this search, also in the other scope.
  win.gViewWrapper.sort("dateCol", Ci.nsMsgViewSortOrder.ascending);
  assertEqual(rowOrder(), [13, 10, 5, 1].map(seeded));
  scopeChip("folder").click();
  await waitFor(() => win.gDBView.rowCount === 2);
  assertEqual(rowOrder(), [5, 1].map(seeded));
  // A new search sorts newest first again.
  const newest = JSON.stringify([1, 5].map(seeded));
  await searchFor("from:alice");
  await waitFor(() => JSON.stringify(rowOrder()) === newest);
});

test("a failed search run keeps the hits shown so far", async () => {
  await withRun(real => (w, q, opts, onProgress) => {
    const run = real(w, q, opts, state => onProgress({ ...state, searching: true }));
    return { cancel: run.cancel, done: run.done.then(() => Promise.reject(new Error("test failure"))) };
  }, async () => {
    await searchFor("from:alice");
  });
  assertEqual(shownKeys(), seededSet(1, 5));
  assert(chipRow().querySelector(".qol-searching")?.hidden !== false, "still searching");
});

test("a list that cannot switch to results comes back as the folder", async () => {
  const proto = win.DBViewWrapper.prototype;
  const real = proto.openSearchView;
  proto.openSearchView = function () {
    throw new Error("test failure");
  };
  try {
    let threw = false;
    try {
      results.show(win, hdrs(inbox).slice(0, 2));
    } catch (e) {
      threw = true;
    }
    assert(threw, "show did not report the failure");
    assert(!results.isActive(win), "search still active");
    await waitFor(() => win.gFolder?.URI === inbox.URI && win.gDBView && !win.gViewWrapper.isSearch);
    assertEqual(win.gDBView.rowCount, inbox.getTotalMessages(false));
    // Through the field: the search gives up, the folder stays.
    setText(fieldInput(), "from:alice");
    key(fieldInput(), "Enter");
    await sleep(500);
    assert(!results.isActive(win), "search active after a failed switch");
    assertEqual(win.gDBView.rowCount, inbox.getTotalMessages(false));
    assert(!chipRow() || chipRow().hidden, "chips shown for a failed search");
  } finally {
    proto.openSearchView = real;
  }
});

test("Esc restores the folder", async () => {
  const folderHeader = headerText();
  await searchFor("from:alice");
  key(fieldInput(), "Escape");
  await waitFor(() => !results.isActive(win));
  await waitFor(() => win.gFolder?.URI === inbox.URI && win.gDBView && !win.gViewWrapper.isSearch);
  assertEqual(win.gDBView.rowCount, inbox.getTotalMessages(false));
  assertEqual(headerText(), folderHeader);
  assert(!win.document.getElementById("threadPaneFolderCount").hidden, "the folder's message count is hidden");
  assert(!chipRow() || chipRow().hidden, "chips still shown");
});

test("clicking the selected folder ends the search", async () => {
  await searchFor("from:alice");
  const selected = win.folderTree.selectedRow;
  assertEqual(selected.uri, inbox.URI);
  selected.querySelector(".container").click();
  await waitFor(() => !results.isActive(win));
  await waitFor(() => win.gDBView && !win.gViewWrapper.isSearch && win.gDBView.rowCount === inbox.getTotalMessages(false));
  assert(!chipRow() || chipRow().hidden, "chips still shown");
});

test("selecting another folder ends the search", async () => {
  await searchFor("from:alice");
  win.displayFolder(archive);
  await waitFor(() => win.gFolder?.URI === archive.URI && win.gDBView && !win.gViewWrapper.isSearch);
  await waitFor(() => !chipRow() || chipRow().hidden);
  assertEqual(headerText(), archive.abbreviatedName);
  assert(!win.document.getElementById("threadPaneFolderCount").hidden, "the folder's message count is hidden");
  assertEqual(win.gDBView.rowCount, archive.getTotalMessages(false));
});

test("the search shortcut focuses the field", async () => {
  mainWindow.QuickSearchFocus();
  assertEqual(doc.activeElement, fieldInput());
});

test("turning the feature off brings Thunderbird's bar back", async () => {
  try {
    await setSearch({ enabled: false });
    assert(!field(), "the field is still there");
    await waitFor(() => shown(globalSearchBar()));
    mainWindow.QuickSearchFocus();
    assertEqual(doc.activeElement, globalSearchBar());
    const tabs = mainWindow.gTabmail.tabInfo.length;
    const errors = await consoleErrors(async () => {
      globalSearchBar().dispatchEvent(new mainWindow.CustomEvent("search", { detail: "Rechnung" }));
      await waitFor(() => mainWindow.gTabmail.tabInfo.length === tabs + 1);
      assertEqual(mainWindow.gTabmail.currentTabInfo.mode.name, "glodaFacet");
      mainWindow.gTabmail.closeTab(mainWindow.gTabmail.currentTabInfo);
      mainWindow.gTabmail.switchToTab(0);
    });
    assertEqual(errors, []);
  } finally {
    await setSearch({ enabled: true });
  }
  assert(shown(field()), "the field did not come back");
  assert(!shown(globalSearchBar()), "Thunderbird's search bar is still visible");
});

// Review Focus 4.
test("a hook failure disables search only", async () => {
  const bg = background();
  const config = () => Cu.cloneInto({ enabled: true, scope: "folder" }, bg);
  const features = JSON.stringify(await bg.messenger.qol.getFeatures());
  mainWindow.__qolSearchFail = true;
  try {
    const result = await bg.messenger.qolSearch.init(config());
    assertEqual(JSON.parse(JSON.stringify(result)), { search: false });
    assertEqual(JSON.parse(JSON.stringify(await bg.messenger.qolSearch.getFeatures())), { search: false });
    assert(!field(), "the field is still there");
    await waitFor(() => shown(globalSearchBar()));
    assertEqual(JSON.stringify(await bg.messenger.qol.getFeatures()), features);
    await openFolder(archive);
    await waitFor(() => win.document.querySelector("[data-qol-id]"));
  } finally {
    delete mainWindow.__qolSearchFail;
    await bg.messenger.qolSearch.init(config());
  }
  await waitFor(() => shown(field()));
  assertEqual(JSON.parse(JSON.stringify(await bg.messenger.qolSearch.getFeatures())), { search: true });
});

// Tabs, notices, tip and empty state

const GLODA_PREF = "mailnews.database.global.indexer.enabled";
const TIP_PREF = "extensions.officebird.search.tipCount";

function rowOf(pane) {
  return pane.document.getElementById("qol-search-results");
}

function keysOf(pane) {
  const keys = [];
  for (let i = 0; i < pane.gDBView.rowCount; i++) {
    keys.push(keyOf(pane.gDBView.getMsgHdrAt(i)));
  }
  return keys.sort();
}

function notice(kind) {
  return chipRow()?.querySelector(`.qol-notice[data-kind="${kind}"]`);
}

async function openMailTab(folder) {
  const tabmail = mainWindow.gTabmail;
  const tab = tabmail.openTab("mail3PaneTab", { folderURI: folder.URI, background: false });
  await waitFor(() => {
    const pane = tab.chromeBrowser?.contentWindow;
    return pane?.gFolder?.URI === folder.URI && pane.gDBView && pane.dbViewWrapperListener?.allMessagesLoaded;
  }, 10000);
  return tab;
}

// Holds every progress report of the search runs back until `release` is called.
function heldRuns() {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const wrap = real => (w, q, opts, onProgress) => {
    const run = real(w, q, opts, state => gate.then(() => onProgress(state)));
    return { cancel: run.cancel, done: run.done.then(() => gate).then(() => sleep(50)) };
  };
  return { wrap, release };
}

// Review Focus 5.
test("hits stay in their tab", async () => {
  const tabmail = mainWindow.gTabmail;
  const held = heldRuns();
  let tabB = null;
  try {
    await withRun(held.wrap, async () => {
      setText(fieldInput(), "Krankenversicherungsbeitrag");
      key(fieldInput(), "Enter");
      tabB = await openMailTab(archive);
      const paneB = tabB.chromeBrowser.contentWindow;
      assertEqual(fieldInput().value, "");
      held.release();
      await waitFor(() => results.isActive(win) && !rowOf(win).querySelector(".qol-searching:not([hidden])"), 15000);
      assert(!paneB.gViewWrapper.isSearch, "tab B shows search results");
      assertEqual(paneB.gDBView.rowCount, archive.getTotalMessages(false));
      assert(!rowOf(paneB), "tab B has result chips");
      tabmail.switchToTab(0);
      assertEqual(fieldInput().value, "Krankenversicherungsbeitrag");
      assert(shownKeys().includes(seeded(1)), `tab A shows ${shownKeys()}`);
      tabmail.switchToTab(tabB);
      assertEqual(fieldInput().value, "");
    });
  } finally {
    if (tabB) {
      tabmail.closeTab(tabB);
    }
    tabmail.switchToTab(0);
  }
});

test("each tab keeps its own search", async () => {
  const tabmail = mainWindow.gTabmail;
  const tabB = await openMailTab(archive);
  try {
    const paneB = tabB.chromeBrowser.contentWindow;
    setText(fieldInput(), "from:bob");
    key(fieldInput(), "Enter");
    await waitFor(() => results.isActive(paneB) && !rowOf(paneB).querySelector(".qol-searching:not([hidden])"), 10000);
    tabmail.switchToTab(0);
    assertEqual(fieldInput().value, "");
    await searchFor("from:alice");
    tabmail.switchToTab(tabB);
    assertEqual(fieldInput().value, "from:bob");
    assertEqual(keysOf(paneB), seededSet(11));
    tabmail.switchToTab(0);
    assertEqual(fieldInput().value, "from:alice");
    assertEqual(shownKeys(), seededSet(1, 5));
    // Closing a tab forgets its search and its folder pane.
    const controller = mainWindow.qolSearch.controller;
    tabmail.closeTab(tabB);
    assert(![...controller.panes.keys()].includes(paneB), "the closed tab's pane is still watched");
    assert(![...controller.tabs.keys()].includes(tabB), "the closed tab's search is still kept");
  } finally {
    if (tabmail.tabInfo.includes(tabB)) {
      tabmail.closeTab(tabB);
    }
    tabmail.switchToTab(0);
  }
});

test("a search in another kind of tab shows results in the most recent mail tab", async () => {
  const tabmail = mainWindow.gTabmail;
  const tabB = await openMailTab(archive);
  let content = null;
  try {
    const paneB = tabB.chromeBrowser.contentWindow;
    content = tabmail.openTab("contentTab", { url: "about:blank", background: false });
    await waitFor(() => tabmail.currentTabInfo === content);
    assertEqual(fieldInput().value, "");
    setText(fieldInput(), "from:bob");
    key(fieldInput(), "Enter");
    await waitFor(() => tabmail.currentTabInfo === tabB);
    await waitFor(() => results.isActive(paneB) && !rowOf(paneB).querySelector(".qol-searching:not([hidden])"), 10000);
    assertEqual(fieldInput().value, "from:bob");
    assert(!results.isActive(win), "the first mail tab shows results");
  } finally {
    if (content) {
      tabmail.closeTab(content);
    }
    tabmail.closeTab(tabB);
    tabmail.switchToTab(0);
  }
});

test("the shortcut listener leaves other kinds of tabs alone", async () => {
  const tabmail = mainWindow.gTabmail;
  const content = tabmail.openTab("contentTab", { url: "about:blank", background: false });
  try {
    await waitFor(() => tabmail.currentTabInfo === content);
    const mac = Services.appinfo.OS === "Darwin";
    const event = new mainWindow.KeyboardEvent("keydown", { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
    doc.documentElement.dispatchEvent(event);
    assert(!event.defaultPrevented, "the shortcut was taken from the page");
  } finally {
    tabmail.closeTab(content);
    tabmail.switchToTab(0);
  }
});

// searchFor() waits for a finished row; ending first keeps it from seeing the last one.
async function endSearch() {
  key(fieldInput(), "Escape");
  await waitFor(() => !chipRow() && !results.isActive(win));
}

// The toolbar rebuilds its items when the index is turned on or off.
async function setGloda(on) {
  Services.prefs.setBoolPref(GLODA_PREF, on);
  await waitFor(() => shown(field()));
}

test("glodaOff notice and Turn on", async () => {
  const was = Services.prefs.getBoolPref(GLODA_PREF, true);
  mainWindow.qolSearch.controller.manager.dismissed.clear();
  try {
    await setGloda(false);
    await searchFor("Krankenversicherungsbeitrag");
    const off = await waitFor(() => notice("glodaOff"));
    off.querySelector(".qol-notice-action").click();
    await waitFor(() => Services.prefs.getBoolPref(GLODA_PREF, false), 5000);
    await waitFor(() => !notice("glodaOff"));
    await waitFor(() => shown(field()));
    await endSearch();
    await searchFor("Krankenversicherungsbeitrag");
    assert(!notice("glodaOff"), "the notice came back with the index on");

    // ✕ closes it for the rest of the session.
    await setGloda(false);
    await searchFor("Krankenversicherungsbeitrag");
    (await waitFor(() => notice("glodaOff"))).querySelector(".qol-notice-close").click();
    await waitFor(() => !notice("glodaOff"));
    await endSearch();
    await searchFor("Rechnungsnummer");
    assert(!notice("glodaOff"), "a closed notice came back");
  } finally {
    await setGloda(was);
    mainWindow.qolSearch.controller.manager.dismissed.clear();
  }
});

// Gloda reads its pref at startup: with the pref turned on later, it is not running until
// a restart. The getter alone is replaced, so indexing itself keeps running.
async function withGlodaStopped(fn) {
  const { GlodaIndexer } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaIndexer.sys.mjs");
  const descriptor = Object.getOwnPropertyDescriptor(GlodaIndexer, "enabled");
  Object.defineProperty(GlodaIndexer, "enabled", { configurable: true, get: () => false });
  try {
    await fn();
  } finally {
    Object.defineProperty(GlodaIndexer, "enabled", descriptor);
  }
}

test("Turn on asks for a restart when the index is not running", async () => {
  const was = Services.prefs.getBoolPref(GLODA_PREF, true);
  mainWindow.qolSearch.controller.manager.dismissed.clear();
  try {
    await withGlodaStopped(async () => {
      await setGloda(false);
      await searchFor("Krankenversicherungsbeitrag");
      (await waitFor(() => notice("glodaOff"))).querySelector(".qol-notice-action").click();
      // Right away, before the pref has gone through the background.
      assert(notice("glodaRestart"), "no restart notice after Turn on");
      assert(!notice("glodaOff"), "the Turn on notice is still shown");
      assertEqual(notice("glodaRestart").textContent.startsWith(label("glodaRestart")), true);
      await waitFor(() => Services.prefs.getBoolPref(GLODA_PREF, false), 5000);
      await waitFor(() => shown(field()));

      // The next search with the pref on and the index not running.
      await endSearch();
      await searchFor("Krankenversicherungsbeitrag");
      assert(notice("glodaRestart"), "no restart notice for a new search");
      assert(!notice("glodaOff"), "Turn on is offered with the pref on");
      assert(shownKeys().includes(seeded(1)), `got ${shownKeys()}`);
      await endSearch();
      await searchFor("from:alice");
      assert(!notice("glodaRestart"), "restart notice without body terms");

      // It closes like the others.
      await endSearch();
      await searchFor("Krankenversicherungsbeitrag");
      notice("glodaRestart").querySelector(".qol-notice-close").click();
      await waitFor(() => !notice("glodaRestart"));
      await endSearch();
      await searchFor("Rechnungsnummer");
      assert(!notice("glodaRestart"), "a closed restart notice came back");
    });
  } finally {
    await setGloda(was);
    mainWindow.qolSearch.controller.manager.dismissed.clear();
  }
});

test("the restart notice Turn on put in place closes with ✕", async () => {
  const was = Services.prefs.getBoolPref(GLODA_PREF, true);
  mainWindow.qolSearch.controller.manager.dismissed.clear();
  try {
    await withGlodaStopped(async () => {
      await setGloda(false);
      await searchFor("Krankenversicherungsbeitrag");
      (await waitFor(() => notice("glodaOff"))).querySelector(".qol-notice-action").click();
      // In the same search.
      notice("glodaRestart").querySelector(".qol-notice-close").click();
      await waitFor(() => !notice("glodaRestart"));
      assert(!notice("glodaOff"), "the Turn on notice came back");
      await waitFor(() => Services.prefs.getBoolPref(GLODA_PREF, false), 5000);
      await waitFor(() => shown(field()));
    });
  } finally {
    await setGloda(was);
    mainWindow.qolSearch.controller.manager.dismissed.clear();
  }
});

test("tip shows for five searches", async () => {
  Services.prefs.clearUserPref(TIP_PREF);
  const shownTips = [];
  for (let run = 1; run <= 6; run++) {
    setText(fieldInput(), "from:alice");
    const panel = await openPanel();
    shownTips.push(shown(panel.querySelector(".qol-panel-tip")));
    panel.querySelector(".qol-panel-search").click();
    await waitFor(() => panel.state === "closed");
    await waitFor(() => results.isActive(win) && !chipRow().querySelector(".qol-searching:not([hidden])"), 10000);
  }
  assertEqual(shownTips, [true, true, true, true, true, false]);
  assertEqual(Services.prefs.getIntPref(TIP_PREF, 0), 6);
  // An empty panel has no tip.
  Services.prefs.clearUserPref(TIP_PREF);
  setText(fieldInput(), "");
  const panel = await openPanel();
  assert(!shown(panel.querySelector(".qol-panel-tip")), "an empty panel shows the tip");
  panel.hidePopup();
});

test("empty result shows search all", async () => {
  await searchFor("subject:Vereinsfeier");
  assertEqual(win.gDBView.rowCount, 0);
  const empty = chipRow().querySelector(".qol-search-empty");
  assert(shown(empty), "no empty state");
  assert(empty.textContent.includes(label("noResults")), `empty state reads ${empty.textContent}`);
  assertEqual([...empty.querySelectorAll(".qol-chip")].map(chip => chip.textContent), [printed("subject:Vereinsfeier")]);
  empty.querySelector(".qol-search-all").click();
  await waitFor(() => win.gDBView.rowCount === 1);
  assert(scopeChip("all").classList.contains("active"), "All mailboxes is not active");
  assertEqual(scopeChip("all").textContent, `${label("allMailboxes")} · 1`);
  assert(!chipRow().querySelector(".qol-search-empty"), "the empty state is still shown");
});

test("unknown folder blocks the search", async () => {
  setText(fieldInput(), "in:nosuchfolder from:alice");
  key(fieldInput(), "Enter");
  const chip = await waitFor(() => chipRow()?.querySelector(".qol-chip.error"));
  assertEqual(chip.textContent, "in:nosuchfolder");
  assertEqual(chip.title, libs().qolSearchLabels.label(libs().qolSearchLabels.pickLanguage(Services.locale.appLocaleAsBCP47), "unknownFolder", { name: "nosuchfolder" }));
  await sleep(300);
  assert(!results.isActive(win), "the list switched to results");
  assertEqual(win.gDBView.rowCount, inbox.getTotalMessages(false));
  assert(!scopeChip("folder"), "scope chips shown for a blocked search");
  key(fieldInput(), "Escape");
  await waitFor(() => !chipRow());
});

test("bad date is ignored and marked", async () => {
  await searchFor("after:32.13.2026 from:alice");
  assertEqual(shownKeys(), seededSet(1, 5));
  const chip = chipRow().querySelector(".qol-chip.error");
  assert(chip, "the date is not marked");
  assertEqual(chip.textContent, printed("after:32.13.2026"));
  assertEqual(chip.title, label("badDate"));
});

test("German UI shows German labels and keywords", async () => {
  const searched = [];
  const handle = libs().qolSearchPanel.install(mainWindow, {
    lang: "de",
    onSearch: text => searched.push(text),
    onEnd() {},
    onScope() {},
    onTurnOnIndex() {},
    onDismissNotice() {},
  });
  try {
    assertEqual(handle.root.querySelector("input.qol-search-input").placeholder, "E-Mails durchsuchen");
    const from = handle.panel.querySelector('[data-row="from"] input');
    from.value = "alice";
    handle.panel.querySelector('[data-flag="attachment"]').click();
    handle.panel.querySelector(".qol-panel-search").click();
    assertEqual(searched, ["von:alice hat:anhang"]);
    assertEqual(handle.panel.querySelector(".qol-panel-search").textContent, "Suchen");
  } finally {
    handle.destroy();
  }
});

test("a panel that fails to install leaves nothing behind", async () => {
  const before = doc.querySelectorAll("#qol-search-panel").length;
  let threw = false;
  try {
    libs().qolSearchPanel.install(mainWindow, { lang: "en", sheetURL: "not a url", onSearch() {}, onEnd() {}, onScope() {}, onTurnOnIndex() {} });
  } catch (e) {
    threw = true;
  }
  assert(threw, "install did not fail");
  assertEqual(doc.querySelectorAll("#qol-search-panel").length, before);
});

test("the default scope is read again for the next search", async () => {
  try {
    await setSearch({ scope: "all" });
    await waitFor(() => mainWindow.qolSearch.controller.manager.config?.scope === "all");
    await searchFor("from:alice");
    assert(scopeChip("all").classList.contains("active"), "the new default scope was not used");
    key(fieldInput(), "Escape");
    await waitFor(() => !results.isActive(win));
  } finally {
    await setSearch({ scope: "folder" });
    await waitFor(() => mainWindow.qolSearch.controller.manager.config?.scope === "folder");
  }
  await searchFor("from:alice");
  assert(scopeChip("folder").classList.contains("active"), "the default scope did not change back");
});

test("the header counts only mails that can be shown", async () => {
  await withRun(real => (w, q, opts, onProgress) =>
    real(w, q, opts, state => {
      const ghost = `${inbox.URI}#987654`;
      onProgress({ ...state, folderIds: new Set([...state.folderIds, ghost]), allIds: new Set([...state.allIds, ghost]) });
    }), async () => {
    await searchFor("from:alice");
  });
  assertEqual(shownKeys(), seededSet(1, 5));
  assertEqual(headerText(), `${label("results")} · 2`);
});

test("an empty hit list shows an empty search view", async () => {
  results.show(win, []);
  assert(results.isActive(win), "search not active");
  assertEqual(win.gDBView.rowCount, 0);
  results.end(win);
  await waitFor(() => win.gFolder?.URI === inbox.URI && !win.gViewWrapper.isSearch);
  assertEqual(win.gDBView.rowCount, inbox.getTotalMessages(false));
});

test("clicking the twisty of the selected folder keeps the search", async () => {
  await searchFor("from:alice");
  const twisty = win.folderTree.selectedRow.querySelector(".twisty");
  assert(twisty, "the folder row has no twisty");
  twisty.click();
  await sleep(200);
  assert(results.isActive(win), "the search ended");
  assert(chipRow(), "the chips are gone");
});

// Each rendered row of the list shows the mail of its index, not one drawn there before.
function drawn() {
  if (!win.gDBView?.rowCount || !win.threadTree.getRowAtIndex(0)) {
    return false;
  }
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    const row = win.threadTree.getRowAtIndex(i);
    if (row && !win.gViewWrapper.isGroupedByHeaderAtIndex(i) && !row.dataset.qolId?.startsWith(`${keyOf(win.gDBView.getMsgHdrAt(i))}#`)) {
      return false;
    }
  }
  return true;
}

test("shown and added hits are drawn as cards", async () => {
  results.show(win, [hdrs(inbox)[3], hdrs(inbox)[4]]);
  await waitFor(drawn);
  // Another hit set, as for a switch of the scope: the list keeps its size.
  results.show(win, [hdrs(inbox)[5], hdrs(inbox)[6]]);
  await waitFor(drawn);
  results.add(win, [hdrs(archive)[0]]);
  assertEqual(win.gDBView.rowCount, 3);
  await waitFor(drawn);
});

// Changes to the list and to folders while results show

test("the list stays responsive while it draws 5000 hits", async () => {
  await withBulkFolder(async () => {
    await searchFor("-from:nobody");
    let rowsWhenFired = null;
    setTimeout(() => (rowsWhenFired = win.gDBView.rowCount), 0);
    scopeChip("all").click();
    const total = await waitFor(() => win.gDBView.rowCount >= 5015 && !win.gViewWrapper.searching && win.gDBView.rowCount, 30000);
    assert(rowsWhenFired !== null && rowsWhenFired < total, `the timer ran with ${rowsWhenFired} of ${total} rows shown`);
    assertEqual(headerText(), `${label("results")} · ${total}`);
    await waitFor(drawn);
  });
});

// The mails of the list's rows without the group headers, all groups open.
function messageKeys() {
  if (win.gViewWrapper.showGroupedBySort) {
    win.gDBView.doCommand(Ci.nsMsgViewCommandType.expandAll);
  }
  const keys = [];
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    if (!win.gViewWrapper.isGroupedByHeaderAtIndex(i)) {
      keys.push(keyOf(win.gDBView.getMsgHdrAt(i)));
    }
  }
  return keys.sort();
}

// Waits until the list holds exactly `keys` and stays that way.
async function settlesOn(keys, ms = 5000) {
  const wanted = JSON.stringify([...keys].sort());
  await waitFor(() => JSON.stringify(messageKeys()) === wanted, ms);
  await sleep(300);
  assertEqual(messageKeys(), [...keys].sort());
  await waitFor(drawn);
}

// Every row opens the mail it shows: its URI leads to a mail of its own folder with the
// row's Message-ID.
function rowsOpenTheirMail() {
  const messenger = Cc["@mozilla.org/messenger;1"].createInstance(Ci.nsIMessenger);
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    if (win.gViewWrapper.isGroupedByHeaderAtIndex(i)) {
      continue;
    }
    const hdr = win.gDBView.getMsgHdrAt(i);
    const opened = messenger.msgHdrFromURI(win.gDBView.getURIForViewIndex(i));
    assert(opened && opened.messageId === hdr.messageId, `row ${i} opens ${opened?.messageId} instead of ${hdr.messageId}`);
    assert(hdr.folder.parent, `row ${i} shows a mail of a folder that is gone`);
    assertEqual(hdr.folder.msgDatabase.getMsgHdrForMessageID(hdr.messageId)?.messageKey, hdr.messageKey);
  }
}

// The custom terms the Search Messages and saved search dialogs offer for a folder:
// searchWidgets.js lists those available in the dialog's scope.
function offeredCustomTerms() {
  const scopes = [Ci.nsMsgSearchScope.offlineMail, Ci.nsMsgSearchScope.onlineManual, Ci.nsMsgSearchScope.localNews, Ci.nsMsgSearchScope.onlineMail];
  return MailServices.filters
    .getCustomTerms()
    .filter(term => scopes.some(scope => term.getAvailable(scope, null)))
    .map(term => term.id);
}

test("the search's own term is not offered in Thunderbird's search dialogs", async () => {
  const own = () => offeredCustomTerms().filter(id => id.startsWith("officebird"));
  assertEqual(own(), []);
  await searchFor("from:alice OR from:erin");
  assertEqual(own(), []);
  win.quickFilterBar._showFilterBar(true);
  try {
    win.document.getElementById("qfb-starred").click();
    await settlesOn(seededSet(7));
    assertEqual(own(), []);
  } finally {
    win.quickFilterBar._showFilterBar(false);
  }
  await settlesOn(seededSet(1, 5, 7));
  assertEqual(own(), []);
});

test("quick filter toggled while results show", async () => {
  // A starred mail in the hits' folder that is not a hit.
  const other = seededHdr(8);
  inbox.markMessagesFlagged([other], true);
  const starred = () => win.document.getElementById("qfb-starred");
  try {
    await searchFor("from:alice OR from:erin");
    assertEqual(shownKeys(), seededSet(1, 5, 7));
    win.quickFilterBar._showFilterBar(true);
    starred().click();
    await settlesOn(seededSet(7));
    assert(results.isActive(win), "the search ended");
    // The chips keep counting the search's hits.
    assert(scopeChip("folder").textContent.endsWith(" · 3"), `the chip reads ${scopeChip("folder").textContent}`);
    // Another scope with the filter still on.
    scopeChip("all").click();
    await settlesOn(seededSet(7));
    starred().click();
    await settlesOn(seededSet(1, 5, 7, 10, 13));
    rowsOpenTheirMail();
  } finally {
    win.quickFilterBar._showFilterBar(false);
    inbox.markMessagesFlagged([other], false);
  }
});

test("grouped by sort switched on while results show", async () => {
  await searchFor("from:alice OR from:carol");
  const numbers = [1, 3, 5];
  const hits = seededSet(...numbers);
  assertEqual(shownKeys(), hits);
  try {
    win.sortController.groupBySort();
    assert(win.gViewWrapper.showGroupedBySort, "not grouped");
    await settlesOn(hits);
    rowsOpenTheirMail();
    win.sortController.sortUnthreaded();
    assert(!win.gViewWrapper.showGroupedBySort, "still grouped");
    await settlesOn(hits);
    // View > Messages > Unread.
    win.SwitchView("cmd_viewUnreadMsgs");
    await settlesOn(seededSet(...numbers.filter(n => !seededHdr(n).isRead)));
    win.SwitchView("cmd_viewAllMsgs");
    await settlesOn(hits);
    assert(results.isActive(win), "the search ended");
  } finally {
    if (win.gViewWrapper?.showGroupedBySort) {
      win.sortController.sortUnthreaded();
    }
    if (win.gViewWrapper?.showUnreadOnly) {
      win.SwitchView("cmd_viewAllMsgs");
    }
  }
});

test("hits added to sorted results are drawn at their rows", async () => {
  results.show(win, [hdrs(inbox)[3], hdrs(inbox)[4]]);
  win.sortController.sortThreadPane("subjectCol");
  assertEqual(win.gViewWrapper.primarySortType, Ci.nsMsgViewSortType.bySubject);
  await waitFor(drawn);
  win.threadTree.selectedIndex = 1;
  const selected = keyOf(win.gDBView.hdrForFirstSelectedMessage);
  const more = [...hdrs(inbox).slice(5), ...hdrs(archive)];
  results.add(win, more);
  await settlesOn([hdrs(inbox)[3], hdrs(inbox)[4], ...more].map(keyOf));
  const subjects = [];
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    subjects.push(win.gDBView.getMsgHdrAt(i).mime2DecodedSubject);
  }
  assertEqual(subjects, [...subjects].sort((a, b) => a.localeCompare(b)));
  assertEqual(win.threadTree.selectedIndices.map(i => keyOf(win.gDBView.getMsgHdrAt(i))), [selected]);
  rowsOpenTheirMail();
});

// A local folder under Search Test with mails from alice; removed afterwards by its name
// from wherever it went.
async function withAliceFolder(name, count, fn) {
  const folder = testRoot.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder(name).QueryInterface(Ci.nsIMsgLocalMailFolder);
  for (let i = 0; i < count; i++) {
    folder.addMessage(
      [`From: Alice Example <alice@example.org>`, `Subject: ${name} ${i}`, `Date: Mon, 19 Oct 2026 1${i}:00:00 +0000`, `Message-ID: <${name.replace(/\W/g, "")}-${i}@example.org>`, ``, `Text ${i} ${"x".repeat(2000)}`, ``].join("\r\n")
    );
  }
  const trash = MailServices.accounts.localFoldersServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
  try {
    await fn(folder);
  } finally {
    // Deleting moves a folder to the trash first.
    for (const parent of [testRoot, trash, trash]) {
      for (const child of [...(parent?.subFolders ?? [])]) {
        if (child.name.startsWith(name)) {
          child.deleteSelf(null);
        }
      }
    }
  }
}

function aliceKeys(folder) {
  return hdrs(folder).map(keyOf);
}

test("deleting the folder shown before the search ends the search", async () => {
  await withAliceFolder("Search Gone", 1, async folder => {
    await openFolder(folder);
    await searchFor("from:alice");
    assertEqual(shownKeys(), aliceKeys(folder));
    scopeChip("all").click();
    await waitFor(() => win.gDBView?.rowCount === 5);
    const errors = await consoleErrors(async () => {
      folder.deleteSelf(null);
      await waitFor(() => !results.isActive(win));
      await waitFor(() => !chipRow() || chipRow().hidden);
      assert(!headerText().startsWith(label("results")), `the header reads ${headerText()}`);
      assert(!win.gDBView || win.gFolder, "a list without its folder");
      // The field and the folder pane work as before.
      await openFolder(inbox);
      await searchFor("from:bob");
      assertEqual(shownKeys(), seededSet(2, 6));
      key(fieldInput(), "Escape");
      await waitFor(() => !results.isActive(win));
      await openFolder(archive);
    });
    assertEqual(errors, []);
  });
});

test("renaming a folder that has hits keeps the search", async () => {
  await withAliceFolder("Search Named", 2, async folder => {
    await searchFor("from:alice");
    scopeChip("all").click();
    await settlesOn([...seededSet(1, 5, 10, 13), ...aliceKeys(folder)]);
    const errors = await consoleErrors(async () => {
      folder.rename("Search Named Again", null);
      const renamed = await waitFor(() => testRoot.getChildNamed("Search Named Again"));
      await settlesOn([...seededSet(1, 5, 10, 13), ...aliceKeys(renamed)]);
      assert(results.isActive(win), "the search ended");
      assertEqual(scopeChip("all").textContent, `${label("allMailboxes")} · 6`);
      rowsOpenTheirMail();
    });
    assertEqual(errors, []);
  });
});

test("compacting a folder that has hits keeps the search", async () => {
  await withAliceFolder("Search Compact", 4, async folder => {
    // Deleted mails leave space for the compaction to reclaim.
    folder.deleteMessages(hdrs(folder).slice(2), null, true, false, null, false);
    await searchFor("from:alice");
    scopeChip("all").click();
    await settlesOn([...seededSet(1, 5, 10, 13), ...aliceKeys(folder)]);
    const errors = await consoleErrors(async () => {
      await new Promise((resolve, reject) =>
        folder.compact({ OnStartRunningUrl() {}, OnStopRunningUrl: (url, status) => (Components.isSuccessCode(status) ? resolve() : reject(new Error(`compact failed: ${status}`))) }, null)
      );
      await settlesOn([...seededSet(1, 5, 10, 13), ...aliceKeys(folder)]);
      assert(results.isActive(win), "the search ended");
      rowsOpenTheirMail();
    });
    assertEqual(errors, []);
  });
});

// Message list integration (qol experiment)

let qolLib = null;
// The qol experiment's top-level functions, from the installed add-on's source.
function qol() {
  if (!qolLib) {
    const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
    const channel = NetUtil.newChannel({ uri: ext.rootURI.resolve("experiments/qol/implementation.js"), loadUsingSystemPrincipal: true });
    const stream = channel.open();
    let source;
    try {
      source = NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
    } finally {
      stream.close();
    }
    qolLib = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: "qol test" });
    Object.assign(qolLib, { ChromeUtils, Cc, Ci, Cu, Cr, Services });
    Cu.evalInSandbox(source, qolLib, "latest", "implementation.js", 1);
  }
  return qolLib;
}

function folderLabels() {
  const labels = [];
  for (let i = 0; i < win.gDBView.rowCount; i++) {
    const card = win.threadTree.getRowAtIndex(i);
    assert(card, `row ${i} is not rendered`);
    labels.push(card.querySelector(".qol-folder-label")?.textContent ?? null);
  }
  return labels;
}

test("search view is detected, virtual folder is not", async () => {
  const { VirtualFolderHelper } = ChromeUtils.importESModule("resource:///modules/VirtualFolderWrapper.sys.mjs");
  assertEqual(qol().isSearchView(win), false);
  results.show(win, hdrs(inbox).slice(0, 2));
  assertEqual(qol().isSearchView(win), true);
  results.end(win);
  const saved = VirtualFolderHelper.createNewVirtualFolder("Search Saved View", testRoot, [inbox, archive], "ALL", false).virtualFolder;
  try {
    await openFolder(saved);
    assertEqual(qol().isSearchView(win), false);
  } finally {
    await openFolder(inbox);
    saved.deleteSelf(null);
    MailServices.accounts.localFoldersServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash)?.getChildNamed("Search Saved View")?.deleteSelf(null);
  }
  assertEqual(qol().isSearchView(win), false);
});

test("cards in all-mailbox results show the folder", async () => {
  // A folder in the second account with the name of Search Test's Archive.
  const secondRoot = secondInbox.server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  const twin = secondRoot.createLocalSubfolder(archive.name).QueryInterface(Ci.nsIMsgLocalMailFolder);
  try {
    twin.addMessage(
      ["From: Ivan Probe <ivan@example.org>", "Subject: Zweites Archiv", "Date: Mon, 19 Oct 2026 12:00:00 +0000", "Message-ID: <search-twin@example.org>", "", "Text.", ""].join("\r\n")
    );
    results.show(win, [hdrs(inbox)[0], hdrs(archive)[0], hdrs(twin)[0]]);
    await waitFor(() => folderLabels().every(Boolean));
    // Search Test is a folder of Local Folders, so that is the account of its Archive.
    const name = archive.localizedName;
    assertEqual(folderLabels(), [inbox.localizedName, `${name} · ${archive.server.prettyName}`, `${name} · Search Second`]);
  } finally {
    results.end(win);
    twin.deleteSelf(null);
    secondRoot.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash)?.getChildNamed(archive.name)?.deleteSelf(null);
  }
});

test("single-folder results have no folder label", async () => {
  results.show(win, [hdrs(inbox)[0], hdrs(secondInbox)[0]]);
  await waitFor(() => folderLabels().every(Boolean));
  results.show(win, hdrs(inbox).slice(0, 3));
  await waitFor(() => win.gDBView.rowCount === 3);
  await sleep(100);
  assertEqual(folderLabels(), [null, null, null]);
});

test("hits from another folder added later label the cards already shown", async () => {
  results.show(win, hdrs(inbox).slice(0, 2));
  await waitFor(() => win.threadTree.getRowAtIndex(1)?.dataset.qolId);
  assertEqual(folderLabels(), [null, null]);
  results.add(win, [hdrs(archive)[0]]);
  await waitFor(() => folderLabels().every(Boolean));
  assertEqual(folderLabels(), [inbox.localizedName, inbox.localizedName, archive.localizedName]);
});

test("expanding groups in results does not write folder properties", async () => {
  const info = () => inbox.msgDatabase.dBFolderInfo.getCharProperty("officebirdCollapsedGroups");
  const before = info();
  const hits = [...hdrs(inbox), ...hdrs(archive)];
  results.show(win, hits);
  win.gViewWrapper.sort(Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending);
  win.gViewWrapper.showGroupedBySort = true;
  // Changing the view re-creates it empty; showing the hits again feeds them in.
  results.show(win, hits);
  assert(win.gViewWrapper.showGroupedBySort && win.gViewWrapper.isGroupedByHeaderAtIndex(0), "results are not grouped");
  if (!win.gDBView.isContainerOpen(0)) {
    win.threadTree.expandRowAtIndex(0);
  }
  win.threadTree.collapseRowAtIndex(0);
  win.threadTree.expandRowAtIndex(0);
  win.threadTree.collapseRowAtIndex(0);
  results.end(win);
  await waitFor(() => win.gFolder?.URI === inbox.URI && !win.gViewWrapper.isSearch);
  assertEqual(info(), before);
});

// Update notice (qol experiment)

const UPDATE_NOTICE = "officebird-update";

function updateNotice(win = mainWindow) {
  return win.specialTabs.msgNotificationBar.getNotificationWithValue(UPDATE_NOTICE);
}

function removeUpdateNotices() {
  for (const win of Services.wm.getEnumerator("mail:3pane")) {
    const notification = updateNotice(win);
    if (notification) {
      win.specialTabs.msgNotificationBar.removeNotification(notification, true);
    }
  }
}

// The bar's texts in Thunderbird's UI language, from the installed add-on.
function updateTexts(version) {
  const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: "update notice test" });
  Cu.evalInSandbox(readAddonFile("experiments/qol/updatenotice.js"), sandbox, "latest", "updatenotice.js", 1);
  const lib = sandbox.qolUpdateNotice;
  return lib.texts(lib.pickLanguage(Services.locale.appLocaleAsBCP47), version);
}

function shownNotice(win = mainWindow) {
  const notification = updateNotice(win);
  return notification && {
    message: notification.messageText.textContent.trim(),
    buttons: [...notification.buttonContainer.children].map(button => button.getAttribute("label")),
  };
}

// Fires the add-on's runtime.onUpdateAvailable the way the add-on manager does.
function announceUpdate(version) {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const before = ext.upgrade;
  AddonManagerPrivate.getUpgradeListener(ADDON_ID)({ version, install() {} });
  ext.upgrade = before;
}

// The installed add-on with another version in its manifest.
function xpiWithVersion(version) {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const installed = ext.rootURI.QueryInterface(Ci.nsIJARURI).JARFile.QueryInterface(Ci.nsIFileURL).file;
  const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
  file.append("officebird-update-test.xpi");
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  file.remove(false);
  installed.copyTo(file.parent, file.leafName);
  const manifest = JSON.parse(readAddonFile("manifest.json"));
  manifest.version = version;
  const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  writer.open(file, 0x04);
  try {
    writer.removeEntry("manifest.json", false);
    const input = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
    input.setUTF8Data(JSON.stringify(manifest));
    writer.addEntryStream("manifest.json", Date.now() * 1000, Ci.nsIZipWriter.COMPRESSION_DEFAULT, input, false);
  } finally {
    writer.close();
  }
  return file;
}

function readAddonFile(path) {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const channel = NetUtil.newChannel({ uri: ext.rootURI.resolve(path), loadUsingSystemPrincipal: true });
  const stream = channel.open();
  try {
    return NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
  } finally {
    stream.close();
  }
}

test("an update waits for the restart and the bar says so", async () => {
  assert(AddonManagerPrivate.hasUpgradeListener(ADDON_ID), "no runtime.onUpdateAvailable listener");
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const version = (await AddonManager.getAddonByID(ADDON_ID)).version;
  const upgradeBefore = ext.upgrade;
  const file = xpiWithVersion("99.0.0");
  let install = null;
  try {
    install = await AddonManager.getInstallForFile(file);
    const postponed = new Promise(resolve => install.addListener({ onInstallPostponed: resolve }));
    install.install();
    await postponed;
    assertEqual(install.state, AddonManager.STATE_POSTPONED);
    await waitFor(() => shownNotice(), 5000);
    assertEqual(shownNotice(), { message: updateTexts("99.0.0").message, buttons: [updateTexts("99.0.0").restart] });
    assertEqual((await AddonManager.getAddonByID(ADDON_ID)).version, version);
    assert(WebExtensionPolicy.getByID(ADDON_ID).extension === ext, "the running add-on was replaced");
    assertEqual(ext.version, version);
  } finally {
    if (install?.state === AddonManager.STATE_POSTPONED) {
      install.cancel();
    }
    ext.upgrade = upgradeBefore;
    file.exists() && file.remove(false);
    removeUpdateNotices();
  }
  assertEqual((await AddonManager.getAddonByID(ADDON_ID)).version, version);
});

test("the update bar closes, follows new main windows and shows the newest version", async () => {
  let second = null;
  try {
    announceUpdate("9.9.1");
    await waitFor(() => shownNotice()?.message === updateTexts("9.9.1").message);
    announceUpdate("9.9.2");
    await waitFor(() => shownNotice()?.message === updateTexts("9.9.2").message);
    assertEqual(mainWindow.specialTabs.msgNotificationBar.allNotifications.filter(n => n.getAttribute("value") === UPDATE_NOTICE).length, 1);

    updateNotice().shadowRoot.querySelector(".close").click();
    await waitFor(() => !updateNotice());

    second = Services.ww.openWindow(null, "chrome://messenger/content/messenger.xhtml", "_blank", "chrome,dialog=no,all", null);
    await waitFor(() => shownNotice(second)?.message === updateTexts("9.9.2").message, 15000);
    assert(!updateNotice(), "the closed bar came back");

    announceUpdate("9.9.3");
    await waitFor(() => shownNotice()?.message === updateTexts("9.9.3").message);
    await waitFor(() => shownNotice(second)?.message === updateTexts("9.9.3").message);
  } finally {
    second?.close();
    removeUpdateNotices();
  }
});

test("Restart now restarts Thunderbird the normal way", async () => {
  const original = MailUtils.restartApplication;
  const calls = [];
  // Safety net: should the fake not be used, the restart is refused.
  const veto = {
    observe(subject, topic, data) {
      calls.push(`requested:${data}`);
      subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
    },
  };
  Services.obs.addObserver(veto, "quit-application-requested");
  MailUtils.restartApplication = () => calls.push("restart");
  try {
    announceUpdate("9.9.4");
    await waitFor(() => shownNotice()?.message === updateTexts("9.9.4").message);
    [...updateNotice().buttonContainer.children][0].click();
    await waitFor(() => calls.length);
    await sleep(100);
    assertEqual(calls, ["restart"]);
    assert(updateNotice(), "the bar stays until Thunderbird restarts");
  } finally {
    MailUtils.restartApplication = original;
    Services.obs.removeObserver(veto, "quit-application-requested");
    removeUpdateNotices();
  }
});

// Runner

try {
  await setSearch({ enabled: true, scope: "folder" });
  ({ qolSearchResults: results, qolSearchQuery: query, qolSearchEngine: engine } = libs());
} catch (e) {
  loadError = e;
}

const result = { passed: 0, failed: [] };
for (const { name, fn } of tests) {
  try {
    if (loadError) {
      throw loadError;
    }
    mainWindow.gTabmail.switchToTab(0);
    mainWindow.qolSearch?.end();
    mainWindow.qolSearch?.controller.panel?.panel.hidePopup();
    results.end(win);
    await openFolder(inbox);
    await fn();
    result.passed++;
  } catch (e) {
    result.failed.push({ name, error: String(e?.message ?? e) });
  }
}
results?.end(win);
return result;
