import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sheet = readFileSync(new URL("../experiments/todaypane/todaypane.css", import.meta.url), "utf8");
const css = sheet.replace(/\/\*[\s\S]*?\*\//g, "");

test("every rule applies only while the experiment marks the window", () => {
  const selectors = css
    .split("}")
    .map(block => block.split("{")[0].trim())
    .filter(Boolean);
  assert.ok(selectors.length > 10, "found the rules");
  for (const group of selectors) {
    // Commas between selectors, not the ones inside :is(…).
    for (const selector of group.split(/,(?![^(]*\))/)) {
      assert.match(selector.trim(), /^:root\[data-qol-todaypane\]/, selector);
    }
  }
});

test("colors come from the theme, never hard-coded", () => {
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i);
});

// Gecko drops chrome-only properties from moz-extension sheets.
test("todaypane.css has no chrome-only properties", () => {
  assert.doesNotMatch(css, /-moz-context-properties|-moz-window-dragging/);
});

test("the highlight is red unless the experiment sets one", () => {
  assert.match(css, /--qol-today-accent:\s*var\(--qol-today-highlight,\s*var\(--color-red-60\)\)/);
  assert.match(css, /--qol-today-on-accent:\s*var\(--qol-today-on-highlight,/);
});
