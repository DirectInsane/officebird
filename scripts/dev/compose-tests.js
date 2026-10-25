// Compose ribbon integration suite (test-compose.sh); returns { passed, failed: [{ name, error }] }.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const ADDON_ID = "officebird@directinsane.github.io";
// Must match EMAIL in compose-setup.js.
const IDENTITY_EMAIL = "tester@example.org";
const OPEN_MS = 10000;
const RELOAD_MS = 10000;

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

function composeWindows() {
  return [...Services.wm.getEnumerator("msgcompose")].filter(w => !w.closed);
}

const opened = new Set();
const spies = new Map();

async function openCompose({ html, plainText = false, type = Ci.nsIMsgCompType.New }) {
  const before = new Set(composeWindows());
  const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
  const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
  fields.body = html;
  params.composeFields = fields;
  params.type = type;
  params.format = plainText ? Ci.nsIMsgCompFormat.PlainText : Ci.nsIMsgCompFormat.HTML;
  params.identity = MailServices.accounts.allIdentities.find(identity => identity.email === IDENTITY_EMAIL);
  assert(params.identity, `no identity ${IDENTITY_EMAIL}; run compose-setup.js`);
  MailServices.compose.OpenComposeWindowWithParams(null, params);
  const win = await waitFor(() => composeWindows().find(w => !before.has(w)), OPEN_MS);
  opened.add(win);
  await waitFor(() => win.composeEditorReady, OPEN_MS);
  await waitFor(() => win.qolCompose, OPEN_MS);
  // Activate the window before a test opens a menu or starts a preview:
  // activating it later closes its menus and ends its preview.
  win.focus();
  await waitFor(() => Services.focus.activeWindow === win, OPEN_MS);
  return win;
}

function closeCompose(win) {
  if (spies.has(win)) {
    win.goDoCommand = spies.get(win);
    spies.delete(win);
  }
  opened.delete(win);
  if (win.closed) {
    return;
  }
  win.gContentChanged = false;
  if (win.gMsgCompose) {
    win.gMsgCompose.bodyModified = false;
  }
  win.close();
}

function editorDocument(win) {
  return win.GetCurrentEditor().document;
}

function editorHTML(win) {
  return editorDocument(win).body.innerHTML.replace(/>\s+</g, "><").trim();
}

function select(win, text, from = 0, to = text.length) {
  const doc = editorDocument(win);
  // Thunderbird's commands (cmd_undo) go to the focused element.
  if (win.document.activeElement !== win.GetCurrentEditorElement()) {
    win.GetCurrentEditorElement().focus();
  }
  const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && !node.data.includes(text)) {
    // keep looking
  }
  assert(node, `text not found in the editor: ${text}`);
  const start = node.data.indexOf(text);
  const range = doc.createRange();
  range.setStart(node, start + from);
  range.setEnd(node, start + to);
  const selection = doc.defaultView.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

async function storage() {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  return ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext));
}

async function setRibbon(on) {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const db = await storage();
  const { settings = {} } = await db.get(["settings"]);
  const next = { ...settings, compose: { ...(settings.compose || {}), ribbon: on } };
  const changes = await db.set({ settings: next });
  if (changes) {
    ExtensionStorageIDB.notifyListeners(ext.id, changes);
  }
  await waitFor(() => composeWindows().every(w => !w.composeEditorReady || Boolean(w.qolCompose) === on));
}

async function reloadAddon() {
  const before = new Map(composeWindows().map(w => [w, w.qolCompose]));
  const addon = await AddonManager.getAddonByID(ADDON_ID);
  await addon.disable();
  await addon.enable();
  await waitFor(() => [...before].every(([w, old]) => w.qolCompose && w.qolCompose !== old), RELOAD_MS);
}

async function lastReportedState() {
  const db = await storage();
  const { composeState } = await db.get(["composeState"]);
  return composeState;
}

