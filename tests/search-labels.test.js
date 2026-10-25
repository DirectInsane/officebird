import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/search/labels.js", import.meta.url), "utf8"), context);
const { pickLanguage, label, STRINGS } = context.qolSearchLabels;

test("every key exists in both languages and is not empty", () => {
  const keys = Object.keys(STRINGS.en);
  assert.ok(keys.length > 30);
  assert.deepEqual(Object.keys(STRINGS.de).sort(), keys.slice().sort());
  for (const lang of ["en", "de"]) {
    for (const key of keys) {
      assert.equal(typeof STRINGS[lang][key], "string", `${lang}.${key}`);
      assert.ok(STRINGS[lang][key].trim().length > 0, `${lang}.${key}`);
    }
  }
});

test("pickLanguage maps German locales to de and everything else to en", () => {
  assert.equal(pickLanguage("de"), "de");
  assert.equal(pickLanguage("de-AT"), "de");
  assert.equal(pickLanguage("de_CH"), "de");
  assert.equal(pickLanguage("fr"), "en");
  assert.equal(pickLanguage("en-US"), "en");
  assert.equal(pickLanguage(""), "en");
  assert.equal(pickLanguage(undefined), "en");
});

test("label returns the text of the language, falling back to English and then the key", () => {
  assert.equal(label("en", "placeholder"), "Search mail");
  assert.equal(label("de", "placeholder"), "E-Mails durchsuchen");
  assert.equal(label("de", "allMailboxes"), "Alle Postfächer");
  assert.equal(label("de", "stillSearching"), "Suche läuft…");
  assert.equal(label("fr", "clear"), "Clear");
  assert.equal(label("en", "nope"), "nope");
});

test("label replaces {name} placeholders from vars", () => {
  assert.equal(label("en", "glodaIndexing", { percent: 42 }),
    "Full-text index is still being built (42 %): body search may miss some mails.");
  assert.equal(label("en", "unknownFolder", { name: "Work" }), "No folder named Work");
  assert.equal(label("de", "offline", { count: 3 }).includes("3"), true);
  assert.equal(label("en", "offline"), "Server not reachable: folders searched only locally: {count}");
});

test("German texts", () => {
  assert.equal(label("de", "tip"), "Begriff anklicken zum Ausschließen · ODER zwischen Begriffen verwenden");
  assert.match(label("de", "glodaOff"), /^Der Volltextindex ist deaktiviert: /);
  assert.equal(label("de", "offline", { count: 1 }), "Server nicht erreichbar: nur lokal durchsuchte Ordner: 1");
  assert.equal(label("de", "closeNotice"), "Schließen");
  assert.equal(label("de", "glodaRestart"), "Starte Thunderbird neu, um den Volltextindex aufzubauen.");
  assert.equal(label("en", "glodaRestart"), "Restart Thunderbird to build the full-text index.");
});
