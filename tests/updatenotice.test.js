import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/qol/updatenotice.js", import.meta.url), "utf8"), context);
const { STRINGS, pickLanguage, texts } = context.qolUpdateNotice;

test("German and English have the same strings, none empty", () => {
  assert.deepEqual(Object.keys(STRINGS.de).sort(), Object.keys(STRINGS.en).sort());
  for (const lang of ["de", "en"]) {
    for (const [key, text] of Object.entries(STRINGS[lang])) {
      assert.ok(typeof text === "string" && text.trim() !== "", `${lang} ${key}`);
    }
  }
});

test("language follows the UI locale", () => {
  assert.equal(pickLanguage("de-DE"), "de");
  assert.equal(pickLanguage("de"), "de");
  assert.equal(pickLanguage("de-AT"), "de");
  assert.equal(pickLanguage("en-US"), "en");
  assert.equal(pickLanguage("fr"), "en");
  assert.equal(pickLanguage("dsb"), "en");
  assert.equal(pickLanguage(undefined), "en");
});

test("the notice names the new version", () => {
  assert.deepEqual({ ...texts("en", "1.2.3") }, {
    message: "Officebird 1.2.3 is ready. It will be installed when Thunderbird restarts.",
    restart: "Restart now",
  });
  assert.deepEqual({ ...texts("de", "1.2.3") }, {
    message: "Officebird 1.2.3 ist bereit und wird beim nächsten Start von Thunderbird installiert.",
    restart: "Jetzt neu starten",
  });
  assert.equal(texts("xx", "2.0.0").restart, "Restart now");
});
