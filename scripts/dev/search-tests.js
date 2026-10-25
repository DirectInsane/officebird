// Search integration suite (test-search.sh); returns { passed, failed: [{ name, error }] }.
// Needs the data from search-setup.js.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

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

// The profile lives in the repository (.dev-profile-search), so the sources are next to it.
// Loaded into a sandbox like the experiments load their scripts.
// Scripts loaded together share one sandbox, so later ones see the globals of earlier ones.
async function loadScripts(...paths) {
  const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: `test:${paths.join(",")}` });
  for (const path of paths) {
    const file = Services.dirsvc.get("ProfD", Ci.nsIFile).parent;
    for (const part of path.split("/")) {
      file.append(part);
    }
    const source = await IOUtils.readUTF8(file.path);
    Cu.evalInSandbox(source, sandbox, "latest", path, 1);
  }
  return sandbox;
}

let results = null;
let query = null;
let engine = null;
let loadError = null;
try {
  results = (await loadScripts("experiments/search/results.js")).qolSearchResults;
  const searchSandbox = await loadScripts(
    "experiments/search/query.js",
    "experiments/search/sets.js",
    "experiments/search/terms.js",
    "experiments/search/engine.js",
  );
  query = searchSandbox.qolSearchQuery;
  engine = searchSandbox.qolSearchEngine;
} catch (e) {
  loadError = e;
}

const mainWindow = Services.wm.getMostRecentWindow("mail:3pane");
mainWindow.gTabmail.switchToTab(0);
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
  await run.done;
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

test("before excludes and after includes the right days", async () => {
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
    assertEqual(sortedIds(after.last.allIds), [ids[3]]);
    const day = await search('in:"Search Dates" after:9.10.2026 before:11.10.2026');
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
    let fired = false;
    setTimeout(() => (fired = true), 0);
    const run = engine.run(win, query.parse("-from:nobody"), { current: inbox, scopeDefault: "all" }, () => {});
    let doneFirst = false;
    await run.done.then(() => (doneFirst = !fired));
    assert(!doneFirst, "the search finished before a timer could run");
    const { last } = await search("-from:nobody", { scopeDefault: "all" });
    assert(last.allIds.size >= 5015, `only ${last.allIds.size} mails`);
    assertEqual(last.folderIds.size, inbox.getTotalMessages(false));
  });
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

// Runner

const result = { passed: 0, failed: [] };
for (const { name, fn } of tests) {
  try {
    if (loadError) {
      throw loadError;
    }
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
