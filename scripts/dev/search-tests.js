// Search integration suite (test-search.sh); returns { passed, failed: [{ name, error }] }.
// Needs the data from search-setup.js.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");

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
function seeded(n) {
  for (const folder of seededFolders) {
    const hdr = folder.msgDatabase.getMsgHdrForMessageID(`search-${n}@example.org`);
    if (hdr) {
      return keyOf(hdr);
    }
  }
  throw new Error(`seeded mail ${n} not found`);
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

test("tag names match case-insensitively and unknown tags match nothing", async () => {
  const name = MailServices.tags.getTagForKey("$label1");
  const { last } = await search(`tag:"${name.toUpperCase()}"`);
  assertEqual(sortedIds(last.allIds), seededSet(6));
  const unknown = await search("tag:nosuchtag");
  assertEqual(unknown.last.allIds.size, 0);
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

test("negated-only query on all mailboxes yields to the UI", async () => {
  await withTempFolder("Search Bulk", async folder => {
    const db = folder.msgDatabase;
    for (let key = 1; key <= 5000; key++) {
      const hdr = db.createNewHdrWithSpecificMsgKey(key);
      hdr.author = "Bulk Sender <bulk@example.org>";
      hdr.subject = `Bulk ${key}`;
      hdr.date = Date.UTC(2026, 0, 1) * 1000;
      db.addNewHdrToDB(hdr, true);
    }
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
  const panel = doc.getElementById("qol-search-panel");
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
  assert(row(panel, "from").querySelector(".qol-row-or:not([hidden])"), "the From row has no or marker");
  panel.querySelector(".qol-panel-search").click();
  assertEqual(fieldInput().value, text);
  await waitFor(() => results.isActive(win) && !chipRow().querySelector(".qol-searching:not([hidden])"), 10000);
  assertEqual(shownKeys(), seededSet(1, 2, 5));
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
    mainWindow.qolSearch?.end();
    doc.getElementById("qol-search-panel")?.hidePopup();
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
