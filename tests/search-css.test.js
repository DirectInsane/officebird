import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sheet = readFileSync(new URL("../experiments/search/search.css", import.meta.url), "utf8");
const css = sheet.replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[\\n}])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
}

test("an excluded chip is struck through", () => {
  assert.match(rule(".qol-chip.excluded") ?? "", /text-decoration:\s*line-through/);
});

test("colors come from the theme, never hard-coded", () => {
  // Text between braces; before a nested "{" the part after the last ";" is a selector.
  const parts = css.split(/([{}])/);
  const declarations = parts
    .flatMap((part, i) => (parts[i + 1] === "{" ? part.split(";").slice(0, -1) : part.split(";")))
    .map(d => d.trim())
    .filter(d => d && d !== "{" && d !== "}" && d.includes(":") && !d.startsWith("@"));
  assert.ok(declarations.length > 20, "found the declarations");
  for (const declaration of declarations) {
    assert.doesNotMatch(declaration, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i, declaration);
    const [, property, value] = /^([\w-]+)\s*:\s*([\s\S]*)$/.exec(declaration) ?? [];
    if (/^(?:color|background-color|border(?:-[a-z-]+)?-color|outline-color|fill|stroke)$/.test(property ?? "")) {
      assert.match(value, /var\(--|currentColor|transparent|inherit/, declaration);
    }
  }
});

// Gecko drops chrome-only properties from moz-extension sheets; panel.js sets them itself.
test("search.css has no chrome-only properties", () => {
  assert.doesNotMatch(css, /-moz-context-properties|-moz-window-dragging/);
});
