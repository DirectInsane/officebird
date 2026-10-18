import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/compose/labels.js", import.meta.url), "utf8"), context);
const { STRINGS, pickLanguage, label, shortcut } = context.qolComposeLabels;

test("German and English cover the same keys", () => {
  assert.deepEqual(Object.keys(STRINGS.de).sort(), Object.keys(STRINGS.en).sort());
});

test("language follows the UI locale", () => {
  assert.equal(pickLanguage("de-DE"), "de");
  assert.equal(pickLanguage("de"), "de");
  assert.equal(pickLanguage("en-US"), "en");
  assert.equal(pickLanguage("fr"), "en");
});

test("label falls back to English, then the key", () => {
  assert.equal(label("de", "tab.message"), "Nachricht");
  assert.equal(label("en", "tab.format"), "Format text");
  assert.equal(label("de", "no.such.key"), "no.such.key");
});

test("no string is empty", () => {
  for (const lang of ["de", "en"]) {
    for (const [key, text] of Object.entries(STRINGS[lang])) {
      assert.ok(typeof text === "string" && text.trim() !== "", `${lang} ${key}`);
    }
  }
});

test("shortcuts read as the platform writes them: Accel is Cmd on macOS, Ctrl elsewhere", () => {
  const mac = text => shortcut(text, true);
  const other = text => shortcut(text, false);
  assert.equal(mac("Accel+B"), "⌘B");
  assert.equal(other("Accel+B"), "Ctrl+B");
  assert.equal(mac("Accel+Enter"), "⌘↩");
  assert.equal(other("Accel+Enter"), "Ctrl+Enter");
  assert.equal(mac("Ctrl+Shift+C"), "⌃⇧C");
  assert.equal(other("Ctrl+Shift+C"), "Ctrl+Shift+C");
  // Apple's order of modifier symbols: Control, Option, Shift, Command.
  assert.equal(mac("Shift+Accel+Alt+Ctrl+V"), "⌃⌥⇧⌘V");
  assert.equal(other("Accel+Alt+V"), "Ctrl+Alt+V");
  assert.equal(mac("F9"), "F9");
  assert.equal(other("F9"), "F9");
});
