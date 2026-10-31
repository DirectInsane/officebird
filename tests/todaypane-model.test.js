import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { Intl };
vm.runInNewContext(readFileSync(new URL("../experiments/todaypane/model.js", import.meta.url), "utf8"), context);
const { dayParts, monthParts, dateKey, textOn } = context.qolTodayModel;

const NOW = new Date(2026, 9, 29, 14, 30);

test("dateKey gives the local day as YYYYMMDD", () => {
  assert.equal(dateKey(NOW), "20261029");
  assert.equal(dateKey(new Date(2026, 0, 5, 23, 59)), "20260105");
});

test("dayParts gives weekday, day number and whether it is today, in English", () => {
  assert.deepEqual({ ...dayParts("20261029", NOW, "en-US") }, { weekday: "Thu", day: "29", today: true });
  assert.deepEqual({ ...dayParts("20261031T190000", NOW, "en-GB") }, { weekday: "Sat", day: "31", today: false });
  assert.deepEqual({ ...dayParts("20261102", NOW, "en") }, { weekday: "Mon", day: "2", today: false });
});

test("dayParts follows German and drops the abbreviation dot", () => {
  assert.deepEqual({ ...dayParts("20261029", NOW, "de") }, { weekday: "Do", day: "29", today: true });
  assert.deepEqual({ ...dayParts("20261031", NOW, "de-AT") }, { weekday: "Sa", day: "31", today: false });
});

test("dayParts returns null for anything that is not a date string", () => {
  for (const bad of ["", "2026", "abcdefgh", "20261340", undefined, null]) {
    assert.equal(dayParts(bad, NOW, "en"), null, String(bad));
  }
});

test("monthParts gives the month name and year in the locale", () => {
  assert.deepEqual({ ...monthParts(2026, 9, "en-US") }, { month: "October", year: "2026" });
  assert.deepEqual({ ...monthParts(2026, 9, "de") }, { month: "Oktober", year: "2026" });
  assert.deepEqual({ ...monthParts(2027, 2, "de-CH") }, { month: "März", year: "2027" });
});

test("textOn picks white on dark and black on light highlight colors", () => {
  assert.equal(textOn("#d70022"), "white");
  assert.equal(textOn("#0a84ff"), "white");
  assert.equal(textOn("#000000"), "white");
  assert.equal(textOn("#ffffff"), "black");
  assert.equal(textOn("#ffd60a"), "black");
  assert.equal(textOn("#30d158"), "black");
  assert.equal(textOn("nonsense"), "white");
});
