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
async function loadScript(path) {
  const file = Services.dirsvc.get("ProfD", Ci.nsIFile).parent;
  for (const part of path.split("/")) {
    file.append(part);
  }
  const source = await IOUtils.readUTF8(file.path);
  const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxName: `test:${path}` });
  Cu.evalInSandbox(source, sandbox, "latest", path, 1);
  return sandbox;
}

let results = null;
let loadError = null;
try {
  results = (await loadScript("experiments/search/results.js")).qolSearchResults;
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