async function waitForState(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const state = await lastReportedState();
    if (state && check(state)) {
      return state;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for the reported state, last: ${JSON.stringify(state)}`);
    }
    await sleep(25);
  }
}

// Must match the compose state defaults in background/settings.js.
const DEFAULT_COMPOSE_STATE = { collapsed: false, recentFonts: [], lastColors: { text: "#c00000", highlight: "#ffff00" } };

// Restarts the add-on: the background and the experiment each keep a copy of the state.
async function resetComposeState() {
  const db = await storage();
  await db.set({ composeState: DEFAULT_COMPOSE_STATE });
  const addon = await AddonManager.getAddonByID(ADDON_ID);
  await addon.disable();
  await addon.enable();
  // The experiment is initialized once a compose window gets its ribbon.
  const win = await openCompose({ html: "<p>x</p>" });
  closeCompose(win);
  assertEqual(await lastReportedState(), DEFAULT_COMPOSE_STATE);
}

function spyCommands(win) {
  const calls = [];
  if (!spies.has(win)) {
    spies.set(win, win.goDoCommand);
  }
  win.goDoCommand = command => calls.push(command);
  return calls;
}

// A new mail has Cut, Copy and Paste disabled, so view tests enable every control.
function fakeCommands(win, run) {
  const { view, commands } = win.qolCompose;
  commands.destroy();
  for (const button of view.root.querySelectorAll("[data-control-id]")) {
    view.setEnabled(button.dataset.controlId, true);
  }
  win.qolCompose.commands = { run, destroy() {} };
}

// A trusted key press in the focused element.
function pressKey(win, key, code = key) {
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  assert(tip.beginInputTransactionForTests(win), "no key input transaction");
  const event = new win.KeyboardEvent("", { key, code, keyCode: key === " " ? 32 : 0 });
  tip.keydown(event);
  tip.keyup(event);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// Tests

test("ribbon attaches and hides Thunderbird's bars", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  assert(win.document.documentElement.hasAttribute("data-qol-ribbon"));
  assert(win.document.getElementById("qol-ribbon"));
  assert(win.getComputedStyle(win.document.getElementById("composeToolbar2")).display === "none");
  assert(win.getComputedStyle(win.document.getElementById("FormatToolbar")).display === "none");
  closeCompose(win);
});

test("ribbon off restores the bars without reopening", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  await setRibbon(false);
  assert(!win.document.getElementById("qol-ribbon"));
  assert(win.getComputedStyle(win.document.getElementById("composeToolbar2")).display !== "none");
  await setRibbon(true);
  assert(win.document.querySelectorAll("#qol-ribbon").length === 1);
  closeCompose(win);
});

test("exactly one ribbon after compose-window-init and after an add-on reload", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  win.document.getElementById("msgcomposeWindow").dispatchEvent(new win.Event("compose-window-init"));
  await reloadAddon();
  assert(win.document.querySelectorAll("#qol-ribbon").length === 1);
  closeCompose(win);
});

test("quick access bar and tabs render in order", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  assert(["qa-send", "qa-save", "qa-attach"].every(id => v.control(id)));
  assert([...v.root.querySelectorAll('[role="tab"]')].map(t => t.dataset.tab).join() === "message,format");
  assert(v.control("bold").querySelector("img"));
  assert(v.control("f-strike").textContent.includes("S"));
  closeCompose(win);
});

test("tooltips name the shortcuts as the platform writes them", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const tip = id => win.qolCompose.view.control(id).getAttribute("title");
  const mac = AppConstants.platform === "macosx";
  // The painter's shortcut is Control on every platform, not Accel.
  const expected = mac
    ? { "qa-send": "(⌘↩)", bold: "(⌘B)", "f-italic": "(⌘I)", underline: "(⌘U)", painter: "(⌃⇧C)", contacts: "(F9)" }
    : { "qa-send": "(Ctrl+Enter)", bold: "(Ctrl+B)", "f-italic": "(Ctrl+I)", underline: "(Ctrl+U)", painter: "(Ctrl+Shift+C)", contacts: "(F9)" };
  for (const [id, text] of Object.entries(expected)) {
    assert(tip(id).endsWith(` ${text}`), `${id}: ${tip(id)}`);
  }
  closeCompose(win);
});

test("collapse hides the ribbon, keeps quick access, and is reported", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  v.root.querySelector('[data-tab="format"]').dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
  assert(v.collapsed && v.control("qa-send").checkVisibility());
  assert(!v.root.querySelector('[role="tabpanel"]').checkVisibility());
  await waitForState(state => state.collapsed === true);
  v.setCollapsed(false);
  closeCompose(win);
});

test("F6 cycle includes the ribbon first", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  assert(win.gFocusAreas[0].root === win.qolCompose.view.root);
  closeCompose(win);
});

test("Thunderbird icons load", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const img = win.qolCompose.view.control("bold").querySelector("img");
  await img.decode();
  assert(img.naturalWidth > 0);
  closeCompose(win);
});

test("keyboard moves through the ribbon and Esc returns to the editor", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  const doc = win.document;
  const tab = id => v.root.querySelector(`[data-tab="${id}"][role="tab"]`);
  const calls = [];
  fakeCommands(win, id => calls.push(id));
  assert(win.gFocusAreas[0].focus(win.gFocusAreas[0].root));
  assert(doc.activeElement === tab("message"), "F6 focuses the selected tab");
  pressKey(win, "ArrowRight");
  assert(doc.activeElement === tab("format"), "Right moves along the tab row");
  pressKey(win, "ArrowLeft");
  pressKey(win, "ArrowDown");
  assert(doc.activeElement === v.control("paste"), "Down enters the panel");
  pressKey(win, "ArrowRight"); // the arrow of Paste
  pressKey(win, "ArrowRight");
  assert(doc.activeElement === v.control("cut"), "Right moves between controls");
  pressKey(win, "Enter");
  pressKey(win, " ", "Space");
  assertEqual(calls, ["cut", "cut"]);
  pressKey(win, "ArrowUp");
  assert(doc.activeElement === tab("message"), "Up returns to the tab row");
  pressKey(win, "Escape");
  assert(doc.activeElement === win.GetCurrentEditorElement(), "Esc focuses the editor");
  closeCompose(win);
});

test("collapsed ribbon opens over the mail and closes after an action, Esc or a click outside", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  fakeCommands(win, () => {});
  const tab = v.root.querySelector('[data-tab="format"][role="tab"]');
  const panel = v.root.querySelector('[role="tabpanel"][data-tab="format"]');
  v.setCollapsed(true);
  tab.click();
  assert(panel.checkVisibility(), "a tab opens its panel");
  const box = panel.getBoundingClientRect();
  assert(v.root.contains(win.document.elementFromPoint(box.x + box.width / 2, box.bottom - 4)), "panel lies over the headers");
  v.control("f-bold").click();
  await waitFor(() => !panel.checkVisibility());
  tab.click();
  v.control("f-bold").focus();
  pressKey(win, "Escape");
  assert(!panel.checkVisibility(), "Esc closes it");
  tab.click();
  win.document.getElementById("msgSubject").dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
  assert(!panel.checkVisibility(), "a click outside closes it");
  assert(v.collapsed);
  v.setCollapsed(false);
  closeCompose(win);
});

test("collapsed ribbon closes when the focus leaves it by keyboard", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  const doc = win.document;
  const tab = v.root.querySelector('[data-tab="format"][role="tab"]');
  const panel = v.root.querySelector('[role="tabpanel"][data-tab="format"]');
  v.setCollapsed(true);
  tab.focus();
  pressKey(win, "ArrowDown");
  assert(panel.checkVisibility() && panel.contains(doc.activeElement), "Down opens the panel");
  pressKey(win, "Tab");
  assert(!v.root.contains(doc.activeElement), "Tab leaves the ribbon");
  assert(!panel.checkVisibility(), "Tab out closes it");
  tab.focus();
  pressKey(win, "ArrowDown");
  assert(panel.checkVisibility(), "Down opens it again");
  pressKey(win, "F6");
  assert(!v.root.contains(doc.activeElement), "F6 leaves the ribbon");
  assert(!panel.checkVisibility(), "F6 out closes it");
  v.setCollapsed(false);
  closeCompose(win);
});

test("collapsed ribbon closes on a click into the mail", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const panel = v.root.querySelector('[role="tabpanel"][data-tab="format"]');
  v.setCollapsed(true);
  v.root.querySelector('[data-tab="format"][role="tab"]').click();
  assert(panel.checkVisibility());
  // A mousedown on the text of the mail: it starts in the editor's own
  // document and must still reach the ribbon's window listener.
  const paragraph = editorDocument(win).body.firstElementChild;
  paragraph.dispatchEvent(new paragraph.ownerDocument.defaultView.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert(!panel.checkVisibility(), "a click into the mail closes it");
  v.setCollapsed(false);
  closeCompose(win);
});

test("split menus of the ribbon draw their icons in the text color", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  win.goSetCommandEnabled("cmd_sendButton", true); // a new mail without recipients can't be sent
  await waitFor(() => !v.root.querySelector('[data-arrow-for="qa-send"]').disabled);
  v.root.querySelector('[data-arrow-for="qa-send"]').click();
  const popup = v.root.querySelector("menupopup.qol-menu");
  await waitFor(() => popup.state === "open");
  const item = popup.querySelector('menuitem[data-menu-item="qa-send-later"]');
  const icon = item.querySelector(".menu-icon");
  // context-fill icons need -moz-context-properties (chrome-only) and a fill.
  assert(InspectorUtils.getMatchingCSSRules(icon).some(r => r.cssText.includes("-moz-context-properties")), "context properties");
  assertEqual(win.getComputedStyle(icon).fill, win.getComputedStyle(item).color);
  popup.hidePopup();
  closeCompose(win);
});

test("quick access and check controls run Thunderbird's commands", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const calls = spyCommands(win);
  // A new mail has Send, Cut, Copy and Paste disabled; enable them as Thunderbird would.
  for (const command of ["cmd_sendButton", "cmd_cut", "cmd_copy", "cmd_paste"]) {
    win.goSetCommandEnabled(command, true);
  }
  await waitFor(() => ["qa-send", "cut", "copy", "paste"].every(id => !win.qolCompose.view.control(id).disabled));
  for (const id of ["qa-send", "qa-save", "qa-attach", "cut", "copy", "paste", "spelling"]) {
    win.qolCompose.view.control(id).click();
  }
  win.qolCompose.commands.run("qa-send", { menuItem: "qa-send-later" });
  win.qolCompose.commands.run("paste", { menuItem: "paste-text" });
  assert(calls.join() === "cmd_sendButton,cmd_saveDefault,cmd_attachFile,cmd_cut,cmd_copy,cmd_paste,cmd_spelling,cmd_sendLater,cmd_pasteNoFormatting");
  closeCompose(win);
});

test("security opens Thunderbird's encryption menu at the ribbon", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  win.qolCompose.view.control("security").click();
  const popup = win.document.getElementById("encryptionToolbarMenu");
  await waitFor(() => popup.state === "open");
  popup.hidePopup();
  closeCompose(win);
});

test("Insert opens Thunderbird's Insert menu at the ribbon, from its button and its arrow", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  const calls = spyCommands(win);
  const popup = win.document.getElementById("InsertPopup");
  select(win, "x");   // Thunderbird enables Insert for the focused mail
  for (const part of [v.control("insert"), v.root.querySelector('[data-arrow-for="insert"]')]) {
    await waitFor(() => !part.disabled);
    part.click();
    await waitFor(() => popup.state === "open");
    const a = part.getBoundingClientRect();
    const p = popup.getBoundingClientRect();
    assert(Math.abs(p.top - a.bottom) < 4, "the menu opens below the ribbon's control");
    assert(popup.querySelector("#InsertImageItem") && popup.querySelector("#InsertTableItem"));
    popup.hidePopup();
    await waitFor(() => popup.state === "closed");
  }
  assertEqual(calls, []);
  closeCompose(win);
});

test("Insert from the keyboard: Thunderbird's entries act on the mail", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const popup = win.document.getElementById("InsertPopup");
  select(win, "world", 5, 5);
  // F6 from the mail: Insert stays enabled although Thunderbird disables
  // its own button for the ribbon's focus.
  assert(await focusRibbonControl(win, "insert") === v.control("insert"), "the focus reaches Insert");
  pressKey(win, "Enter");
  await waitFor(() => popup.state === "open");
  popup.activateItem(popup.querySelector("#InsertHRuleItem"));
  await waitFor(() => popup.state === "closed");
  await waitFor(() => editorHTML(win).includes("<hr"));
  assert(win.document.activeElement === win.GetCurrentEditorElement(), "the focus is back in the mail");
  closeCompose(win);
});

test("Insert is enabled exactly when Thunderbird's own Insert button is", async () => {
  const html = await openCompose({ html: "<p>x</p>" });
  const button = html.document.getElementById("InsertPopupButton");
  const insert = html.qolCompose.view.control("insert");
  // Thunderbird enables its Insert button (through cmd_renderedHTMLEnabler,
  // which it observes) while the focus is in an HTML mail.
  select(html, "x");
  await waitFor(() => !button.hasAttribute("disabled") && !insert.disabled);
  html.goSetCommandEnabled("cmd_renderedHTMLEnabler", false);
  await waitFor(() => button.hasAttribute("disabled") && insert.disabled);
  html.goSetCommandEnabled("cmd_renderedHTMLEnabler", true);
  await waitFor(() => !button.hasAttribute("disabled") && !insert.disabled);
  closeCompose(html);
  // Plain-text mail: Thunderbird leaves its hidden Insert button enabled, and so
  // does the ribbon, also from the keyboard; Contacts isn't formatting either.
  const plain = await openCompose({ html: "x", plainText: true });
  const plainInsert = plain.qolCompose.view.control("insert");
  select(plain, "x");
  await sleep(100);
  assert(!plain.document.getElementById("InsertPopupButton").hasAttribute("disabled"), "Thunderbird's Insert button is enabled");
  assert(!plainInsert.disabled && !plain.qolCompose.view.control("contacts").disabled, "Insert and Contacts are enabled");
  plain.gFocusAreas[0].focus(plain.gFocusAreas[0].root);
  await sleep(100);
  assert(!plainInsert.disabled, "Insert stays enabled while the ribbon has the focus");
  closeCompose(plain);
});

test("Contacts runs Thunderbird's contacts sidebar toggle", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  const splitter = win.document.getElementById("contactsSplitter");
  // Thunderbird's F9 key runs toggleContactsSidebar(); the spy records it.
  const toggle = win.toggleContactsSidebar;
  const calls = [];
  win.toggleContactsSidebar = () => calls.push("toggleContactsSidebar");
  try {
    v.control("contacts").click();
  } finally {
    win.toggleContactsSidebar = toggle;
  }
  assertEqual(calls, ["toggleContactsSidebar"]);
  assert(splitter.isCollapsed, "the sidebar starts hidden");
  v.control("contacts").click();
  await waitFor(() => !splitter.isCollapsed);
  v.control("contacts").click();
  await waitFor(() => splitter.isCollapsed);
  closeCompose(win);
});

test("disabled Thunderbird command disables the control", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  win.document.getElementById("cmd_sendButton").setAttribute("disabled", "true");
  await waitFor(() => win.qolCompose.view.control("qa-send").disabled);
  win.document.getElementById("cmd_sendButton").removeAttribute("disabled");
  closeCompose(win);
});

test("a Thunderbird command's state reaches its control both ways", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const v = win.qolCompose.view;
  const arrow = v.root.querySelector('[data-arrow-for="qa-save"]');
  assert(!v.control("qa-save").disabled && !arrow.disabled, "Save starts enabled");
  win.goSetCommandEnabled("cmd_saveDefault", false);
  await waitFor(() => v.control("qa-save").disabled && arrow.disabled);
  win.goSetCommandEnabled("cmd_saveDefault", true);
  await waitFor(() => !v.control("qa-save").disabled && !arrow.disabled);
  closeCompose(win);
});

test("split arrows open Thunderbird's menus at the arrow; detach puts the menus back", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const doc = win.document;
  const calls = spyCommands(win);
  const menus = [
    ["qa-save", "button-savePopup", "button-save"],
    ["qa-attach", "button-attachPopup", "button-attach"],
    ["spelling", "languageMenuList", "spellingButton"],
  ];
  for (const [id, popupId] of menus) {
    const arrow = win.qolCompose.view.root.querySelector(`[data-arrow-for="${id}"]`);
    arrow.click();
    const popup = doc.getElementById(popupId);
    await waitFor(() => popup.state === "open");
    const a = arrow.getBoundingClientRect();
    const p = popup.getBoundingClientRect();
    assert(Math.abs(p.left - a.left) < 4 && Math.abs(p.top - a.bottom) < 4, `${popupId} opens below the arrow`);
    popup.hidePopup();
    await waitFor(() => popup.state === "closed");
  }
  assertEqual(calls, []); // an arrow never runs the main command
  await setRibbon(false);
  for (const [, popupId, hostId] of [...menus, [null, "encryptionToolbarMenu", "button-encryption-options"], [null, "InsertPopup", "InsertPopupButton"]]) {
    assertEqual(doc.getElementById(popupId).parentNode.id, hostId);
  }
  await setRibbon(true);
  closeCompose(win);
});

test("a missing Thunderbird menu or command disables only its control", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const doc = win.document;
  await setRibbon(false);
  const removed = ["button-savePopup", "encryptionToolbarMenu", "cmd_attachFile"].map(id => {
    const node = doc.getElementById(id);
    const place = [node, node.parentNode, node.nextSibling];
    node.remove();
    return place;
  });
  try {
    await setRibbon(true);
    const v = win.qolCompose.view;
    const arrow = id => v.root.querySelector(`[data-arrow-for="${id}"]`);
    assert(!v.control("qa-save").disabled && arrow("qa-save").disabled, "no Save menu: only the arrow is disabled");
    assert(v.control("security").disabled, "no encryption menu: Security is disabled");
    assert(v.control("qa-attach").disabled && arrow("qa-attach").disabled && v.control("attach").disabled, "no attach command");
    assert(!v.control("spelling").disabled && !arrow("spelling").disabled, "other controls stay enabled");
  } finally {
    for (const [node, parent, next] of removed) {
      parent.insertBefore(node, next);
    }
  }
  closeCompose(win);
});

// A sandbox without Xrays, so a test can hand create() its own view and make
// DOM methods fail.
function loadCommandsForTest() {
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { wantXrays: false, sandboxName: "compose-tests" });
  for (const path of ["experiments/compose/definition.js", "experiments/compose/commands.js"]) {
    const channel = NetUtil.newChannel({ uri: ext.rootURI.resolve(path), loadUsingSystemPrincipal: true });
    const stream = channel.open();
    try {
      Cu.evalInSandbox(NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" }), sandbox, "latest", path, 1);
    } finally {
      stream.close();
    }
  }
  return { create: sandbox.qolComposeCommands.create, definition: sandbox.qolRibbonDefinition.DEFINITION };
}

const THUNDERBIRD_MENUS = [
  ["button-savePopup", "button-save"],
  ["button-attachPopup", "button-attach"],
  ["InsertPopup", "InsertPopupButton"],
  ["languageMenuList", "spellingButton"],
  ["encryptionToolbarMenu", "button-encryption-options"],
];

function assertMenusAtHome(doc) {
  for (const [popupId, hostId] of THUNDERBIRD_MENUS) {
    assertEqual([popupId, doc.getElementById(popupId).parentNode.id], [popupId, hostId]);
  }
}

test("a failure while the commands start puts Thunderbird's menus back", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const doc = win.document;
  await setRibbon(false);
  try {
    assertMenusAtHome(doc);
    const { create, definition } = loadCommandsForTest();
    let moved = false;
    const view = {
      root: doc.createElementNS("http://www.w3.org/1999/xhtml", "div"),
      // Called once the menus have moved to #mainPopupSet.
      setEnabled() {
        moved = THUNDERBIRD_MENUS.every(([popupId]) => doc.getElementById(popupId).parentNode.id === "mainPopupSet");
        throw new Error("injected");
      },
      setArrowEnabled() {},
      control: () => null,
    };
    let error = null;
    try {
      create(win, { view, definition });
    } catch (e) {
      error = e;
    }
    assert(moved, "the menus had moved when the failure came");
    assertEqual(String(error?.message), "injected");
    assertMenusAtHome(doc);
  } finally {
    await setRibbon(true);
  }
  closeCompose(win);
});

test("one menu that cannot go back does not keep the others in #mainPopupSet", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  const doc = win.document;
  await setRibbon(false);
  const host = doc.getElementById("button-encryption-options");
  try {
    const { create, definition } = loadCommandsForTest();
    const view = { root: doc.createElementNS("http://www.w3.org/1999/xhtml", "div"), setEnabled() {}, setArrowEnabled() {}, control: () => null };
    const commands = create(win, { view, definition });
    // The encryption menu goes back first (the last one moved).
    host.insertBefore = () => {
      throw new Error("injected");
    };
    commands.destroy();
    delete host.insertBefore;
    for (const [popupId, hostId] of THUNDERBIRD_MENUS.slice(0, -1)) {
      assertEqual([popupId, doc.getElementById(popupId).parentNode.id], [popupId, hostId]);
    }
  } finally {
    delete host.insertBefore;
    const popup = doc.getElementById("encryptionToolbarMenu");
    if (popup.parentNode !== host) {
      host.append(popup);
    }
    await setRibbon(true);
  }
  closeCompose(win);
});

test("ribbon editing controls run the engine", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const { commands } = win.qolCompose;
  const calls = spyCommands(win);
  select(win, "world");
  commands.run("bold");
  assertEqual(editorHTML(win), "<p>Hello <b>world</b></p>");
  commands.run("f-italic");   // the Format text twin shares the operation
  assertEqual(editorHTML(win), "<p>Hello <b><i>world</i></b></p>");
  commands.run("f-bold");
  commands.run("italic");
  assertEqual(editorHTML(win), "<p>Hello world</p>");
  select(win, "world");
  assert(win.qolCompose.engine.apply({ op: "fontSize", value: 12 }));
  select(win, "world");
  commands.run("size-up");
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 14pt">world</font></p>');
  select(win, "world");
  commands.run("f-size-down");
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 12pt">world</font></p>');
  commands.run("painter");
  assert(win.qolCompose.engine.paint.active, "painter on");
  commands.run("painter");
  assert(!win.qolCompose.engine.paint.active, "painter off");
  commands.run("color", { anchor: win.qolCompose.view.control("color"), arrow: true });
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 12pt">world</font></p>');
  assertEqual(calls, []);
  closeCompose(win);
});

// Editing engine
const engineCases = [
  ["bold", "<p>Hello world</p>", "world", { op: "bold" }, "<p>Hello <b>world</b></p>"],
  ["italic", "<p>Hello world</p>", "world", { op: "italic" }, "<p>Hello <i>world</i></p>"],
  ["font size 14pt", "<p>Hello world</p>", "world", { op: "fontSize", value: 14 }, '<p>Hello <font style="font-size: 14pt">world</font></p>'],
  ["text color", "<p>Hello world</p>", "world", { op: "color", value: "#c00000" }, '<p>Hello <span style="color: rgb(192, 0, 0);">world</span></p>'],
  ["heading 2", "<p>Title</p>", "Title", { op: "style", value: "heading2" }, '<h2 style="font-size: 1.3em; font-weight: bold; margin: 10px 0 4px">Title</h2>'],
  ["quote", "<p>Cite me</p>", "Cite me", { op: "style", value: "quote" }, '<blockquote style="margin: 8px 0; padding-left: 10px; border-left: 3px solid #c8c8c8; color: #555555">Cite me</blockquote>'],
  ["bullet list", "<p>One</p>", "One", { op: "bulletList" }, "<ul><li>One</li></ul>"],
  ["center", "<p>Mid</p>", "Mid", { op: "align", value: "center" }, '<p style="text-align: center;">Mid</p>'],
];
for (const [name, html, sel, op, expected] of engineCases) {
  test(`${name}: result and one-step undo`, async () => {
    const win = await openCompose({ html });
    select(win, sel);
    assert(win.qolCompose.engine.apply(op));
    assertEqual(editorHTML(win), expected);
    win.goDoCommand("cmd_undo");
    assertEqual(editorHTML(win), html);
    closeCompose(win);
  });
}

const moreEngineCases = [
  ["strikethrough uses <s>", "<p>Hello world</p>", "world", { op: "strike" }, "<p>Hello <s>world</s></p>"],
  ["strikethrough off", "<p>Hello <s>world</s></p>", "world", { op: "strike" }, "<p>Hello world</p>"],
  ["highlight", "<p>Hello world</p>", "world", { op: "highlight", value: "#ffff00" }, '<p>Hello <span style="background-color: rgb(255, 255, 0);">world</span></p>'],
  ["no highlight", '<p>Hello <span style="background-color: rgb(255, 255, 0);">world</span></p>', "world", { op: "highlight", value: null }, "<p>Hello world</p>"],
  ["font family", "<p>Hello world</p>", "world", { op: "fontFamily", value: "Georgia" }, '<p>Hello <span style="font-family: Georgia;">world</span></p>'],
  ["explicit bold off", "<p>Hello <b>world</b></p>", "world", { op: "bold", value: false }, "<p>Hello world</p>"],
  ["numbered list", "<p>One</p>", "One", { op: "numberList" }, "<ol><li>One</li></ol>"],
  ["indent", "<p>In</p>", "In", { op: "indent" }, '<p style="margin-left: 40px;">In</p>'],
  ["a style keeps the alignment", '<p style="text-align: center;">Title</p>', "Title", { op: "style", value: "heading1" }, '<h1 style="font-size: 1.6em; font-weight: bold; margin: 12px 0 6px; text-align: center">Title</h1>'],
  ["a style keeps the indent", '<p style="margin-left: 40px;">Cite me</p>', "Cite me", { op: "style", value: "quote" }, '<blockquote style="margin: 8px 0; padding-left: 10px; border-left: 3px solid #c8c8c8; color: #555555; margin-left: 40px">Cite me</blockquote>'],
  ["normal style", '<h2 style="font-size: 1.3em; font-weight: bold; margin: 10px 0 4px">Title</h2>', "Title", { op: "style", value: "normal" }, "<p>Title</p>"],
  ["clear formatting resets a heading", '<h2 style="font-size: 1.3em; font-weight: bold; margin: 10px 0 4px">A <i style="color: red;">big</i> title</h2>', "big", { op: "clearFormatting" }, "<p>A big title</p>"],
];
for (const [name, html, sel, op, expected] of moreEngineCases) {
  test(`${name}: result and one-step undo`, async () => {
    const win = await openCompose({ html });
    const original = editorHTML(win);
    select(win, sel);
    assert(win.qolCompose.engine.apply(op));
    assertEqual(editorHTML(win), expected);
    win.goDoCommand("cmd_undo");
    assertEqual(editorHTML(win), original);
    closeCompose(win);
  });
}

test("an explicit toggle value that is already set changes nothing", async () => {
  const win = await openCompose({ html: "<p>Hello <b>world</b></p>" });
  select(win, "world");
  assert(win.qolCompose.engine.apply({ op: "bold", value: true }));
  assertEqual(editorHTML(win), "<p>Hello <b>world</b></p>");
  assert(!win.GetCurrentEditor().canUndo, "no undo step");
  closeCompose(win);
});

test("a line break ends the word at the cursor", async () => {
  const win = await openCompose({ html: "<p>Hello<br>world</p>" });
  const doc = editorDocument(win);
  // Start of line 2: the word after the cursor, not the one before the break.
  select(win, "world", 0, 0);
  assert(win.qolCompose.engine.apply({ op: "bold" }));
  assertEqual(editorHTML(win), "<p>Hello<br><b>world</b></p>");
  const br = doc.querySelector("br");
  const caret = doc.getSelection().getRangeAt(0);
  const afterBreak = [...br.parentNode.childNodes].indexOf(br) + 1;
  assert(doc.getSelection().isCollapsed && caret.comparePoint(br.parentNode, afterBreak) <= 0, "the cursor stays on line 2");
  win.goDoCommand("cmd_undo");
  // End of line 1: typing style only.
  select(win, "Hello", 5, 5);
  assert(win.qolCompose.engine.apply({ op: "bold" }));
  assertEqual(editorHTML(win), "<p>Hello<br>world</p>");
  closeCompose(win);
});

test("an image ends the word at the cursor", async () => {
  const img = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
  const win = await openCompose({ html: `<p>Hello${img}world</p>` });
  select(win, "Hello", 5, 5);
  assert(win.qolCompose.engine.apply({ op: "italic" }));
  assertEqual(editorHTML(win), `<p>Hello${img}world</p>`);
  closeCompose(win);
});

test("clear formatting keeps a reply's quote and lists", async () => {
  const heading = '<h2 style="font-size: 1.3em; font-weight: bold; margin: 10px 0 4px">Head</h2>';
  for (const [rest, expectedRest] of [
    ['<blockquote type="cite"><p>Quoted <b>text</b></p></blockquote>', '<blockquote type="cite"><p>Quoted text</p></blockquote>'],
    ["<ul><li>One <b>item</b></li></ul>", "<ul><li>One item</li></ul>"],
  ]) {
    const win = await openCompose({ html: heading + rest });
    const original = editorHTML(win);
    const range = select(win, "Head");
    const end = select(win, rest.includes("cite") ? "text" : "item");
    range.setEnd(end.endContainer, end.endOffset);
    editorDocument(win).getSelection().removeAllRanges();
    editorDocument(win).getSelection().addRange(range);
    assert(win.qolCompose.engine.apply({ op: "clearFormatting" }));
    assertEqual(editorHTML(win), "<p>Head</p>" + expectedRest);
    win.goDoCommand("cmd_undo");
    assertEqual(editorHTML(win), original);
    closeCompose(win);
  }
});

test("clear formatting unwraps a styled quote of several paragraphs", async () => {
  const win = await openCompose({ html: '<blockquote style="color: #555555"><p>One</p><p>Two</p></blockquote>' });
  const original = editorHTML(win);
  select(win, "One");
  assert(win.qolCompose.engine.apply({ op: "clearFormatting" }));
  assertEqual(editorHTML(win), "<p>One</p><p>Two</p>");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("clear formatting leaves images and tables alone", async () => {
  const win = await openCompose({
    html: '<p><span style="color: red">x</span><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width: 20px"></p>' +
      '<table style="width: 100%"><tbody><tr><td style="padding: 4px">c</td></tr></tbody></table>',
  });
  const doc = editorDocument(win);
  const original = editorHTML(win);
  select(win, "x");
  win.GetCurrentEditor().selectAll();
  assert(win.qolCompose.engine.apply({ op: "clearFormatting" }));
  assert(![...doc.body.querySelectorAll("span")].some(span => span.hasAttribute("style")), editorHTML(win));
  assertEqual(doc.querySelector("img").getAttribute("style"), "width: 20px");
  assertEqual(doc.querySelector("table").getAttribute("style"), "width: 100%");
  assertEqual(doc.querySelector("td").getAttribute("style"), "padding: 4px");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("clear formatting at a cursor outside a word resets the paragraph", async () => {
  const heading = '<h2 style="font-size: 1.3em; font-weight: bold; margin: 10px 0 4px">Title</h2>';
  const win = await openCompose({ html: heading + "<p><br></p>" });
  const doc = editorDocument(win);
  const original = editorHTML(win);
  select(win, "Title", 5, 5); // end of the heading
  assert(win.qolCompose.engine.apply({ op: "clearFormatting" }));
  assertEqual(editorHTML(win), "<p>Title</p><p><br></p>");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  doc.getSelection().collapse(doc.body.lastElementChild, 0); // the empty line
  assert(win.qolCompose.engine.apply({ op: "clearFormatting" }), "an empty line");
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("a size at a cursor outside a word applies to the next typed text", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  select(win, "world", 5, 5);
  assert(win.qolCompose.engine.apply({ op: "fontSize", value: 20 }));
  win.GetCurrentEditor().insertText("!");
  assertEqual(editorHTML(win), '<p>Hello world<font style="font-size: 20pt">!</font></p>');
  closeCompose(win);
});

test("size across two paragraphs is one undo step", async () => {
  const html = "<p>Hello there</p><p>big world</p>";
  const win = await openCompose({ html });
  const doc = editorDocument(win);
  const range = select(win, "Hello");
  range.setEnd(select(win, "world").endContainer, "big world".length);
  doc.defaultView.getSelection().removeAllRanges();
  doc.defaultView.getSelection().addRange(range);
  assert(win.qolCompose.engine.apply({ op: "fontSize", value: 18 }));
  assertEqual(editorHTML(win), '<p><font style="font-size: 18pt">Hello there</font></p><p><font style="font-size: 18pt">big world</font></p>');
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  closeCompose(win);
});

test("collapsed cursor formats the word", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  select(win, "world", 2, 2);
  assert(win.qolCompose.engine.apply({ op: "bold" }));
  assertEqual(editorHTML(win), "<p>Hello <b>world</b></p>");
  const selection = editorDocument(win).defaultView.getSelection();
  assert(selection.isCollapsed, "the cursor stays a cursor");
  win.goDoCommand("cmd_undo");
  select(win, "Hello", 1, 1); // the word's trailing space stays unformatted
  assert(win.qolCompose.engine.apply({ op: "italic" }));
  assertEqual(editorHTML(win), "<p><i>Hello</i> world</p>");
  closeCompose(win);
});

test("a cursor outside a word sets the formatting for the next typed text", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  select(win, "world", 5, 5);
  assert(win.qolCompose.engine.apply({ op: "bold" }));
  assertEqual(editorHTML(win), "<p>Hello world</p>");
  win.GetCurrentEditor().insertText("!");
  assertEqual(editorHTML(win), "<p>Hello world<b>!</b></p>");
  closeCompose(win);
});

test("a second size replaces the first", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  select(win, "world");
  assert(win.qolCompose.engine.apply({ op: "fontSize", value: 14 }));
  select(win, "world");
  assert(win.qolCompose.engine.apply({ op: "fontSize", value: 18 }));
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 18pt">world</font></p>');
  assertEqual(win.qolCompose.engine.formatAt().sizePt, 18);
  closeCompose(win);
});

test("clear formatting leaves text outside the selection alone", async () => {
  const win = await openCompose({ html: "<p><b>keep</b> <b>clear</b></p>" });
  const original = editorHTML(win); // editorHTML drops the space between the tags
  select(win, "clear");
  assert(win.qolCompose.engine.apply({ op: "clearFormatting" }));
  assertEqual(editorHTML(win), "<p><b>keep</b> clear</p>");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("plain-text mail disables formatting", async () => {
  const win = await openCompose({ html: "x", plainText: true });
  // A new mail without recipients can't be sent (Thunderbird disables Send).
  win.goSetCommandEnabled("cmd_sendButton", true);
  await waitFor(() => !win.qolCompose.view.control("qa-send").disabled);
  assert(win.qolCompose.view.control("bold").disabled && !win.qolCompose.view.control("qa-send").disabled);
  assert(win.qolCompose.engine.apply({ op: "bold" }) === false);
  closeCompose(win);
});

test("a failing operation changes nothing and returns false", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  assert(!editor.canUndo, "a new mail has nothing to undo");
  select(win, "world");
  assert(engine.apply({ op: "fontSize", value: NaN }) === false, "NaN size");
  assert(engine.apply({ op: "style", value: "nonsense" }) === false, "unknown style");
  assert(engine.apply({ op: "nonsense" }) === false, "unknown operation");
  let threw = false;
  try {
    engine.transaction(() => {
      win.GetCurrentEditor().document.execCommand("bold");
      throw new Error("boom");
    });
  } catch (e) {
    threw = e.message === "boom";
  }
  assert(threw, "transaction rethrows");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "no undo step is left behind");
  closeCompose(win);
});

test("formatAt reports the formatting at the cursor", async () => {
  const win = await openCompose({ html: '<h2><u><b>Big</b></u> <span style="background-color: rgb(255, 255, 0);">yellow</span></h2>' });
  select(win, "Big", 1, 1);
  const f = win.qolCompose.engine.formatAt();
  assert(f.bold && f.underline && !f.italic && f.style === "heading2", JSON.stringify(f));
  select(win, "yellow", 2, 2);
  assertEqual(win.qolCompose.engine.formatAt().highlight, "#ffff00");
  closeCompose(win);
});

// Pickers

async function openPicker(win, id, button) {
  button.click();
  return waitFor(() => {
    const popup = win.qolCompose.view.root.querySelector(`menupopup[data-picker-for="${id}"]`);
    return popup?.state === "open" && popup;
  });
}

async function choose(popup, item) {
  assert(item, "no such entry");
  popup.activateItem(item);
  await waitFor(() => popup.state === "closed");
}

function entries(popup) {
  return [...popup.querySelectorAll("menuitem:not([disabled])")];
}

function entry(popup, label) {
  return entries(popup).find(item => item.getAttribute("label") === label);
}

function assertBelow(popup, anchor) {
  const a = anchor.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  assert(Math.abs(p.left - a.left) < 4 && Math.abs(p.top - a.bottom) < 4, `${popup.getAttribute("data-picker-for")} opens below its control`);
}

// Replaces nsIColorPicker (behind <input type="color">) with one that answers `result` at once.
function mockColorPicker(result) {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const contract = "@mozilla.org/colorpicker;1";
  const original = registrar.contractIDToCID(contract);
  const cid = Components.ID("{4d8a1c6e-6b0f-4c63-9a55-2b8f7d0b1e11}");
  const calls = [];
  const factory = {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(iid) {
      const picker = {
        QueryInterface: ChromeUtils.generateQI(["nsIColorPicker"]),
        init(context, title, color) {
          calls.push({ title, color });
        },
        open(callback) {
          setTimeout(() => {
            callback.update(result);
            callback.done(result);
          }, 0);
        },
      };
      return picker.QueryInterface(iid);
    },
  };
  registrar.registerFactory(cid, "mock color picker", contract, factory);
  return {
    calls,
    restore() {
      registrar.unregisterFactory(cid, factory);
      registrar.registerFactory(original, "", contract, null);
    },
  };
}

test("font picker applies a font and remembers it", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  select(win, "world");
  win.qolCompose.view.pick("font", { op: "fontFamily", value: "Georgia" });   // same path as a menu click
  assert(editorHTML(win).includes("font-family: Georgia"));
  // The run starts with no recent fonts (resetComposeState).
  await waitForState(state => state.recentFonts.join() === "Georgia");
  closeCompose(win);
});

test("color button reuses the last color in one click", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  select(win, "Hello");
  v.pick("color", { op: "color", value: "#00b050" });
  select(win, "world");
  v.control("color").click();
  assert(editorHTML(win).includes('<span style="color: rgb(0, 176, 80);">world</span>'), editorHTML(win));
  closeCompose(win);
});

test("highlight No color removes the highlight", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  select(win, "world");
  v.pick("highlight", { op: "highlight", value: "#ffff00" });
  assert(editorHTML(win).includes("background-color: rgb(255, 255, 0)"), editorHTML(win));
  select(win, "world");
  v.pick("highlight", { op: "highlight", value: null });
  assert(!editorHTML(win).includes("background-color"), editorHTML(win));
  closeCompose(win);
});

test("font list contains installed fonts", async () => {
  const win = await openCompose({ html: "<p>x</p>" });
  assert((await win.qolCompose.view.fontNames()).length > 10);
  closeCompose(win);
});

test("font list shows recent fonts first, then all fonts, and applies the chosen one", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  select(win, "Hello");
  v.pick("font", { op: "fontFamily", value: "Courier New" });
  const popup = await openPicker(win, "font", v.control("font"));
  assertBelow(popup, v.control("font"));
  const items = entries(popup);
  assertEqual(items[0].getAttribute("label"), "Courier New");
  const separator = popup.querySelector("menuseparator");
  assert(separator, "a separator after the recent fonts");
  const all = items.filter(item => separator.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
  assertEqual(all.map(item => item.getAttribute("label")), await v.fontNames());
  select(win, "world");
  await choose(popup, all.find(item => item.getAttribute("label") === "Georgia"));
  assert(/font-family: Georgia;?">world/.test(editorHTML(win)), editorHTML(win));
  // After the first font test: ["Georgia"], then Courier New and Georgia again.
  await waitForState(state => state.recentFonts.join() === "Georgia,Courier New");
  closeCompose(win);
});

test("size list offers the sizes and applies the chosen one", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const arrow = v.root.querySelector('[data-arrow-for="f-size"]');
  v.selectTab("format");
  const popup = await openPicker(win, "f-size", arrow);
  assertBelow(popup, v.control("f-size").parentNode);
  assertEqual(entries(popup).map(item => item.getAttribute("label")).join(), "8,9,10,11,12,14,16,18,20,24,28,36,48,72");
  select(win, "world");
  await choose(popup, entry(popup, "18"));
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 18pt">world</font></p>');
  closeCompose(win);
});

test("the size field takes a typed size", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const field = win.qolCompose.view.control("size");
  const type = text => {
    field.focus();
    field.value = text;
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    pressKey(win, "Enter");
  };
  select(win, "world");
  type("13");
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 13pt">world</font></p>');
  assert(win.document.activeElement === win.GetCurrentEditorElement(), "Enter returns to the mail");
  select(win, "Hello");
  type("10,5");
  // editorHTML drops the space between the two elements.
  assertEqual(editorHTML(win), '<p><font style="font-size: 10.5pt">Hello</font><font style="font-size: 13pt">world</font></p>');
  const before = editorHTML(win);
  select(win, "Hello");
  type("abc");
  assertEqual(editorHTML(win), before);
  assertEqual(field.value, "10.5");   // back to the last size
  closeCompose(win);
});

test("color palettes list their colors and apply the chosen one", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const bar = id => win.getComputedStyle(v.control(id).querySelector(".qol-swatch")).backgroundColor;
  // Text color: 10 theme columns x 5 shades, 10 standard colors, More colors.
  let popup = await openPicker(win, "color", v.root.querySelector('[data-arrow-for="color"]'));
  assertBelow(popup, v.control("color").parentNode);
  assertEqual(popup.querySelectorAll("menuitem.qol-color").length, 60);
  assert(popup.querySelector('menuitem[data-action="more-colors"]'), "More colors…");
  select(win, "world");
  await choose(popup, entry(popup, "#7030a0"));
  assert(editorHTML(win).includes('<span style="color: rgb(112, 48, 160);">world</span>'), editorHTML(win));
  assertEqual(bar("color"), "rgb(112, 48, 160)");
  // Highlight: 15 colors and No color.
  popup = await openPicker(win, "highlight", v.root.querySelector('[data-arrow-for="highlight"]'));
  assertEqual(popup.querySelectorAll("menuitem.qol-color").length, 15);
  select(win, "Hello");
  await choose(popup, entry(popup, "#00ff00"));
  assert(editorHTML(win).includes('<span style="background-color: rgb(0, 255, 0);">Hello</span>'), editorHTML(win));
  assertEqual(bar("highlight"), "rgb(0, 255, 0)");
  popup = await openPicker(win, "highlight", v.root.querySelector('[data-arrow-for="highlight"]'));
  select(win, "Hello");
  await choose(popup, popup.querySelector('menuitem[data-action="no-color"]'));
  assert(!editorHTML(win).includes("background-color"), editorHTML(win));
  assertEqual(bar("highlight"), "rgb(0, 255, 0)");   // No color keeps the last color
  closeCompose(win);
});

test("More colors… opens the native color picker and applies its color", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const picker = mockColorPicker("#123456");
  try {
    select(win, "Hello");
    v.pick("color", { op: "color", value: "#00b050" });
    const popup = await openPicker(win, "color", v.root.querySelector('[data-arrow-for="color"]'));
    select(win, "world");
    await choose(popup, popup.querySelector('menuitem[data-action="more-colors"]'));
    await waitFor(() => editorHTML(win).includes('<span style="color: rgb(18, 52, 86);">world</span>'));
    assertEqual(picker.calls.map(c => c.color), ["#00b050"]);   // starts at the last color
    await waitForState(state => state.lastColors.text === "#123456");
  } finally {
    picker.restore();
  }
  closeCompose(win);
});

test("the color bars show the last colors in every window", async () => {
  const a = await openCompose({ html: "<p>Hello world</p>" });
  const b = await openCompose({ html: "<p>x</p>" });
  select(a, "world");
  a.qolCompose.view.pick("color", { op: "color", value: "#7030a0" });
  a.qolCompose.view.pick("highlight", { op: "highlight", value: "#00ffff" });
  a.qolCompose.view.pick("highlight", { op: "highlight", value: null });
  for (const win of [a, b]) {
    const bar = id => win.getComputedStyle(win.qolCompose.view.control(id).querySelector(".qol-swatch")).backgroundColor;
    assertEqual([bar("color"), bar("f-color"), bar("highlight"), bar("f-highlight")], [
      "rgb(112, 48, 160)", "rgb(112, 48, 160)", "rgb(0, 255, 255)", "rgb(0, 255, 255)",
    ]);
  }
  closeCompose(b);
  closeCompose(a);
});

test("styles gallery shows each style in its look and applies it", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  v.selectTab("format");
  const popup = await openPicker(win, "styles", v.control("styles"));
  assertBelow(popup, v.control("styles"));
  const items = entries(popup);
  assertEqual(items.map(item => item.getAttribute("data-value")), ["normal", "heading1", "heading2", "heading3", "quote", "code"]);
  const look = key => win.getComputedStyle(items.find(item => item.getAttribute("data-value") === key));
  assert(look("heading1").fontWeight === "700" && parseFloat(look("heading1").fontSize) > parseFloat(look("normal").fontSize), "headings look like headings");
  assert(look("code").fontFamily.includes("Menlo"), "code looks like code");
  select(win, "world");
  await choose(popup, items[2]);
  assert(editorHTML(win).startsWith("<h2"), editorHTML(win));
  closeCompose(win);
});

test("style set list offers the sets, applies the chosen one and shows the active set", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  v.selectTab("format");
  await waitFor(() => v.valueOf("styleset") === "default");
  let popup = await openPicker(win, "styleset", v.control("styleset"));
  assertBelow(popup, v.control("styleset"));
  assertEqual(entries(popup).filter(item => item.hasAttribute("data-value")).map(item => item.getAttribute("data-value")), ["default", "modern", "classic", "compact"]);
  const checked = () => entries(popup).filter(item => item.getAttribute("checked") === "true").map(item => item.dataset.value);
  assertEqual(checked(), ["default"]);
  select(win, "world");
  await choose(popup, entries(popup)[1]);
  assert(fontOf(editorDocument(win).querySelector("p")).includes("Helvetica Neue"), "Modern applied");
  assertEqual(win.qolCompose.engine.activeSet, "modern");
  await waitFor(() => v.valueOf("styleset") === "modern");
  // "Modern" in both languages.
  assert(v.control("styleset").getAttribute("aria-label").endsWith(": Modern"), v.control("styleset").getAttribute("aria-label"));
  popup = await openPicker(win, "styleset", v.control("styleset"));
  assertEqual(checked(), ["modern"]);
  popup.hidePopup();
  closeCompose(win);
});

test("collapsed ribbon stays open while the picker or menu it opened is open", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const doc = win.document;
  const tab = id => v.root.querySelector(`[data-tab="${id}"][role="tab"]`);
  const panel = id => v.root.querySelector(`[role="tabpanel"][data-tab="${id}"]`);
  v.setCollapsed(true);
  try {
    // The font list fills itself asynchronously.
    tab("format").click();
    const fonts = await openPicker(win, "f-font", v.control("f-font"));
    await sleep(50);
    assert(panel("format").checkVisibility(), "open while the font list is open");
    fonts.hidePopup();
    await waitFor(() => !panel("format").checkVisibility());
    tab("message").click();
    v.control("security").click();
    const security = doc.getElementById("encryptionToolbarMenu");
    await waitFor(() => security.state === "open");
    await sleep(50);
    assert(panel("message").checkVisibility(), "open while the security menu is open");
    security.hidePopup();
    await waitFor(() => !panel("message").checkVisibility());
    const other = doc.createXULElement("menupopup");
    other.append(doc.createXULElement("menuitem"));
    doc.getElementById("mainPopupSet").append(other);
    try {
      other.openPopup(doc.getElementById("msgSubject"), "after_start");
      await waitFor(() => other.state === "open");
      tab("format").click();
      select(win, "world");
      v.control("f-bold").click();
      await sleep(50);
      assert(!panel("format").checkVisibility(), "an unrelated popup does not keep it open");
    } finally {
      other.hidePopup();
      other.remove();
    }
  } finally {
    v.setCollapsed(false);
  }
  closeCompose(win);
});

// State sync

test("ribbon reflects the formatting at the cursor", async () => {
  const win = await openCompose({ html: '<h2>Head</h2><p><b>bold</b> <span style="font-family: Georgia; font-size: 14pt">serif</span></p>' });
  const v = win.qolCompose.view;
  select(win, "bold", 1, 1); await sleep(120);
  assert(v.control("bold").getAttribute("aria-pressed") === "true");
  select(win, "serif", 2, 2); await sleep(120);
  assert(v.valueOf("font") === "Georgia" && v.valueOf("size") === "14");
  select(win, "Head", 1, 1); await sleep(120);
  assert(v.valueOf("styles") === "heading2");
  closeCompose(win);
});

test("state sync covers both tabs, lists, alignment, strikethrough and superscript", async () => {
  const win = await openCompose({
    html: '<p style="text-align: center"><s>gone</s> <sup>up</sup> <span style="font-size: 10.5pt">half</span></p><ul><li>item</li></ul>',
  });
  const v = win.qolCompose.view;
  const pressed = id => v.control(id).getAttribute("aria-pressed") === "true";
  select(win, "gone", 1, 1); await sleep(120);
  assert(pressed("strike") && pressed("f-strike"), "strikethrough on both tabs");
  assert(pressed("align-center") && !pressed("align-left") && !pressed("bullets"), "centered, no list");
  select(win, "up", 1, 1); await sleep(120);
  assert(pressed("f-superscript") && !pressed("f-subscript") && !pressed("strike"), "superscript");
  select(win, "half", 1, 1); await sleep(120);
  assertEqual([v.valueOf("size"), v.valueOf("f-size")], ["10.5", "10.5"]);
  select(win, "item", 1, 1); await sleep(120);
  assert(pressed("bullets") && !pressed("numbers"), "bullet list");
  assert(pressed("align-left") && !pressed("align-center"), "left aligned");
  assertEqual(v.valueOf("f-font"), v.valueOf("font"));
  assertEqual(v.valueOf("styles"), "normal");
  v.selectTab("format");
  const gallery = await openPicker(win, "styles", v.control("styles"));
  assertEqual([...gallery.querySelectorAll("[data-current]")].map(item => item.dataset.value), ["normal"]);
  gallery.hidePopup();
  closeCompose(win);
});

test("a ribbon action updates the state without a selection change", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  // At the end of the text: no word to format, the next typed text gets bold.
  select(win, "Hello world", 11, 11); await sleep(120);
  assert(v.control("bold").getAttribute("aria-pressed") === "false", "not bold yet");
  v.control("bold").click(); await sleep(120);
  assert(v.control("bold").getAttribute("aria-pressed") === "true", "bold for the next typed text");
  closeCompose(win);
});

test("state sync leaves a size being typed alone", async () => {
  const win = await openCompose({ html: '<p>small <span style="font-size: 20pt">large</span></p>' });
  const v = win.qolCompose.view;
  const field = v.control("size");
  select(win, "small", 1, 1); await sleep(120);
  const before = v.valueOf("size");
  field.focus();
  field.value = "3";
  field.dispatchEvent(new win.Event("input"));
  const doc = editorDocument(win);
  doc.defaultView.getSelection().collapse(doc.querySelector("span").firstChild, 2);
  await sleep(120);
  assertEqual(field.value, "3");
  assert(v.valueOf("size") === "20" && before !== "20", `synced ${before} → ${v.valueOf("size")}`);
  pressKey(win, "Escape");
  assertEqual(field.value, "20");
  closeCompose(win);
});

// Thunderbird disables Cut, Copy and Paste as soon as the focus leaves the editor.
test("clipboard controls work from the keyboard and return the focus to the editor", () => keepingClipboard(async () => {
  // Paste is enabled with text on the clipboard.
  setClipboardText("text to paste");
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  const doc = win.document;
  const editorElement = win.GetCurrentEditorElement();
  select(win, "world");
  // Thunderbird enables these for the focused editor; the ribbon asks the
  // editor's own controllers while it has the focus.
  for (const command of ["cmd_cut", "cmd_copy", "cmd_paste", "cmd_pasteNoFormatting"]) {
    win.goSetCommandEnabled(command, true);
  }
  await waitFor(() => ["cut", "copy", "paste"].every(id => !v.control(id).disabled));
  // Records whether the editor had the focus for each command; nothing reaches the clipboard.
  const calls = spyCommands(win);
  const record = win.goDoCommand;
  const focused = [];
  win.goDoCommand = command => {
    focused.push(doc.activeElement === editorElement);
    record(command);
  };
  // F6 into the ribbon, Down into the Message tab: Paste.
  assert(win.gFocusAreas[0].focus(win.gFocusAreas[0].root));
  pressKey(win, "ArrowDown");
  assert(doc.activeElement === v.control("paste"), "Down reaches Paste");
  // Thunderbird updates its commands for the new focus.
  await sleep(150);
  assert(["cut", "copy", "paste"].every(id => !v.control(id).disabled), "the mail's selection and the clipboard keep them enabled");
  pressKey(win, "Enter");
  assertEqual(calls, ["cmd_paste"]);
  assert(doc.activeElement === editorElement, "Paste returns the focus to the editor");
  v.control("copy").focus();
  await sleep(150);
  assert(!v.control("copy").disabled, "Copy stays enabled");
  pressKey(win, "Enter");
  v.control("paste").focus();
  win.qolCompose.commands.run("paste", { menuItem: "paste-text" });
  assertEqual(calls, ["cmd_paste", "cmd_copy", "cmd_pasteNoFormatting"]);
  assertEqual(focused, [true, true, true]);
  assert(doc.activeElement === editorElement, "the editor has the focus");
  closeCompose(win);
}));

// System clipboard (text only)

function clipboardText() {
  const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  transferable.init(null);
  transferable.addDataFlavor("text/plain");
  try {
    Services.clipboard.getData(transferable, Ci.nsIClipboard.kGlobalClipboard, null);
    const data = {};
    transferable.getTransferData("text/plain", data);
    return data.value.QueryInterface(Ci.nsISupportsString).data;
  } catch (e) {
    return null;
  }
}

function setClipboardText(text) {
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
}

async function keepingClipboard(fn) {
  const saved = clipboardText();
  try {
    await fn();
  } finally {
    if (saved !== null) {
      setClipboardText(saved);
    }
  }
}

// F6, Down, then Right until `id` has the focus (arrows skip disabled controls);
// controls past the size field, which keeps the arrow keys, get the focus directly.
async function focusRibbonControl(win, id) {
  const control = win.qolCompose.view.control(id);
  assert(win.gFocusAreas[0].focus(win.gFocusAreas[0].root), "F6 reaches the ribbon");
  pressKey(win, "ArrowDown");
  await waitFor(() => !control.disabled);
  for (let i = 0; i < 4 && win.document.activeElement !== control; i++) {
    pressKey(win, "ArrowRight");
  }
  if (win.document.activeElement !== control) {
    control.focus();
  }
  return win.document.activeElement;
}

test("keyboard Cut from the ribbon cuts the subject's selection, not the mail's", async () => {
  await keepingClipboard(async () => {
    const html = "<p>Hello world</p>";
    const win = await openCompose({ html });
    const v = win.qolCompose.view;
    const doc = win.document;
    select(win, "world");   // the mail has a selection too
    const subject = doc.getElementById("msgSubject");
    subject.focus();
    subject.value = "Quarterly report";
    subject.setSelectionRange(0, 9);
    assert(await focusRibbonControl(win, "cut") === v.control("cut"), "Right reaches Cut");
    assert(!v.control("copy").disabled, "Copy is enabled too");
    // Another window in front and back again: still the subject's.
    Services.wm.getMostRecentWindow("mail:3pane").focus();
    await waitFor(() => Services.focus.activeWindow !== win);
    win.focus();
    await waitFor(() => Services.focus.activeWindow === win && doc.activeElement === v.control("cut"));
    await waitFor(() => !v.control("cut").disabled);
    pressKey(win, "Enter");
    await waitFor(() => subject.value === " report");
    assert(doc.activeElement === subject, "the focus is back in the subject");
    assertEqual(clipboardText(), "Quarterly");
    assertEqual(editorHTML(win), html);
    closeCompose(win);
  });
});

test("clipboard controls follow the element the ribbon took the focus from", async () => {
  await keepingClipboard(async () => {
    const win = await openCompose({ html: "<p>Hello world</p>" });
    const v = win.qolCompose.view;
    const subject = win.document.getElementById("msgSubject");
    setClipboardText("text to paste");
    // A selection in the mail, none in the subject: Cut and Copy are off.
    select(win, "world");
    subject.focus();
    subject.value = "Report";
    subject.setSelectionRange(6, 6);
    await focusRibbonControl(win, "paste");
    await waitFor(() => v.control("cut").disabled && v.control("copy").disabled);
    select(win, "world");
    await focusRibbonControl(win, "paste");
    await waitFor(() => !v.control("cut").disabled && !v.control("copy").disabled);
    closeCompose(win);
  });
});

test("keyboard Copy and Paste from the ribbon use the real clipboard", async () => {
  await keepingClipboard(async () => {
    const win = await openCompose({ html: "<p>Hello world</p>" });
    const v = win.qolCompose.view;
    const editorElement = win.GetCurrentEditorElement();
    setClipboardText("something else");
    select(win, "Hello");
    assert(await focusRibbonControl(win, "copy") === v.control("copy"), "Right reaches Copy");
    pressKey(win, "Enter");
    await waitFor(() => clipboardText() === "Hello");
    assert(win.document.activeElement === editorElement, "Copy returns the focus to the mail");
    select(win, "world", 5, 5);
    assert(await focusRibbonControl(win, "paste") === v.control("paste"), "Down reaches Paste");
    pressKey(win, "Enter");
    await waitFor(() => editorHTML(win) === "<p>Hello worldHello</p>");
    assert(win.document.activeElement === editorElement, "Paste returns the focus to the mail");
    closeCompose(win);
  });
});

// Live preview. TB 153's editor has no transaction manager, so the tests check the HTML,
// canUndo/canRedo, the modification count and that cmd_undo/cmd_redo still behave.

test("preview changes the text and leaves no trace", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  // An earlier step that must stay the one cmd_undo takes back.
  select(win, "Hello");
  assert(engine.apply({ op: "bold" }));
  const html = editorHTML(win);
  select(win, "world");
  const undoBefore = editor.canUndo;
  const redoBefore = editor.canRedo;
  const countBefore = editor.getModificationCount();
  const contentChangedBefore = win.gContentChanged;
  assert(undoBefore && !redoBefore, "one step to undo, nothing to redo");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(engine.previewActive, "preview shown");
  assert(editorHTML(win).includes("Georgia"));
  // Thunderbird's changed state (save prompt, autosave) ignores the preview.
  assertEqual(editor.getModificationCount(), countBefore);
  engine.cancelPreview();
  assert(!engine.previewActive, "preview ended");
  assertEqual(editorHTML(win), html);
  assertEqual(editor.canUndo, undoBefore);
  assertEqual(editor.getModificationCount(), countBefore);
  assertEqual(win.gContentChanged, contentChangedBefore);
  assertEqual(editorDocument(win).getSelection().toString(), "world");
  // Gecko keeps the undone preview as a redo entry (TB 153 has no way to
  // drop it); replaying it is refused, so cmd_redo changes nothing.
  assert(editor.canRedo, "the redo entry Gecko keeps");
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), html);
  // The undo history is the one from before: one step, the bold.
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), "<p>Hello world</p>");
  assert(!editor.canUndo, "nothing left to undo");
  closeCompose(win);
});

test("commit after preview is a single undo step", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(engine.previewActive, "preview shown");
  assert(engine.commitPreview({ op: "fontFamily", value: "Georgia" }), "committed");
  assert(!engine.previewActive, "no preview after the commit");
  assertEqual(editorHTML(win), '<p>Hello <span style="font-family: Georgia;">world</span></p>');
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), "<p>Hello world</p>");
  assert(!editor.canUndo, "one undo step");
  closeCompose(win);
});

test("losing window focus and Esc both end the preview", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  const v = win.qolCompose.view;
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(editorHTML(win).includes("Georgia"), "preview shown");
  win.dispatchEvent(new win.FocusEvent("blur"));
  assertEqual(editorHTML(win), html);
  assert(!engine.previewActive && !editor.canUndo, "blur: preview gone");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  v.selectTab("format");
  const popup = await openPicker(win, "styleset", v.control("styleset"));
  assert(editorHTML(win).includes("Georgia"), "opening a picker keeps the preview");
  pressKey(win, "Escape");
  await waitFor(() => popup.state === "closed");
  assertEqual(editorHTML(win), html);
  assert(!engine.previewActive && !editor.canUndo, "Esc: preview gone");
  closeCompose(win);
});

function activeEntry(popup) {
  return popup.querySelector("menuitem[_moz-menuactive]");
}

// The menu moves its active entry a few ms after the key.
async function nextEntry(win, popup) {
  assertEqual(popup.state, "open");
  const before = activeEntry(popup);
  pressKey(win, "ArrowDown");
  return waitFor(() => {
    const now = activeEntry(popup);
    return now !== before && now;
  });
}

function sizePreviewShown(win, pt) {
  return editorHTML(win).includes(`font-size: ${pt}pt`);
}

test("resting on a picker entry previews it after 250 ms; the ribbon keeps showing the real format", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const v = win.qolCompose.view;
  const e = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  const arrow = v.root.querySelector('[data-arrow-for="f-size"]');
  v.selectTab("format");
  select(win, "world");
  const sizeBefore = await waitFor(() => v.valueOf("f-size"));
  assert(sizeBefore !== "8" && sizeBefore !== "9", `size shown: ${sizeBefore}`);
  let popup = await openPicker(win, "f-size", arrow);
  // The arrow keys make an entry active as the pointer does.
  const pressedAt = Date.now();
  let entry8 = await nextEntry(win, popup);
  assertEqual(entry8.getAttribute("label"), "8");
  await waitFor(() => sizePreviewShown(win, 8), 5000);
  assert(Date.now() - pressedAt >= 250, `preview ${Date.now() - pressedAt} ms after the key`);
  assert(e.previewActive);
  // State sync (50 ms after a change) waits while the preview shows.
  await sleep(150);
  assertEqual(v.valueOf("f-size"), sizeBefore);
  pressKey(win, "Escape");
  await waitFor(() => popup.state === "closed");
  assertEqual(editorHTML(win), html);
  assert(!e.previewActive && !editor.canUndo, "no preview, nothing to undo");
  popup = await openPicker(win, "f-size", arrow);
  entry8 = await nextEntry(win, popup);
  await waitFor(() => sizePreviewShown(win, 8), 5000);
  // The first preview ends at once; the next comes 250 ms after its entry became active.
  const entry9 = await nextEntry(win, popup);
  assertEqual(entry9.getAttribute("label"), "9");
  await waitFor(() => editorHTML(win) === html, 5000);
  await waitFor(() => sizePreviewShown(win, 9), 5000);
  await choose(popup, entry(popup, "9"));
  assertEqual(editorHTML(win), '<p>Hello <font style="font-size: 9pt">world</font></p>');
  await waitFor(() => v.valueOf("f-size") === "9");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "one undo step");
  await waitFor(() => v.valueOf("f-size") === sizeBefore);
  closeCompose(win);
});

test("typing or another edit during a preview cancels it first", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  pressKey(win, "a", "KeyA");
  assertEqual(editorHTML(win), "<p>Hello a</p>");
  assert(!engine.previewActive, "typing ended the preview");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "the typing was the only step");
  // An edit that is not a key press (here: execCommand).
  select(win, "world");
  engine.preview({ op: "color", value: "#ff0000" });
  editorDocument(win).execCommand("insertText", false, "X");
  assertEqual(editorHTML(win), "<p>Hello X</p>");
  assert(!engine.previewActive, "the edit ended the preview");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "the edit was the only step");
  closeCompose(win);
});

test("only one preview at a time; a ribbon action ends it", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  engine.preview({ op: "color", value: "#ff0000" });
  assertEqual(editorHTML(win), '<p>Hello <span style="color: rgb(255, 0, 0);">world</span></p>');
  win.qolCompose.commands.run("bold");
  assertEqual(editorHTML(win), "<p>Hello <b>world</b></p>");
  assert(!engine.previewActive, "the action ended the preview");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "bold was the only step");
  closeCompose(win);
});

test("a preview keeps the cursor, the user's redo and an unmodified mail", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  const selection = editorDocument(win).getSelection();
  const range = select(win, "world", 2, 2);
  engine.preview({ op: "color", value: "#ff0000" });
  assertEqual(editorHTML(win), '<p>Hello <span style="color: rgb(255, 0, 0);">world</span></p>');
  engine.cancelPreview();
  assertEqual(editorHTML(win), html);
  assert(selection.isCollapsed && selection.focusNode === range.startContainer && selection.focusOffset === 8, "cursor back in the word");
  assert(!editor.documentModified && !win.gMsgCompose.bodyModified, "the mail counts as unchanged");
  // A cursor outside a word would only set the typing style, which no undo
  // takes back: no preview.
  select(win, "world", 5, 5);
  engine.preview({ op: "color", value: "#ff0000" });
  assert(!engine.previewActive, "no preview at the end of the text");
  assertEqual(editorHTML(win), html);
  select(win, "world");
  assert(engine.apply({ op: "bold" }));
  win.goDoCommand("cmd_undo");
  assert(editor.canRedo, "the bold is redoable");
  select(win, "world");
  engine.preview({ op: "color", value: "#ff0000" });
  assert(!engine.previewActive, "no preview while the user can redo");
  assertEqual(editorHTML(win), html);
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), "<p>Hello <b>world</b></p>");
  closeCompose(win);
});

// The user's own undo steps land on the redo stack above the cancelled
// preview's entry; redo brings them back but never the preview.
test("redo brings back the user's undone steps, never a cancelled preview", async () => {
  const html = "<p>Hello world</p>";
  const bold = "<p><b>Hello</b> world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  select(win, "Hello");
  assert(engine.apply({ op: "bold" }));
  const boldCount = editor.getModificationCount();
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(engine.previewActive, "preview shown");
  engine.cancelPreview();
  assertEqual(editorHTML(win), bold);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(!engine.previewActive, "no preview while the bold is redoable");
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), bold);
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), bold);
  assertEqual(editor.getModificationCount(), boldCount);
  win.goDoCommand("cmd_undo");
  win.goDoCommand("cmd_undo");   // nothing older to undo
  assertEqual(editorHTML(win), html);
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), bold);
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), bold);
  // With only the preview's entry left above, previews work again.
  select(win, "world");
  engine.preview({ op: "color", value: "#ff0000" });
  assert(engine.previewActive, "preview again");
  engine.cancelPreview();
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), bold);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "the bold was the only step");
  closeCompose(win);
});

test("a preview never makes the mail count as changed and ends before saving", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  assert(!win.gContentChanged && !win.gMsgCompose.bodyModified, "an untouched mail");
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(engine.previewActive, "preview shown");
  assert(!win.gContentChanged && !win.gMsgCompose.bodyModified, "unchanged while the preview is shown");
  await win.AutoSave();
  assert(!win.gAutoSaveKickedIn, "no autosave");
  // Send, save and autosave start with this event, before reading the mail.
  win.dispatchEvent(new win.CustomEvent("compose-prepare-message-start", {
    detail: { msgType: Ci.nsIMsgCompDeliverMode.AutoSaveAsDraft },
  }));
  assert(!engine.previewActive, "the preview ended");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "nothing to undo");
  assert(!win.gContentChanged && !win.gMsgCompose.bodyModified, "still an untouched mail");
  closeCompose(win);
});

test("a preview that changes nothing leaves no undo entry", async () => {
  const html = '<p>Hello <span style="font-family: Georgia;">world</span> there</p>';
  const win = await openCompose({ html });
  const engine = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  select(win, "there");
  engine.preview({ op: "highlight", value: null });
  assert(!engine.previewActive, "nothing to preview");
  assert(!editor.canUndo && !editor.canRedo, "no undo or redo entry");
  // The font the text already has: Gecko rewrites the span, the preview
  // shows it and takes it back.
  select(win, "world");
  engine.preview({ op: "fontFamily", value: "Georgia" });
  engine.cancelPreview();
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "no undo entry");
  // An empty preview after a cancelled one keeps that one's redo guard.
  select(win, "there");
  engine.preview({ op: "color", value: "#ff0000" });
  assert(engine.previewActive, "color preview shown");
  engine.cancelPreview();
  select(win, "there");
  engine.preview({ op: "highlight", value: null });
  assert(!editor.canUndo, "no undo entry");
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), html);
  select(win, "there");
  engine.preview({ op: "color", value: "#ff0000" });
  assert(engine.previewActive, "previews still work");
  engine.cancelPreview();
  assertEqual(editorHTML(win), html);
  // The user's redo survives an empty preview.
  select(win, "there");
  assert(engine.apply({ op: "bold" }));
  win.goDoCommand("cmd_undo");
  select(win, "there");
  engine.preview({ op: "highlight", value: null });
  win.goDoCommand("cmd_redo");
  // editorHTML drops the space between the two elements.
  assertEqual(editorHTML(win), '<p>Hello <span style="font-family: Georgia;">world</span><b>there</b></p>');
  closeCompose(win);
});

test("turning the ribbon off ends a preview", async () => {
  const html = "<p>Hello world</p>";
  const win = await openCompose({ html });
  const editor = win.GetCurrentEditor();
  select(win, "world");
  win.qolCompose.engine.preview({ op: "fontFamily", value: "Georgia" });
  assert(editorHTML(win).includes("Georgia"), "preview shown");
  try {
    await setRibbon(false);
    assertEqual(editorHTML(win), html);
    assert(!editor.canUndo, "nothing to undo");
  } finally {
    await setRibbon(true);
  }
  closeCompose(win);
});

// Format painter

// The painter paints from a compose-window timer after the mouseup; this waits
// for a timer queued after it.
async function mouseUpInEditor(win) {
  win.document.getElementById("messageEditor").contentDocument.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  await new Promise(resolve => win.setTimeout(resolve, 0));
}

function pressWith(win, modifiers, keys) {
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  assert(tip.beginInputTransactionForTests(win), "no key input transaction");
  const held = modifiers.map(key => new win.KeyboardEvent("", { key, code: `${key}Left` }));
  for (const m of held) {
    tip.keydown(m);
  }
  for (const key of keys) {
    const letter = /^[a-z]$/i.test(key);
    const event = new win.KeyboardEvent("", {
      key,
      code: letter ? `Key${key.toUpperCase()}` : key,
      keyCode: letter ? key.toUpperCase().charCodeAt(0) : 0,
    });
    tip.keydown(event);
    tip.keyup(event);
  }
  return {
    release() {
      for (const m of held.reverse()) {
        tip.keyup(m);
      }
    },
  };
}

// Control, not Accel, on macOS too.
function pressPainterKey(win, letter) {
  pressWith(win, ["Control", "Shift"], [letter]).release();
}

function editorCursor(win) {
  const doc = editorDocument(win);
  return doc.defaultView.getComputedStyle(doc.body.firstElementChild).cursor;
}

test("painter copies formatting once", async () => {
  const win = await openCompose({ html: '<p><b style="color: rgb(192, 0, 0)">src</b> one two</p>' });
  const e = win.qolCompose.engine;
  select(win, "src", 1, 1); e.paint.start(false);
  select(win, "one"); await mouseUpInEditor(win);
  assert(/<b[^>]*>one<\/b>/.test(editorHTML(win)) && !e.paint.active);
  closeCompose(win);
});

test("sticky painter keeps going until Esc", async () => {
  const win = await openCompose({ html: "<p><i>src</i> one two</p>" });
  const e = win.qolCompose.engine;
  select(win, "src", 1, 1);
  assert(e.paint.start(true));
  assert(e.paint.active && e.paint.sticky, "sticky painter on");
  select(win, "one");
  await mouseUpInEditor(win);
  assert(/<i[^>]*>one<\/i>/.test(editorHTML(win)), "one painted");
  assert(e.paint.active, "still on after the first selection");
  select(win, "two");
  await mouseUpInEditor(win);
  assert(/<i[^>]*>two<\/i>/.test(editorHTML(win)), "two painted");
  assert(e.paint.active, "still on after the second selection");
  pressKey(win, "Escape");
  assert(!e.paint.active && !e.paint.sticky, "Esc ends it");
  assert(!win.document.documentElement.hasAttribute("data-qol-painter"));
  const html = editorHTML(win);
  select(win, "src");
  await mouseUpInEditor(win);
  assertEqual(editorHTML(win), html);
  closeCompose(win);
});

test("Ctrl+Shift+C / Ctrl+Shift+V copy and apply formatting", async () => {
  const html = "<p><u>src</u> one two</p>";
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  select(win, "src", 1, 1);
  pressPainterKey(win, "C");
  assert(!e.paint.active, "Ctrl+Shift+C captures without starting the painter");
  assert(e.paint.captured?.underline === true, "captured the underline");
  assertEqual(editorHTML(win), html);
  select(win, "two");
  pressPainterKey(win, "V");
  assert(/<u[^>]*>two<\/u>/.test(editorHTML(win)), `two underlined: ${editorHTML(win)}`);
  assert(!e.paint.active);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  // Only while the focus is in the mail: in the subject the keys do nothing to it.
  select(win, "one");
  win.document.getElementById("msgSubject").focus();
  pressPainterKey(win, "V");
  assertEqual(editorHTML(win), html);
  // Thunderbird's own Accel+Shift+V (Paste Without Formatting; Cmd on macOS) stays its own.
  if (AppConstants.platform === "macosx") {
    const calls = spyCommands(win);
    select(win, "one");
    pressWith(win, ["Meta", "Shift"], ["V"]).release();
    assertEqual(calls, ["cmd_pasteNoFormatting"]);
    assertEqual(editorHTML(win), html);
  }
  closeCompose(win);
});

test("turning the ribbon off ends painter and preview cleanly", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  select(win, "world");
  win.qolCompose.engine.preview({ op: "fontSize", value: 36 });
  win.qolCompose.engine.paint.start(true);
  await setRibbon(false);
  assertEqual(editorHTML(win), "<p>Hello world</p>");
  assert(!win.document.documentElement.hasAttribute("data-qol-painter"));
  await setRibbon(true);
  closeCompose(win);
});

test("painter buttons: click once, click again to stop, double-click for sticky; brush cursor over the mail", async () => {
  const html = "<p><b>src</b> one two three</p>";
  const win = await openCompose({ html });
  const { view: v, engine: e } = win.qolCompose;
  const root = win.document.documentElement;
  const pressed = () => ["painter", "painter-large"].map(id => v.control(id).getAttribute("aria-pressed"));
  assertEqual(editorCursor(win), "auto");
  select(win, "src", 1, 1);
  v.control("painter").click();
  assert(e.paint.active && !e.paint.sticky, "a click starts it once");
  assertEqual(pressed(), ["true", "true"]);
  assert(root.hasAttribute("data-qol-painter"));
  assert(editorCursor(win).includes("paint-brush.svg"), `brush over the mail text: ${editorCursor(win)}`);
  assertEqual(editorHTML(win), html);
  v.control("painter").click();
  assert(!e.paint.active, "a click while on stops it");
  assertEqual(pressed(), ["false", "false"]);
  assert(!root.hasAttribute("data-qol-painter"));
  assertEqual(editorCursor(win), "auto");
  // A double-click: two clicks, then dblclick.
  const large = v.control("painter-large");
  for (const [type, detail] of [["click", 1], ["click", 2], ["dblclick", 2]]) {
    large.dispatchEvent(new win.MouseEvent(type, { bubbles: true, detail }));
  }
  assert(e.paint.active && e.paint.sticky, "a double-click keeps it on");
  assertEqual(pressed(), ["true", "true"]);
  select(win, "one");
  await mouseUpInEditor(win);
  assert(/<b[^>]*>one<\/b>/.test(editorHTML(win)), "one painted");
  select(win, "two", 0, 0);
  const shift = pressWith(win, ["Shift"], ["ArrowRight", "ArrowRight", "ArrowRight"]);
  assertEqual(editorDocument(win).getSelection().toString(), "two");
  assert(!/<b[^>]*>two<\/b>/.test(editorHTML(win)), "not while Shift is held");
  shift.release();
  assert(/<b[^>]*>two<\/b>/.test(editorHTML(win)), `two painted: ${editorHTML(win)}`);
  assert(e.paint.active, "sticky");
  win.goDoCommand("cmd_undo");
  assert(!/<b[^>]*>two<\/b>/.test(editorHTML(win)) && /<b[^>]*>one<\/b>/.test(editorHTML(win)), "undo takes back two only");
  v.control("painter").click();
  assert(!e.paint.active && !e.paint.sticky);
  assertEqual(pressed(), ["false", "false"]);
  closeCompose(win);
});

// Trusted mouse events through the pres shell (synthesizeMouseEvent, as EventUtils uses).
// Points are { text, at }: `at` (0..1) along the first occurrence of `text`.
function mouseInEditor(win, from, to = from) {
  const doc = editorDocument(win);
  const view = doc.defaultView;
  const send = (type, x, y, buttons, clickCount) =>
    view.synthesizeMouseEvent(type, x, y, { button: 0, buttons, clickCount, modifiers: 0 }, {});
  const point = ({ text, at }) => {
    const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.data.includes(text)) {
      // keep looking
    }
    assert(node, `text not found in the editor: ${text}`);
    const range = doc.createRange();
    const start = node.data.indexOf(text);
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const box = range.getBoundingClientRect();
    return [box.left + box.width * at, box.top + box.height / 2];
  };
  const [x1, y1] = point(from);
  const [x2, y2] = point(to);
  send("mousedown", x1, y1, 1, 1);
  if (x1 !== x2 || y1 !== y2) {
    send("mousemove", (x1 + x2) / 2, (y1 + y2) / 2, 1, 0);
    send("mousemove", x2, y2, 1, 0);
  }
  send("mouseup", x2, y2, 0, 1);
}

test("painter: a click into the still-selected source only places the cursor; a drag paints", async () => {
  const html = "<p><b>source</b> one two</p>";
  const win = await openCompose({ html });
  const { view: v, engine: e } = win.qolCompose;
  select(win, "source");
  v.control("painter").click();
  assert(e.paint.active, "painter on");
  // A click into the selected source: Gecko collapses the selection only as
  // the button is released. Nothing is painted; the painter waits.
  mouseInEditor(win, { text: "source", at: 0.5 });
  await sleep(100);
  assert(editorDocument(win).getSelection().isCollapsed, "the click placed the cursor");
  assertEqual(editorHTML(win), html);
  assert(e.paint.active, "the painter still waits for a selection");
  assert(!win.GetCurrentEditor().canUndo, "no undo step");
  mouseInEditor(win, { text: "two", at: 0 }, { text: "two", at: 1 });
  await waitFor(() => /<b[^>]*>two<\/b>/.test(editorHTML(win)));
  assert(!e.paint.active, "painted once, off again");
  assert(editorHTML(win).startsWith("<p><b>source</b> one "), `only two painted: ${editorHTML(win)}`);
  closeCompose(win);
});

test("painter in a plain-text mail is disabled and never starts", async () => {
  const win = await openCompose({ html: "x", plainText: true });
  const { view: v, engine: e } = win.qolCompose;
  assert(v.control("painter").disabled && v.control("painter-large").disabled);
  assert(e.paint.start(false) === false && !e.paint.active);
  assert(!win.document.documentElement.hasAttribute("data-qol-painter"));
  const format = { family: "Georgia", sizePt: 12, color: null, highlight: null, bold: true, italic: false, underline: false, strike: false, sub: false, sup: false, style: "normal" };
  assert(e.applyFormat(format) === false);
  closeCompose(win);
});

test("applyFormat is one undo step, or changes nothing when an operation fails", async () => {
  const html = '<p><span style="color: rgb(0, 112, 192);">src</span> one</p>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  select(win, "src", 1, 1);
  const format = e.formatAt();
  assert(Number.isFinite(format.sizePt), "a readable size");
  // A failure at the end (unknown style) and in the middle (invalid size),
  // after other operations already ran in the same transaction.
  for (const broken of [{ ...format, bold: true, style: "nonsense" }, { ...format, bold: true, sizePt: -1 }]) {
    select(win, "one");
    const count = editor.getModificationCount();
    assert(e.applyFormat(broken) === false, "returns false");
    assertEqual(editorHTML(win), html);
    assert(!editor.canUndo, "no undo step left behind");
    assertEqual(editor.getModificationCount(), count);
    // Gecko keeps the undone step for redo; redo must not bring it back.
    win.goDoCommand("cmd_redo");
    assertEqual(editorHTML(win), html);
  }
  // An unreadable (NaN) size is skipped; the rest applies as one step.
  select(win, "one");
  assert(e.applyFormat({ ...format, sizePt: NaN, bold: true }) === true);
  const painted = editorHTML(win);
  assert(/<b[^>]*>one<\/b>/.test(painted) && painted.includes("rgb(0, 112, 192)") && !painted.includes("font-size"), painted);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  assert(!editor.canUndo, "one step");
  closeCompose(win);
});

test("painting keeps a reply's quote and the paragraph's alignment", async () => {
  const html = '<h2 style="font-size: 1.3em; font-weight: bold; margin: 10px 0 4px">Head</h2><p style="text-align: center;">mid</p><blockquote type="cite">quoted</blockquote>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  select(win, "mid", 1, 1);
  e.paint.start(false);
  select(win, "quoted");
  await mouseUpInEditor(win);
  assert(/^<h2[^>]*>Head<\/h2><p style="text-align: center;">mid<\/p><blockquote type="cite">.*quoted.*<\/blockquote>$/.test(editorHTML(win)), `quote kept: ${editorHTML(win)}`);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  select(win, "quoted", 1, 1);
  e.paint.start(false);
  select(win, "mid");
  await mouseUpInEditor(win);
  assert(/<p style="text-align: center;">.*mid.*<\/p><blockquote type="cite">quoted<\/blockquote>$/.test(editorHTML(win)), `no new quote: ${editorHTML(win)}`);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  select(win, "Head", 1, 1);
  e.paint.start(false);
  select(win, "mid");
  await mouseUpInEditor(win);
  assert(/<h2 style="[^"]*text-align: center[^"]*">.*mid.*<\/h2>/.test(editorHTML(win)), editorHTML(win));
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), html);
  closeCompose(win);
});

// Style sets

function withoutStyles(html) {
  return html.replace(/ style="[^"]*"/g, "");
}

function unwrappedHTML(win) {
  const body = editorDocument(win).body.cloneNode(true);
  for (const wrapper of body.querySelectorAll(":scope > div.qol-own-text")) {
    wrapper.replaceWith(...wrapper.childNodes);
  }
  return body.innerHTML.replace(/>\s+</g, "><").trim();
}

test("style set restyles the mail but not quotes or signature", async () => {
  const html = '<h1>Hi</h1><p>Text</p><blockquote type="cite"><p>Old</p></blockquote><div class="moz-signature"><p>Sig</p></div>';
  const win = await openCompose({ html });
  // Thunderbird may normalize the body when it loads it.
  const original = editorHTML(win);
  const doc = win.GetCurrentEditor().document;
  const bodyStyle = doc.body.getAttribute("style");
  assert(win.qolCompose.engine.applyStyleSet("modern"));
  const own = doc.querySelector("body > div.qol-own-text");
  assert(own && own.style.fontFamily.includes("Helvetica Neue") && own.style.fontSize === "11pt", editorHTML(win));
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assert(doc.querySelector("h1").style.color === "rgb(47, 122, 216)");
  assert(doc.querySelector("div.qol-own-text > p").style.margin === "0px 0px 8px");
  assert(!doc.querySelector('blockquote[type="cite"] p').hasAttribute("style"));
  assert(!doc.querySelector(".moz-signature p").hasAttribute("style"));
  // cmd_undo goes to the focused element.
  win.GetCurrentEditorElement().focus();
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  closeCompose(win);
});

function fontOf(el) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  return `${cs.fontFamily} / ${cs.fontSize}`;
}

test("a style set leaves a reply's quote, its header line, a forward and the signature in their own font", async () => {
  const html = '<p>Mine</p><div class="moz-cite-prefix">Am 17.10.26 schrieb Anna:<br></div>' +
    '<blockquote type="cite"><p>Old</p><pre class="moz-quote-pre">Older</pre></blockquote>' +
    '<div class="moz-forward-container">-------- Weitergeleitete Nachricht --------<p>Fwd</p></div>' +
    '<div class="moz-signature">-- <br>Sig</div>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  const spared = [".moz-cite-prefix", 'blockquote[type="cite"] p', "pre.moz-quote-pre", ".moz-forward-container p", ".moz-signature"]
    .map(selector => doc.querySelector(selector));
  assert(spared.every(Boolean), editorHTML(win));
  const mine = () => [...doc.querySelectorAll("p")].find(p => p.textContent === "Mine");
  const before = spared.map(fontOf);
  const original = editorHTML(win);
  const bodyStyle = doc.body.getAttribute("style");
  for (const [key, font] of [["modern", '"Helvetica Neue", Arial, sans-serif / 14.6667px'], ["classic", 'Georgia, "Times New Roman", serif / 16px'], ["compact", '-apple-system, "Segoe UI", sans-serif / 13.3333px']]) {
    assert(e.applyStyleSet(key), key);
    assertEqual(e.activeSet, key);
    assertEqual(fontOf(mine()), font);
    assertEqual(spared.map(fontOf), before);
    // The body never carries a set: Gmail drops it, and everything inherits it.
    assertEqual(doc.body.getAttribute("style"), bodyStyle);
  }
  assert(e.applyStyleSet("default"));
  assertEqual(e.activeSet, "default");
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("a style set reaches every stretch of an answer written between quotes", async () => {
  const html = '<p>Top</p><blockquote type="cite"><p>A</p></blockquote><p>Between</p>' +
    '<blockquote type="cite"><p>B</p></blockquote>Loose text<br><p>Bottom</p>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  const original = editorHTML(win);
  const quoted = [...doc.querySelectorAll('blockquote[type="cite"] p')];
  const quotedBefore = quoted.map(fontOf);
  assert(e.applyStyleSet("modern"));
  for (const text of ["Top", "Between", "Bottom"]) {
    const p = [...doc.querySelectorAll("p")].find(el => el.textContent === text);
    assertEqual(fontOf(p), '"Helvetica Neue", Arial, sans-serif / 14.6667px');
  }
  const loose = [...doc.body.querySelectorAll("*")].find(el => [...el.childNodes].some(n => n.nodeType === 3 && n.data.includes("Loose")));
  assertEqual(fontOf(loose), '"Helvetica Neue", Arial, sans-serif / 14.6667px');
  assertEqual(quoted.map(fontOf), quotedBefore);
  win.GetCurrentEditorElement().focus();
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  assertEqual(e.activeSet, "default");
  closeCompose(win);
});

test("a style set keeps the selection, and new paragraphs keep the set's font", async () => {
  const win = await openCompose({ html: '<p>Hello world</p><blockquote type="cite"><p>Old</p></blockquote>' });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  select(win, "world");
  assert(e.applyStyleSet("classic"));
  assertEqual(doc.getSelection().toString(), "world");
  select(win, "world", 5, 5);
  doc.execCommand("insertParagraph");
  doc.execCommand("insertText", false, "Next");
  const next = [...doc.querySelectorAll("p")].find(p => p.textContent === "Next");
  assert(next, editorHTML(win));
  assertEqual(fontOf(next), 'Georgia, "Times New Roman", serif / 16px');
  assertEqual(fontOf(doc.querySelector('blockquote[type="cite"] p')), fontOf(doc.body));
  closeCompose(win);
});

test("a set stored on the body is recognized and taken out", async () => {
  const win = await openCompose({ html: '<p>Hello world</p><blockquote type="cite"><p>Old</p></blockquote>' });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  // Older add-on versions stored Modern as the last declarations of the body.
  doc.body.setAttribute("style", 'color: rgb(1, 2, 3); font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11pt');
  assertEqual(e.activeSet, "modern");
  assert(e.applyStyleSet("classic"));
  assertEqual(doc.body.getAttribute("style"), "color: rgb(1, 2, 3)");
  assertEqual(fontOf(doc.querySelector('blockquote[type="cite"] p')), fontOf(doc.body));
  assertEqual(e.activeSet, "classic");
  closeCompose(win);
});

// Stores the default style set as the options page does and waits until the ribbon has it.
async function setDefaultSet(key) {
  const ext = WebExtensionPolicy.getByID(ADDON_ID).extension;
  const db = await storage();
  const { settings = {} } = await db.get(["settings"]);
  const changes = await db.set({ settings: { ...settings, compose: { ...(settings.compose || {}), styleSet: key } } });
  if (changes) {
    ExtensionStorageIDB.notifyListeners(ext.id, changes);
  }
  const win = await openCompose({ html: "<p>x</p>", type: Ci.nsIMsgCompType.Draft });
  try {
    await waitFor(() => win.qolCompose.defaultStyleSet === key);
  } finally {
    closeCompose(win);
  }
}

async function storedDefaultSet() {
  const db = await storage();
  const { settings } = await db.get(["settings"]);
  return settings?.compose?.styleSet;
}

function assertUntouched(win) {
  const editor = win.GetCurrentEditor();
  assert(!editor.canUndo, "nothing to undo");
  assert(!editor.documentModified, "the editor counts no change");
  assert(!win.gContentChanged && !win.gMsgCompose.bodyModified, "the mail does not count as changed");
}

test("new mails, replies and forwards open with the default style set, as if they came with it", async () => {
  const open = await openCompose({ html: "<p>Open before</p>" });
  try {
    await setDefaultSet("modern");
    // A mail already open keeps its set.
    assertEqual(open.qolCompose.engine.activeSet, "default");
    const quote = '<blockquote type="cite"><p>Old</p></blockquote>';
    for (const [name, type] of [["New", Ci.nsIMsgCompType.New], ["Reply", Ci.nsIMsgCompType.Reply], ["ReplyAll", Ci.nsIMsgCompType.ReplyAll], ["ForwardInline", Ci.nsIMsgCompType.ForwardInline]]) {
      const win = await openCompose({ html: `<p>Mine</p>${quote}`, type });
      const doc = editorDocument(win);
      assertEqual([name, win.qolCompose.engine.activeSet], [name, "modern"]);
      const mine = [...doc.querySelectorAll("p")].find(p => p.textContent === "Mine");
      assertEqual(fontOf(mine), '"Helvetica Neue", Arial, sans-serif / 14.6667px');
      assertEqual(fontOf(doc.querySelector('blockquote[type="cite"] p')), fontOf(doc.body));
      assertUntouched(win);
      // Default takes it out as one undo step, like a set the user chose.
      assert(win.qolCompose.engine.applyStyleSet("default"));
      win.GetCurrentEditorElement().focus();
      win.goDoCommand("cmd_undo");
      assertEqual(win.qolCompose.engine.activeSet, "modern");
      closeCompose(win);
    }
  } finally {
    closeCompose(open);
    await setDefaultSet("default");
  }
});

test("drafts, templates and plain-text mail keep what they have", async () => {
  try {
    await setDefaultSet("classic");
    const draft = await openCompose({ html: "<p>Draft</p>", type: Ci.nsIMsgCompType.Draft });
    assertEqual(draft.qolCompose.engine.activeSet, "default");
    assertUntouched(draft);
    closeCompose(draft);
    const saved = '<div class="qol-own-text" style="font-family: &quot;Helvetica Neue&quot;, Arial, sans-serif; font-size: 11pt"><p>Saved</p></div>';
    for (const type of [Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompType.Template, Ci.nsIMsgCompType.EditAsNew]) {
      const win = await openCompose({ html: saved, type });
      assertEqual(win.qolCompose.engine.activeSet, "modern");
      closeCompose(win);
    }
    const plain = await openCompose({ html: "Plain", plainText: true });
    assertEqual(plain.qolCompose.engine.activeSet, "default");
    assert(!plain.GetCurrentEditor().canUndo, "nothing to undo");
    closeCompose(plain);
  } finally {
    await setDefaultSet("default");
  }
});

test("Set as default in the style set list makes the mail's set the one new mails start with", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const v = win.qolCompose.view;
  try {
    assert(win.qolCompose.engine.applyStyleSet("compact"));
    v.selectTab("format");
    await waitFor(() => v.valueOf("styleset") === "compact");
    const popup = await openPicker(win, "styleset", v.control("styleset"));
    const item = popup.querySelector('menuitem[data-action="set-default"]');
    assert(item, "Set as default entry");
    const label = item.getAttribute("label");
    assert(label === "Als Standard festlegen" || label === "Set as default", label);
    await choose(popup, item);
    await waitFor(() => win.qolCompose.defaultStyleSet === "compact");
    assertEqual(await storedDefaultSet(), "compact");
    assertEqual(win.qolCompose.engine.activeSet, "compact");
    const next = await openCompose({ html: "<p>Next</p>" });
    assertEqual(next.qolCompose.engine.activeSet, "compact");
    closeCompose(next);
  } finally {
    closeCompose(win);
    await setDefaultSet("default");
  }
});

test("Default removes a style set again", async () => {
  // Default-set Styles blocks, a centred paragraph, a Quote holding a reply's quote,
  // a reply's quote holding a styled quote, and a signature.
  const quote = "margin: 8px 0; padding-left: 10px; border-left: 3px solid #c8c8c8; color: #555555";
  const html = '<h1 style="font-size: 1.6em; font-weight: bold; margin: 12px 0 6px">Hi</h1><p>Text</p>' +
    '<p style="text-align: center">Mid</p>' +
    `<blockquote style="${quote}"><p>Styled</p><blockquote type="cite"><p>Nested</p></blockquote></blockquote>` +
    '<blockquote type="cite"><p>Old</p><blockquote style="margin: 8px 0">Older</blockquote></blockquote>' +
    '<div class="moz-signature"><p>Sig</p></div>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  // Thunderbird's compose font, as a body style of its own.
  doc.body.setAttribute("style", "font-family: Verdana; color: rgb(1, 2, 3);");
  const original = editorHTML(win);
  const bodyStyle = doc.body.getAttribute("style");
  assertEqual(e.activeSet, "default");
  assert(e.applyStyleSet("modern"));
  assertEqual(e.activeSet, "modern");
  const text = () => [...doc.querySelectorAll("p")].find(p => p.textContent === "Text");
  assert(fontOf(text()).includes("Helvetica Neue"), "Modern changed the mail's own text");
  assert(e.applyStyleSet("classic"));
  assertEqual(e.activeSet, "classic");
  assertEqual(fontOf(text()), 'Georgia, "Times New Roman", serif / 16px');
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assert(doc.querySelector("h1").style.color === "rgb(91, 127, 184)" && doc.querySelector("h1").style.fontSize === "1.6em", editorHTML(win));
  assert(text().style.margin === "0px 0px 10px", editorHTML(win));
  const mid = [...doc.querySelectorAll("p")].find(p => p.textContent === "Mid");
  assert(mid.style.textAlign === "center" && mid.style.marginBottom === "10px", "the centred paragraph stays centred");
  const inside = text => [...doc.querySelectorAll("p")].find(p => p.textContent === text);
  assert(inside("Styled").style.marginBottom === "10px", "a paragraph in a Quote is the set's paragraph");
  for (const text of ["Nested", "Old", "Sig"]) {
    assert(!inside(text).hasAttribute("style"), `${text} untouched`);
  }
  assertEqual(doc.querySelector('blockquote[type="cite"] blockquote').getAttribute("style"), "margin: 8px 0");
  // Style sets only set style attributes and wrap the mail's own text: no
  // block is made, moved or unwrapped.
  assertEqual(withoutStyles(unwrappedHTML(win)), withoutStyles(original));
  const classic = editorHTML(win);
  assert(e.applyStyleSet("nonsense") === false, "unknown set");
  assertEqual(editorHTML(win), classic);
  assertEqual(e.activeSet, "classic");
  assert(e.applyStyleSet("default"));
  assertEqual(e.activeSet, "default");
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("new headings use the active set", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const e = win.qolCompose.engine;
  assert(e.applyStyleSet("classic"));
  select(win, "world");
  assert(e.apply({ op: "style", value: "heading1" }));
  const h1 = editorDocument(win).querySelector("h1");
  assert(h1 && h1.style.color === "rgb(91, 127, 184)", editorHTML(win));
  assert(h1.getAttribute("style").includes("color: #5b7fb8"), h1.getAttribute("style"));
  closeCompose(win);
});

test("style sets keep the mail's text color and are recognized without one", async () => {
  const win = await openCompose({ html: "<h1>Title</h1><p>Hello world</p>" });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  // A dark editor: Thunderbird's own text color on the body.
  doc.body.setAttribute("style", "color: rgb(240, 240, 240);");
  const original = editorHTML(win);
  for (const key of ["modern", "classic", "compact"]) {
    assert(e.applyStyleSet(key), key);
    assertEqual(e.activeSet, key);
    assertEqual(doc.body.style.color, "rgb(240, 240, 240)");
    assert(!doc.body.getAttribute("style").includes("null"), doc.body.getAttribute("style"));
  }
  assert(e.applyStyleSet("default"));
  assertEqual(e.activeSet, "default");
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("a style set preview leaves no trace", async () => {
  const html = '<h1>Hi</h1><p>Text</p><blockquote type="cite"><p>Old</p></blockquote><div class="moz-signature"><p>Sig</p></div>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  const doc = editorDocument(win);
  select(win, "Text");
  const original = editorHTML(win);
  const bodyStyle = doc.body.getAttribute("style");
  const count = editor.getModificationCount();
  assert(!editor.canUndo, "a new mail has nothing to undo");
  assert(e.preview({ op: "styleSet", value: "modern" }), "preview shown");
  const text = [...doc.querySelectorAll("p")].find(p => p.textContent === "Text");
  assert(fontOf(text).endsWith("14.6667px") && doc.querySelector("h1").style.color === "rgb(47, 122, 216)", "the whole mail shows the set");
  assertEqual(editor.getModificationCount(), count);
  e.cancelPreview();
  assertEqual(editorHTML(win), original);
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assertEqual(editor.getModificationCount(), count);
  assert(!editor.canUndo, "no undo step left");
  assertEqual(e.activeSet, "default");
  assertEqual(doc.getSelection().toString(), "Text");
  // The preview is never replayed.
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), original);
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  // Later headings are in the real set, not the previewed one.
  assert(e.apply({ op: "style", value: "heading2" }));
  const h2 = doc.querySelector("h2");
  assert(h2 && !h2.style.color, editorHTML(win));
  closeCompose(win);
});

test("a style set preview that changes nothing keeps the mail's set", async () => {
  const win = await openCompose({ html: "<h1>Hi</h1><p>Hello world</p>" });
  const e = win.qolCompose.engine;
  const editor = win.GetCurrentEditor();
  const doc = editorDocument(win);
  select(win, "world");
  const original = editorHTML(win);
  const bodyStyle = doc.body.getAttribute("style");
  assert(e.applyStyleSet("modern"));
  const modern = editorHTML(win);
  const modernBody = doc.body.getAttribute("style");
  const count = editor.getModificationCount();
  // Modern again would change nothing: no preview, no undo step.
  assert(e.preview({ op: "styleSet", value: "modern" }) === false, "no preview");
  assert(!e.previewActive, "no preview shown");
  assertEqual(e.activeSet, "modern");
  assertEqual(editorHTML(win), modern);
  assertEqual(doc.body.getAttribute("style"), modernBody);
  assertEqual(editor.getModificationCount(), count);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assert(!editor.canUndo, "one undo step");
  closeCompose(win);
});

test("a style set leaves a forwarded message alone", async () => {
  const forwarded = '<div class="moz-forward-container">-------- Forwarded Message --------<p>Fwd</p><h1>Head</h1><p style="color: red; font-family: Arial">Styled</p></div>';
  const win = await openCompose({ html: `<p>Mine</p>${forwarded}` });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  // Thunderbird drops the color when it loads the mail; set as written.
  doc.querySelector(".moz-forward-container p[style]").setAttribute("style", "color: red; font-family: Arial");
  const container = () => doc.querySelector(".moz-forward-container").outerHTML;
  const original = container();
  assert(e.applyStyleSet("modern"));
  assert(doc.querySelector("div.qol-own-text > p").style.margin === "0px 0px 8px", "the mail's own paragraph has the set");
  assertEqual(container(), original);
  assert(e.applyStyleSet("default"));
  assertEqual(container(), original);
  closeCompose(win);
});

test("a style set changes only its own declarations; Default leaves every block as it was", async () => {
  // A plain <blockquote> is what Thunderbird's Indent makes.
  const html = '<p style="color: red; font-family: Arial">Own</p><h1>Head</h1><blockquote>Indented</blockquote><p>Plain</p>';
  const win = await openCompose({ html });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  // Thunderbird drops the color when it loads the mail; set as written.
  doc.querySelector("p").setAttribute("style", "color: red; font-family: Arial");
  const original = editorHTML(win);
  assert(e.applyStyleSet("modern"));
  const own = doc.querySelector("p");
  assertEqual(own.getAttribute("style"), "margin: 0 0 8px; color: red; font-family: Arial");
  assert(own.style.color === "red" && own.style.fontFamily === "Arial", "the paragraph's own declarations stay");
  assertEqual(doc.querySelector("h1").getAttribute("style"), "color: #2f7ad8");
  assert(!doc.querySelector("blockquote").hasAttribute("style"), "a quote gets nothing of a set");
  assertEqual(unwrappedHTML(win).replaceAll("margin: 0 0 8px; ", "").replace(' style="margin: 0 0 8px"', "").replace(' style="color: #2f7ad8"', ""), original);
  assert(e.applyStyleSet("compact"));
  assertEqual(own.getAttribute("style"), "margin: 0 0 2px; color: red; font-family: Arial");
  assert(!doc.querySelector("h1").hasAttribute("style"), "Compact has no heading color");
  assert(e.applyStyleSet("default"));
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("undoing a style set leaves no set: the dropdown shows Default, a new Heading 1 has no set color", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const e = win.qolCompose.engine;
  const v = win.qolCompose.view;
  select(win, "world");
  const original = editorHTML(win);
  assert(e.applyStyleSet("modern"));
  await waitFor(() => v.valueOf("styleset") === "modern");
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), original);
  assertEqual(e.activeSet, "default");
  await waitFor(() => v.valueOf("styleset") === "default");
  select(win, "world");
  assert(e.apply({ op: "style", value: "heading1" }));
  const h1 = editorDocument(win).querySelector("h1");
  assert(h1 && !h1.style.color, editorHTML(win));
  closeCompose(win);
});

test("Modern, Default, undo, Default: the body's style is the original again", async () => {
  const win = await openCompose({ html: "<p>Hello world</p>" });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  // Thunderbird's compose font, as a body style of its own.
  doc.body.setAttribute("style", "font-family: Verdana; color: rgb(1, 2, 3);");
  const bodyStyle = doc.body.getAttribute("style");
  const original = editorHTML(win);
  select(win, "world");
  assert(e.applyStyleSet("modern"));
  assert(e.applyStyleSet("default"));
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  win.goDoCommand("cmd_undo");
  assertEqual(e.activeSet, "modern");
  assert(fontOf(doc.querySelector("p")).includes("Helvetica Neue"), "Modern is back");
  assert(e.applyStyleSet("default"));
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assertEqual(editorHTML(win), original);
  assert(e.applyStyleSet("modern"));
  assert(e.applyStyleSet("default"));
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assertEqual(editorHTML(win), original);
  closeCompose(win);
});

test("redoing Default takes the set out again, wrappers and all", async () => {
  const win = await openCompose({ html: '<p>Hello world</p><p>Two</p><blockquote type="cite"><p>Old</p></blockquote><p>Below</p>' });
  const e = win.qolCompose.engine;
  const original = editorHTML(win);
  select(win, "world");
  assert(e.applyStyleSet("compact"));
  const compact = editorHTML(win);
  assert(e.applyStyleSet("default"));
  assertEqual(editorHTML(win), original);
  win.goDoCommand("cmd_undo");
  assertEqual(editorHTML(win), compact);
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), original);
  assertEqual(e.activeSet, "default");
  closeCompose(win);
});

test("redoing a style set brings it back: the dropdown and new headings follow", async () => {
  const win = await openCompose({ html: '<p>Hello world</p><p style="text-align: center">More</p>' });
  const e = win.qolCompose.engine;
  const v = win.qolCompose.view;
  const doc = editorDocument(win);
  const bodyStyle = doc.body.getAttribute("style");
  select(win, "world");
  assert(e.applyStyleSet("modern"));
  const modern = editorHTML(win);
  win.goDoCommand("cmd_undo");
  assertEqual(e.activeSet, "default");
  await waitFor(() => v.valueOf("styleset") === "default");
  win.goDoCommand("cmd_redo");
  assertEqual(editorHTML(win), modern);
  assertEqual(e.activeSet, "modern");
  await waitFor(() => v.valueOf("styleset") === "modern");
  select(win, "More");
  assert(e.apply({ op: "style", value: "heading1" }));
  const h1 = doc.querySelector("h1");
  assert(h1 && h1.style.color === "rgb(47, 122, 216)", editorHTML(win));
  // Default takes the set out of the new heading too (the Styles write it
  // before the alignment they keep).
  assert(/color: #2f7ad8; text-align: center/.test(h1.getAttribute("style")), h1.getAttribute("style"));
  assert(e.applyStyleSet("default"));
  assertEqual(doc.body.getAttribute("style"), bodyStyle);
  assertEqual(doc.querySelector("h1").getAttribute("style"), "font-size: 1.6em; font-weight: bold; margin: 12px 0 6px; text-align: center");
  closeCompose(win);
});

test("a style set finds its paragraph spacing after Indent and Outdent rewrote the margin", async () => {
  // Indent and Outdent rewrite the style attribute: after Modern,
  // "margin: 0 0 8px" becomes "margin: 0px 0px 8px 40px;", then
  // "margin-top: 0px; margin-right: 0px; margin-bottom: 8px;".
  const win = await openCompose({ html: "<p>Hello world</p><p>Two</p><p>Three</p>" });
  const e = win.qolCompose.engine;
  const doc = editorDocument(win);
  const view = doc.defaultView;
  const paragraph = text => [...doc.querySelectorAll("p")].find(p => p.textContent === text);
  // Thunderbird drops some declarations when it loads the mail; set as written.
  paragraph("Three").setAttribute("style", "color: red");
  const original = editorHTML(win);
  const threeStyle = paragraph("Three").style.cssText;
  select(win, "Hello");
  assert(e.applyStyleSet("modern"));
  select(win, "Hello");
  assert(e.apply({ op: "indent" }));
  const hello = paragraph("Hello world");
  assert(/40px/.test(hello.getAttribute("style")), hello.getAttribute("style"));
  assert(e.applyStyleSet("compact"));
  assertEqual([view.getComputedStyle(hello).marginBottom, view.getComputedStyle(hello).marginLeft], ["2px", "40px"]);
  assert(!/8px/.test(hello.getAttribute("style")), `no Modern spacing left: ${hello.getAttribute("style")}`);
  assert(e.applyStyleSet("default"));
  assert(!/(^|[;\s])margin(-bottom)?:/.test(hello.getAttribute("style")), `no set spacing: ${hello.getAttribute("style")}`);
  assertEqual(hello.style.marginLeft, "40px");
  assert(e.applyStyleSet("modern"));
  for (const text of ["Two", "Three"]) {
    select(win, text);
    assert(e.apply({ op: "indent" }));
    select(win, text);
    assert(e.apply({ op: "outdent" }));
  }
  assert(/margin-bottom: 8px/.test(paragraph("Two").getAttribute("style")), paragraph("Two").getAttribute("style"));
  assert(e.applyStyleSet("default"));
  assert(!paragraph("Two").hasAttribute("style"), paragraph("Two").getAttribute("style"));
  assertEqual(paragraph("Three").style.cssText, threeStyle);
  // The whole mail is as it was, except the indent of the first paragraph.
  assertEqual(editorHTML(win).replace(/<p style="[^"]*">Hello world/, "<p>Hello world").replace(/<p style="color: red;?">/, '<p style="color: red">'), original);
  closeCompose(win);
});

// Runner

for (const win of composeWindows()) {
  closeCompose(win);
}
await setRibbon(true);
await resetComposeState();

const result = { passed: 0, failed: [] };
for (const { name, fn } of tests) {
  try {
    await fn();
    result.passed++;
  } catch (e) {
    result.failed.push({ name, error: String(e?.message ?? e) });
  } finally {
    // A failed test may leave its window open (never with a save prompt) and
    // the ribbon collapsed, which later windows would inherit.
    for (const win of [...opened]) {
      win.qolCompose?.view?.setCollapsed(false);
      closeCompose(win);
    }
    // A failed setRibbon(false) must not leave the ribbon off for later tests.
    if (result.failed.at(-1)?.name === name) {
      await setRibbon(true).catch(() => {});
    }
  }
}
return result;
