import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Gecko drops chrome-only properties from moz-extension sheets like ribbon.css,
// so the ribbon sets them in its own style element (CHROME_CSS in view.js).
const sheet = readFileSync(new URL("../experiments/compose/ribbon.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../experiments/compose/view.js", import.meta.url), "utf8");
const chromeCss = (/const CHROME_CSS = `([^`]*)`/.exec(view) ?? [])[1] ?? "";

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
}

test("ribbon.css doesn't try to set window dragging (Gecko drops it there)", () => {
  assert.doesNotMatch(sheet, /-moz-window-dragging/);
});

test("the window can be moved by its tab row, as by the toolbar the ribbon hides", () => {
  assert.match(rule(chromeCss, "#qol-ribbon .qol-tabrow") ?? "", /-moz-window-dragging:\s*drag/);
});

test("buttons and fields in the tab row stay clickable", () => {
  assert.match(rule(chromeCss, "#qol-ribbon .qol-tabrow :is(button, input)") ?? "", /-moz-window-dragging:\s*no-drag/);
});

test("the group area below the tab row stays clickable", () => {
  assert.match(rule(chromeCss, "#qol-ribbon .qol-panels") ?? "", /-moz-window-dragging:\s*no-drag/);
});

test("the ribbon as a whole is not no-drag: no-drag areas are cut out of drag areas", () => {
  assert.equal(rule(chromeCss, "#qol-ribbon"), null);
});

test("icons still get their context colors", () => {
  assert.match(rule(chromeCss, "#qol-ribbon img") ?? "", /-moz-context-properties:\s*fill, fill-opacity/);
});

test("the title line drags too: the hidden toolbar used to reach up behind it", () => {
  assert.match(rule(chromeCss, "html[data-qol-ribbon] #titlebar") ?? "", /-moz-window-dragging:\s*drag/);
});
