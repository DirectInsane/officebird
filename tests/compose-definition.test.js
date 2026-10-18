import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic scripts; the experiment runs each in a sandbox, so do the same.
const context = {};
for (const file of ["formatting.js", "labels.js", "definition.js"]) {
  vm.runInNewContext(readFileSync(new URL(`../experiments/compose/${file}`, import.meta.url), "utf8"), context);
}
const { qolComposeLabels, qolFormatting } = context;
const { DEFINITION, ICON_BASE, validate } = context.qolRibbonDefinition;

const allControls = () => [
  ...DEFINITION.quickAccess,
  ...DEFINITION.tabs.flatMap(t => t.groups.flatMap(g => g.controls)),
];
const ids = (tab, group) => [...DEFINITION.tabs.find(t => t.id === tab).groups.find(g => g.id === group).controls.map(c => c.id)];
const byId = id => allControls().find(c => c.id === id);

test("the shipped definition is valid", () => {
  assert.deepEqual([...validate(DEFINITION, qolComposeLabels)], []);
});

test("ids are unique and the quick access bar has send, save, attach", () => {
  const all = allControls().map(c => c.id);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...DEFINITION.quickAccess.map(c => c.id)], ["qa-send", "qa-save", "qa-attach"]);
  assert.deepEqual([...DEFINITION.tabs.map(t => t.id)], ["message", "format"]);
});

test("validate reports broken definitions", () => {
  const broken = { quickAccess: [{ id: "x", kind: "button", size: "small", label: "missing.label", formatting: false }], tabs: [] };
  const errors = validate(broken, qolComposeLabels);
  assert.ok(errors.some(e => e.includes("missing.label")));
  assert.ok(errors.some(e => e.includes("x") && e.includes("command")));
});

test("every icon is a Thunderbird skin URL", () => {
  const all = allControls();
  assert.ok(all.filter(c => c.icon).every(c => c.icon.startsWith("chrome://messenger/skin/icons/")));
  assert.ok(all.every(c => c.icon || c.glyph || ["font", "size", "gallery", "styleSet"].includes(c.kind)));
  assert.equal(ICON_BASE, "chrome://messenger/skin/icons/");
});

test("tabs and groups have the intended layout", () => {
  assert.deepEqual([...DEFINITION.tabs[0].groups.map(g => g.id)], ["clipboard", "basic", "include", "check"]);
  assert.deepEqual([...DEFINITION.tabs[1].groups.map(g => g.id)], ["clipboard", "font", "paragraph", "styles", "styleset"]);
  assert.deepEqual(ids("message", "clipboard"), ["paste", "cut", "copy", "painter"]);
  assert.deepEqual(ids("message", "basic"),
    ["font", "size", "size-up", "size-down", "bold", "italic", "underline", "strike", "highlight", "color", "clear"]);
  assert.deepEqual(ids("message", "include"), ["attach", "insert", "contacts"]);
  assert.deepEqual(ids("message", "check"), ["spelling", "security"]);
  assert.deepEqual(ids("format", "clipboard"), ["painter-large"]);
  assert.deepEqual(ids("format", "font"),
    ["f-font", "f-size", "f-size-up", "f-size-down", "f-bold", "f-italic", "f-underline", "f-strike",
      "f-subscript", "f-superscript", "f-highlight", "f-color", "f-clear"]);
  assert.deepEqual(ids("format", "paragraph"),
    ["bullets", "numbers", "outdent", "indent", "align-left", "align-center", "align-right", "align-justify"]);
  assert.deepEqual(ids("format", "styles"), ["styles"]);
  assert.deepEqual(ids("format", "styleset"), ["styleset"]);
});

