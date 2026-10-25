import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, normalizeSettings, toExperimentConfig, loadSettings, saveSettings,
  trustedIdsFor, pruneServers, normalizeComposeState, STYLE_SETS,
} from "../background/settings.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("undefined input gives defaults", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("garbage"), DEFAULT_SETTINGS);
});

test("hostile and out-of-range values are clamped or replaced", () => {
  const s = normalizeSettings({
    preview: { lines: 9 },
    bar: { opacity: -5, background: "red;} * {display:none", text: "#ABCDEF" },
    icons: { trustedByServer: { server1: [" MX.PROVIDER.EXAMPLE ", "mx.provider.example", ""] }, bimi: { resolver: "evil" } },
  });
  assert.equal(s.preview.lines, 5);
  assert.equal(s.bar.opacity, 0);
  assert.equal(s.bar.background, "#e8e8e8");
  assert.equal(s.bar.text, "#abcdef");
  assert.deepEqual(s.icons.trustedByServer, { server1: ["mx.provider.example"] });
  assert.equal(s.icons.bimi.resolver, "cloudflare");
});

test("numeric coercion and lower bound", () => {
  assert.equal(normalizeSettings({ preview: { lines: 0 } }).preview.lines, 1);
  assert.equal(normalizeSettings({ preview: { lines: "3" } }).preview.lines, 3);
  assert.equal(normalizeSettings({ preview: { lines: "x" } }).preview.lines, 2);
  assert.equal(normalizeSettings({ preview: { lines: 2.6 } }).preview.lines, 3);
});

test("booleans and non-array lists", () => {
  const s = normalizeSettings({ icons: { enabled: "yes", freemailExtra: "a.com" }, bar: { compact: true } });
  assert.equal(s.icons.enabled, true);
  assert.deepEqual(s.icons.freemailExtra, []);
  assert.equal(s.bar.compact, true);
});

test("toExperimentConfig maps defaults", () => {
  assert.deepEqual(toExperimentConfig(DEFAULT_SETTINGS), {
    iconsEnabled: true,
    preview: { enabled: true, lines: 2, tableLines: 1, tone: 45 },
    bar: { background: "#e8e8e8", text: "#333333", opacity: 60, compact: false },
    table: { dateStyle: "smart" },
    style: { outlook: true, barWidth: 3, cardRadius: 7, cardGap: 4, readSender: 62, readSubject: 100, groupHeaders: true, expandGroups: true, cardLook: "theme" },
    compose: { ribbon: true, styleSet: "default" },
  });
});

test("outlook style sliders are clamped", () => {
  const s = normalizeSettings({ style: { barWidth: 9, cardRadius: -2, cardGap: "6" } });
  assert.equal(s.style.barWidth, 6);
  assert.equal(s.style.cardRadius, 0);
  assert.equal(s.style.cardGap, 6);
  assert.equal(normalizeSettings({ style: { barWidth: 1, cardRadius: 40, cardGap: 30 } }).style.barWidth, 2);
  assert.equal(normalizeSettings({ style: { cardRadius: 40 } }).style.cardRadius, 12);
  assert.equal(normalizeSettings({ style: { cardGap: 30 } }).style.cardGap, 12);
});

test("read mail and preview tones are clamped percentages", () => {
  const s = normalizeSettings({ style: { readSender: 10, readSubject: "150" }, preview: { tone: 99 } });
  assert.equal(s.style.readSender, 40);
  assert.equal(s.style.readSubject, 100);
  assert.equal(s.preview.tone, 80);
  assert.equal(normalizeSettings({ preview: { tone: 5 } }).preview.tone, 30);
  assert.equal(normalizeSettings({ style: { readSender: "x" } }).style.readSender, 62);
});

test("card look must be a known look", () => {
  for (const look of ["theme", "outline", "filled", "both"]) {
    assert.equal(normalizeSettings({ style: { cardLook: look } }).style.cardLook, look);
  }
  assert.equal(normalizeSettings({ style: { cardLook: "neon" } }).style.cardLook, "theme");
  assert.equal(normalizeSettings({}).style.cardLook, "theme");
});

test("compact group headers are a boolean, on by default", () => {
  assert.equal(normalizeSettings({}).style.groupHeaders, true);
  assert.equal(normalizeSettings({ style: { groupHeaders: false } }).style.groupHeaders, false);
});

test("date groups open expanded unless switched off", () => {
  assert.equal(normalizeSettings({}).style.expandGroups, true);
  assert.equal(normalizeSettings({ style: { expandGroups: false } }).style.expandGroups, false);
});

test("outlook style is a boolean, on by default", () => {
  assert.equal(normalizeSettings({}).style.outlook, true);
  assert.equal(normalizeSettings({ style: { outlook: false } }).style.outlook, false);
});

