import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/compose/formatting.js", import.meta.url), "utf8"), context);
const {
  nextSize, previousSize, ptFromPx, firstFamily, hexFromRgb, STYLES, STYLE_KEYS, STYLE_SETS, STYLE_SET_KEYS,
  blockStyle, TEXT_THEME, TEXT_STANDARD, HIGHLIGHTS, pushRecent, captureFormat, formatToOperations,
} = context.qolFormatting;

test("size steps stay inside the list", () => {
  assert.equal(nextSize(11), 12); assert.equal(nextSize(13), 14); assert.equal(nextSize(72), 72);
  assert.equal(previousSize(11), 10); assert.equal(previousSize(8), 8); assert.equal(previousSize(100), 72);
});
test("px to pt rounds to half points", () => {
  assert.equal(ptFromPx(16), 12); assert.equal(ptFromPx(14.6667), 11); assert.equal(ptFromPx(15), 11.5);
});
test("first family without quotes", () => {
  assert.equal(firstFamily('"Helvetica Neue", Arial, sans-serif'), "Helvetica Neue");
  assert.equal(firstFamily("Georgia"), "Georgia");
});
test("rgb to hex", () => {
  assert.equal(hexFromRgb("rgb(255, 0, 16)"), "#ff0010");
  assert.equal(hexFromRgb("rgba(0, 0, 0, 0)"), null);
  assert.equal(hexFromRgb("transparent"), null);
});
test("styles and style sets have the intended values", () => {
  assert.deepEqual({ ...STYLES.heading1 }, { block: "h1", style: "font-size: 1.6em; font-weight: bold; margin: 12px 0 6px" });
  assert.equal(STYLES.quote.block, "blockquote");
  assert.equal(STYLE_SETS.modern.headingColor, "#2f7ad8");
  assert.equal(STYLE_SETS.compact.paragraphMargin, "0 0 2px");
  assert.deepEqual([...STYLE_KEYS], ["normal", "heading1", "heading2", "heading3", "quote", "code"]);
  assert.deepEqual([...STYLE_SET_KEYS], ["default", "modern", "classic", "compact"]);
});
test("block style combines style and set", () => {
  assert.equal(blockStyle("heading2", "modern"), "font-size: 1.3em; font-weight: bold; margin: 10px 0 4px; color: #2f7ad8");
  assert.equal(blockStyle("normal", "classic"), "margin: 0 0 10px");
  assert.equal(blockStyle("normal", "default"), "");
  assert.equal(blockStyle("heading1", "default"), STYLES.heading1.style);
});
test("palettes are valid hex", () => {
  const hex = /^#[0-9a-f]{6}$/;
  assert.equal(TEXT_THEME.length, 10); assert.ok(TEXT_THEME.every(c => c.length === 5 && c.every(h => hex.test(h))));
  assert.equal(TEXT_STANDARD.length, 10); assert.equal(HIGHLIGHTS.length, 15);
  assert.ok([...TEXT_STANDARD, ...HIGHLIGHTS].every(h => hex.test(h)));
});
test("recent list", () => {
  assert.deepEqual([...pushRecent(["A", "B", "C", "D", "E"], "C")], ["C", "A", "B", "D", "E"]);
  assert.deepEqual([...pushRecent(["A", "B", "C", "D", "E"], "F")], ["F", "A", "B", "C", "D"]);
});
test("capture → operations round trip", () => {
  const f = captureFormat({ fontFamily: '"Georgia", serif', fontSize: "16px", color: "rgb(192, 0, 0)",
    backgroundColor: "rgba(0, 0, 0, 0)", fontWeight: "700", fontStyle: "italic",
    textDecorationLine: "underline line-through", verticalAlign: "super" }, "H2");
  assert.deepEqual({ ...f }, { family: "Georgia", sizePt: 12, color: "#c00000", highlight: null,
    bold: true, italic: true, underline: true, strike: true, sub: false, sup: true, style: "heading2" });
  assert.deepEqual([...formatToOperations(f).map(o => o.op)], ["fontFamily", "fontSize", "color", "highlight",
    "bold", "italic", "underline", "strike", "subscript", "superscript", "style"]);
  assert.equal(formatToOperations(f).find(o => o.op === "subscript").value, false);
});

// WCAG contrast ratio between two #rrggbb colors.
function contrast(a, b) {
  const lum = hex => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("style sets never set the text color, so dark and light editors stay readable", () => {
  for (const key of STYLE_SET_KEYS) {
    assert.equal(STYLE_SETS[key].color, null, key);
  }
});

test("style set heading colors are readable on light and dark mail backgrounds", () => {
  for (const key of STYLE_SET_KEYS) {
    const color = STYLE_SETS[key].headingColor;
    if (color === null) {
      continue;
    }
    assert.ok(contrast(color, "#ffffff") >= 3, `${key} on white: ${contrast(color, "#ffffff").toFixed(2)}`);
    assert.ok(contrast(color, "#2a2a2e") >= 3, `${key} on dark: ${contrast(color, "#2a2a2e").toFixed(2)}`);
  }
});