test("Thunderbird commands and popups", () => {
  const send = byId("qa-send");
  assert.equal(send.kind, "split");
  assert.equal(send.command, "cmd_sendButton");
  assert.deepEqual([...send.menu.map(m => ({ ...m }))], [{ id: "qa-send-later", label: "qa-send-later", command: "cmd_sendLater", icon: "chrome://messenger/skin/icons/new/compact/clock.svg" }]);
  assert.deepEqual([byId("qa-save").kind, byId("qa-save").command, byId("qa-save").popup], ["split", "cmd_saveDefault", "button-save"]);
  assert.deepEqual([byId("qa-attach").kind, byId("qa-attach").command, byId("qa-attach").popup], ["split", "cmd_attachFile", "button-attach"]);
  assert.deepEqual([byId("paste").kind, byId("paste").command], ["split", "cmd_paste"]);
  assert.deepEqual([...byId("paste").menu.map(m => ({ ...m }))], [{ id: "paste-text", label: "paste-text", command: "cmd_pasteNoFormatting" }]);
  assert.equal(byId("cut").command, "cmd_cut");
  assert.equal(byId("copy").command, "cmd_copy");
  assert.equal(byId("attach").command, "cmd_attachFile");
  assert.deepEqual([byId("spelling").kind, byId("spelling").command, byId("spelling").popup], ["split", "cmd_spelling", "spellingButton"]);
  assert.equal(byId("security").popup, "encryptionToolbarMenu");
});

test("Insert opens Thunderbird's Insert menu; Contacts toggles its contacts sidebar", () => {
  const insert = byId("insert");
  assert.deepEqual([insert.kind, insert.size, insert.popup, insert.command], ["split", "large", "InsertPopupButton", undefined]);
  // The command Thunderbird's own Insert button observes (off in plain-text mail).
  assert.equal(insert.enabledBy, "cmd_renderedHTMLEnabler");
  assert.equal(insert.icon, ICON_BASE + "image.svg");
  const contacts = byId("contacts");
  // Thunderbird has no command for the sidebar; its F9 key runs toggleContactsSidebar().
  assert.deepEqual([contacts.kind, contacts.size, contacts.key, contacts.shortcut], ["button", "large", "key_addressSidebar", "F9"]);
  assert.equal(contacts.icon, ICON_BASE + "new/compact/address-book.svg");
});

test("validate rejects shortcuts with unknown modifiers", () => {
  const ctl = extra => ({ id: "contacts", kind: "button", size: "large", label: "contacts", formatting: false, key: "key_x", ...extra });
  for (const good of ["F9", "Accel+B", "Ctrl+Shift+C", "Alt+Accel+V"]) {
    assert.deepEqual([...validate({ quickAccess: [ctl({ shortcut: good })], tabs: [] }, qolComposeLabels)], [], good);
  }
  for (const bad of ["Hyper+F9", "Cmd+B", "Accel+", ""]) {
    const errors = [...validate({ quickAccess: [ctl({ shortcut: bad })], tabs: [] }, qolComposeLabels)];
    assert.ok(errors.some(e => e.includes("shortcut")), `${JSON.stringify(bad)}: ${errors.join()}`);
  }
});

test("validate accepts a control that runs a Thunderbird key", () => {
  const ctl = extra => ({ id: "contacts", kind: "button", size: "large", label: "contacts", formatting: false, ...extra });
  assert.deepEqual([...validate({ quickAccess: [ctl({ key: "key_addressSidebar" })], tabs: [] }, qolComposeLabels)], []);
  assert.ok(validate({ quickAccess: [ctl({})], tabs: [] }, qolComposeLabels).some(e => e.includes("needs a command")));
});

