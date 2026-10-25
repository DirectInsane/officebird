import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest parses and has the add-on id", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.browser_specific_settings.gecko.id, "officebird@directinsane.github.io");
});

test("manifest points updates at the latest release", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(
    manifest.browser_specific_settings.gecko.update_url,
    "https://github.com/DirectInsane/officebird/releases/latest/download/updates.json"
  );
});

test("the add-on is called Officebird", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "Officebird");
  const options = await readFile(new URL("../options/options.html", import.meta.url), "utf8");
  assert.match(options, /<title>Officebird<\/title>/);
  assert.match(options, /<h1>Officebird<\/h1>/);
});