test("table preview lines are clamped to 1-3", () => {
  assert.equal(normalizeSettings({ preview: { tableLines: 7 } }).preview.tableLines, 3);
  assert.equal(normalizeSettings({ preview: { tableLines: 0 } }).preview.tableLines, 1);
  assert.equal(normalizeSettings({ preview: { tableLines: "2" } }).preview.tableLines, 2);
});

test("date style must be a known style", () => {
  assert.equal(normalizeSettings({ table: { dateStyle: "relative" } }).table.dateStyle, "relative");
  assert.equal(normalizeSettings({ table: { dateStyle: "thunderbird" } }).table.dateStyle, "thunderbird");
  assert.equal(normalizeSettings({ table: { dateStyle: "<script>" } }).table.dateStyle, "smart");
});

test("load/save round-trip through a storage area", async () => {
  const data = {};
  const area = {
    async get(key) { return { [key]: data[key] }; },
    async set(obj) { Object.assign(data, obj); },
  };
  assert.deepEqual(await loadSettings(area), DEFAULT_SETTINGS);
  const changed = normalizeSettings({ preview: { lines: 4 } });
  await saveSettings(area, changed);
  assert.equal((await loadSettings(area)).preview.lines, 4);
});

test("trustedByServer drops bad keys, non-lists and empty lists", () => {
  const s = normalizeSettings({
    icons: { trustedByServer: { server1: ["a.example"], "bad key": ["b.example"], server2: "c.example", server3: [], "": ["d"] } },
  });
  assert.deepEqual(s.icons.trustedByServer, { server1: ["a.example"] });
  assert.deepEqual(normalizeSettings({ icons: { trustedByServer: ["x"] } }).icons.trustedByServer, {});
});

test("trustedIdsFor only returns the card's own account list", () => {
  const s = normalizeSettings({ icons: { trustedByServer: { server1: ["mx.provider.example"], server2: ["mx.google.com"] } } });
  assert.deepEqual(trustedIdsFor(s, "server1"), ["mx.provider.example"]);
  assert.deepEqual(trustedIdsFor(s, "server2"), ["mx.google.com"]);
  assert.deepEqual(trustedIdsFor(s, "server9"), []);
  assert.deepEqual(trustedIdsFor(s, undefined), []);
  assert.deepEqual(trustedIdsFor(s, "__proto__"), []);
  assert.deepEqual(trustedIdsFor(s, "constructor"), []);
});

test("pruneServers forgets accounts that no longer exist", () => {
  const s = normalizeSettings({ icons: { trustedByServer: { server1: ["a.example"], server2: ["b.example"] } } });
  const pruned = pruneServers(s, ["server2", "server3"]);
  assert.deepEqual(pruned.icons.trustedByServer, { server2: ["b.example"] });
  assert.deepEqual(s.icons.trustedByServer, { server1: ["a.example"], server2: ["b.example"] });
});

test("compose ribbon is on by default and a boolean", () => {
  assert.equal(normalizeSettings({}).compose.ribbon, true);
  assert.equal(normalizeSettings({ compose: { ribbon: false } }).compose.ribbon, false);
  assert.deepEqual(toExperimentConfig(DEFAULT_SETTINGS).compose, { ribbon: true, styleSet: "default" });
});

test("new mails start with Default unless another style set is chosen", () => {
  assert.equal(normalizeSettings({}).compose.styleSet, "default");
  assert.equal(normalizeSettings({ compose: { styleSet: "classic" } }).compose.styleSet, "classic");
  assert.equal(toExperimentConfig(normalizeSettings({ compose: { styleSet: "modern" } })).compose.styleSet, "modern");
  for (const bad of ["fancy", "", 3, null, "__proto__"]) {
    assert.equal(normalizeSettings({ compose: { styleSet: bad } }).compose.styleSet, "default", String(bad));
  }
});

test("the settings know the same style sets as the compose ribbon", () => {
  const context = {};
  vm.runInNewContext(readFileSync(new URL("../experiments/compose/formatting.js", import.meta.url), "utf8"), context);
  assert.deepEqual([...STYLE_SETS], [...context.qolFormatting.STYLE_SET_KEYS]);
});

test("compose state falls back to defaults and is validated", () => {
  assert.deepEqual(normalizeComposeState(undefined), {
    collapsed: false, recentFonts: [], lastColors: { text: "#c00000", highlight: "#ffff00" },
  });
  const s = normalizeComposeState({
    collapsed: "yes",
    recentFonts: ["Arial", 3, "", "Georgia", "Arial", "A", "B", "C", "D"],
    lastColors: { text: "#00FF00", highlight: "red;}" },
  });
  assert.equal(s.collapsed, true);
  assert.deepEqual(s.recentFonts, ["Arial", "Georgia", "A", "B", "C"]);
  assert.deepEqual(s.lastColors, { text: "#00ff00", highlight: "#ffff00" });
  assert.equal(normalizeComposeState({ recentFonts: ["x".repeat(101)] }).recentFonts.length, 0);
});