test("icons, glyphs and shortcuts", () => {
  const icon = id => byId(id).icon.slice(ICON_BASE.length);
  assert.deepEqual(
    Object.fromEntries(["qa-send", "qa-save", "qa-attach", "paste", "cut", "copy", "painter", "size-up", "size-down",
      "bold", "italic", "underline", "highlight", "clear", "bullets", "numbers", "outdent", "indent",
      "align-left", "align-center", "align-right", "align-justify", "spelling", "security", "styleset"]
      .map(id => [id, icon(id)])),
    {
      "qa-send": "send.svg", "qa-save": "save.svg", "qa-attach": "attach.svg", paste: "paste.svg", cut: "cut.svg",
      copy: "new/compact/copy.svg", painter: "new/compact/paint-brush.svg", "size-up": "increase.svg",
      "size-down": "decrease.svg", bold: "bold.svg", italic: "italics.svg", underline: "underline.svg",
      highlight: "highlights.svg", clear: "remove-text-styling.svg", bullets: "bullet-list.svg",
      numbers: "number-list.svg", outdent: "outdent.svg", indent: "indent.svg", "align-left": "left-align.svg",
      "align-center": "center-align.svg", "align-right": "right-align.svg", "align-justify": "justify.svg",
      spelling: "spelling.svg", security: "new/compact/lock.svg", styleset: "paragraph.svg",
    });
  assert.equal(byId("qa-send").menu[0].icon, "chrome://messenger/skin/icons/new/compact/clock.svg");
  assert.equal(byId("attach").icon, byId("qa-attach").icon);
  assert.equal(byId("strike").glyph, "S");
  assert.equal(byId("f-subscript").glyph, "x₂");
  assert.equal(byId("f-superscript").glyph, "x²");
  assert.equal(byId("color").glyph, "A");
  // Accel is Cmd on macOS; the painter uses the Control key on every platform.
  assert.deepEqual(
    ["qa-send", "bold", "italic", "underline", "painter", "painter-large", "f-bold", "contacts"].map(id => byId(id).shortcut),
    ["Accel+Enter", "Accel+B", "Accel+I", "Accel+U", "Ctrl+Shift+C", "Ctrl+Shift+C", "Accel+B", "F9"]);
});

test("formatting flag: text formatting only", () => {
  const off = ["qa-send", "qa-save", "qa-attach", "paste", "cut", "copy", "attach", "insert", "contacts", "spelling", "security"];
  for (const c of allControls()) {
    assert.equal(c.formatting, !off.includes(c.id), c.id);
  }
});

test("operations of the toggles and paragraph controls", () => {
  assert.deepEqual({ ...byId("bold").op }, { op: "bold" });
  assert.deepEqual({ ...byId("f-superscript").op }, { op: "superscript" });
  assert.deepEqual({ ...byId("clear").op }, { op: "clearFormatting" });
  assert.deepEqual({ ...byId("bullets").op }, { op: "bulletList" });
  assert.deepEqual({ ...byId("align-justify").op }, { op: "align", value: "justify" });
  assert.deepEqual(["font", "size", "color", "highlight", "styles", "styleset"].map(id => byId(id).kind),
    ["font", "size", "color", "highlight", "gallery", "styleSet"]);
});

test("labels exist for controls, tooltips, groups, tabs and gallery entries", () => {
  const L = qolComposeLabels;
  for (const lang of ["de", "en"]) {
    for (const c of allControls()) {
      assert.ok(L.STRINGS[lang][c.label], `${lang} ${c.label}`);
      assert.ok(L.STRINGS[lang][c.id + ".tip"], `${lang} ${c.id}.tip`);
    }
    for (const key of qolFormatting.STYLE_KEYS) {
      assert.ok(L.STRINGS[lang]["style." + key], `${lang} style.${key}`);
    }
    for (const key of qolFormatting.STYLE_SET_KEYS) {
      assert.ok(L.STRINGS[lang]["styleset." + key], `${lang} styleset.${key}`);
    }
    assert.ok(L.STRINGS[lang]["hint.plainText"]);
  }
  assert.equal(L.label("de", "hint.plainText"), "Nicht verfügbar in Nur-Text-Nachrichten");
  assert.equal(L.label("en", "hint.plainText"), "Not available in plain-text mail");
});

test("validate reports bad ops, sizes and duplicate ids", () => {
  const ctl = extra => ({ id: "a", kind: "toggle", size: "small", label: "bold", formatting: true, ...extra });
  const def = {
    quickAccess: [ctl({ op: { op: "bogus" } }), ctl({ size: "huge", command: "cmd_x" })],
    tabs: [],
  };
  const errors = [...validate(def, qolComposeLabels)];
  assert.ok(errors.some(e => e.includes("bogus")));
  assert.ok(errors.some(e => e.includes("huge")));
  assert.ok(errors.some(e => e.includes("duplicate")));
});
