import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/qol/dateformat.js", import.meta.url), "utf8"), context);
const { format, full, STYLES } = context.qolDateFormat;

const now = new Date(2026, 9, 17, 15, 0); // Sat 17 Oct 2026, 15:00
const at = (...args) => new Date(...args);

test("styles offered", () => {
  assert.deepEqual([...STYLES], ["smart", "relative", "date", "datetime", "thunderbird"]);
});

test("smart: time today, weekday this week, day+month this year, short date before", () => {
  assert.equal(format(at(2026, 9, 17, 13, 0), "smart", now, "de-DE"), "13:00");
  assert.equal(format(at(2026, 9, 15, 9, 5), "smart", now, "de-DE"), "Do 09:05");
  assert.equal(format(at(2026, 9, 11, 9, 5), "smart", now, "de-DE"), "So 09:05");
  assert.equal(format(at(2026, 9, 10, 9, 5), "smart", now, "de-DE"), "10. Okt.");
  assert.equal(format(at(2026, 2, 3, 8, 0), "smart", now, "de-DE"), "3. März");
  assert.equal(format(at(2025, 9, 17, 8, 0), "smart", now, "de-DE"), "17.10.25");
});

test("relative: minutes and hours ago, yesterday, then dates", () => {
  assert.equal(format(at(2026, 9, 17, 14, 59, 40), "relative", now, "de-DE"), "jetzt");
  assert.equal(format(at(2026, 9, 17, 14, 55), "relative", now, "de-DE"), "vor 5 Min.");
  assert.equal(format(at(2026, 9, 17, 12, 0), "relative", now, "de-DE"), "vor 3 Std.");
  assert.equal(format(at(2026, 9, 16, 20, 0), "relative", now, "de-DE"), "gestern");
  assert.equal(format(at(2026, 9, 12, 20, 0), "relative", now, "de-DE"), "12. Okt.");
  assert.equal(format(at(2024, 0, 2, 20, 0), "relative", now, "de-DE"), "02.01.24");
});

test("date and datetime are fixed formats", () => {
  assert.equal(format(at(2026, 9, 17, 13, 0), "date", now, "de-DE"), "17.10.26");
  assert.equal(format(at(2026, 9, 17, 13, 0), "datetime", now, "de-DE"), "17.10.26, 13:00");
});

test("future dates (clock skew) don't say 'in 5 min'", () => {
  assert.equal(format(at(2026, 9, 17, 15, 5), "relative", now, "de-DE"), "jetzt");
  assert.equal(format(at(2026, 9, 19, 9, 0), "smart", now, "de-DE"), "19. Okt.");
});

test("thunderbird style and bad input return null so the original text stays", () => {
  assert.equal(format(at(2026, 9, 17, 13, 0), "thunderbird", now, "de-DE"), null);
  assert.equal(format(new Date(NaN), "smart", now, "de-DE"), null);
  assert.equal(format(at(2026, 9, 17, 13, 0), "bogus", now, "de-DE"), null);
});

test("full date for the tooltip", () => {
  assert.equal(full(at(2026, 9, 15, 9, 5), "de-DE"), "Donnerstag, 15. Oktober 2026 um 09:05");
});

test("settings and formatter agree on the styles", async () => {
  const { DATE_STYLES } = await import("../background/settings.js");
  assert.deepEqual(DATE_STYLES, [...STYLES]);
});
