/* A classic script, not a module: the experiment loads it into a sandbox, the tests with vm. */
"use strict";

var qolFormatting = (() => {
  const SIZES = Object.freeze([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]);

  function nextSize(pt) {
    return SIZES.find(s => s > pt) ?? SIZES[SIZES.length - 1];
  }

  function previousSize(pt) {
    return [...SIZES].reverse().find(s => s < pt) ?? SIZES[0];
  }

  function ptFromPx(px) {
    return Math.round(px * 0.75 * 2) / 2;
  }

  function firstFamily(css) {
    return String(css || "").split(",")[0].replace(/["']/g, "").trim();
  }

  function hexFromRgb(css) {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(String(css || "").trim());
    if (!m) {
      return null;
    }
    if (m[4] !== undefined && parseFloat(m[4]) === 0) {
      return null;
    }
    return "#" + [m[1], m[2], m[3]]
      .map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0"))
      .join("");
  }

  const STYLE_KEYS = Object.freeze(["normal", "heading1", "heading2", "heading3", "quote", "code"]);
  const STYLES = Object.freeze({
    normal: Object.freeze({ block: "p", style: "" }),
    heading1: Object.freeze({ block: "h1", style: "font-size: 1.6em; font-weight: bold; margin: 12px 0 6px" }),
    heading2: Object.freeze({ block: "h2", style: "font-size: 1.3em; font-weight: bold; margin: 10px 0 4px" }),
    heading3: Object.freeze({ block: "h3", style: "font-size: 1.1em; font-weight: bold; margin: 8px 0 4px" }),
    quote: Object.freeze({
      block: "blockquote",
      style: "margin: 8px 0; padding-left: 10px; border-left: 3px solid #c8c8c8; color: #555555",
    }),
    code: Object.freeze({
      block: "pre",
      style: "font-family: Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f4; padding: 6px 8px; border-radius: 4px",
    }),
  });

  const STYLE_SET_KEYS = Object.freeze(["default", "modern", "classic", "compact"]);
  // No set changes the text color, so the mail stays readable on light and dark
  // backgrounds; heading colors keep 3:1 contrast on both (tests/compose-formatting.test.js).
  const STYLE_SETS = Object.freeze({
    default: Object.freeze({ fontFamily: null, fontSize: null, color: null, headingColor: null, paragraphMargin: null }),
    modern: Object.freeze({
      fontFamily: '"Helvetica Neue", Arial, sans-serif', fontSize: "11pt", color: null,
      headingColor: "#2f7ad8", paragraphMargin: "0 0 8px",
    }),
    classic: Object.freeze({
      fontFamily: 'Georgia, "Times New Roman", serif', fontSize: "12pt", color: null,
      headingColor: "#5b7fb8", paragraphMargin: "0 0 10px",
    }),
    compact: Object.freeze({
      fontFamily: '-apple-system, "Segoe UI", sans-serif', fontSize: "10pt", color: null,
      headingColor: null, paragraphMargin: "0 0 2px",
    }),
  });

  function blockStyle(styleKey, setKey) {
    const style = STYLES[styleKey] || STYLES.normal;
    const set = STYLE_SETS[setKey] || STYLE_SETS.default;
    const parts = style.style ? [style.style] : [];
    if (/^heading/.test(styleKey) && set.headingColor) {
      parts.push("color: " + set.headingColor);
    }
    if (styleKey === "normal" && set.paragraphMargin) {
      parts.push("margin: " + set.paragraphMargin);
    }
    return parts.join("; ");
  }

  function styleForBlock(tagName) {
    switch (String(tagName || "").toUpperCase()) {
      case "H1": return "heading1";
      case "H2": return "heading2";
      case "H3": return "heading3";
      case "BLOCKQUOTE": return "quote";
      case "PRE": return "code";
      default: return "normal";
    }
  }

  // 10 theme columns (white, black, 8 hues) x 5 shades, light to dark.
  const TEXT_THEME = Object.freeze([
    ["#ffffff", "#f2f2f2", "#d9d9d9", "#bfbfbf", "#a6a6a6"],
    ["#7f7f7f", "#595959", "#404040", "#262626", "#000000"],
    ["#dce6f2", "#b8cce4", "#95b3d7", "#4f81bd", "#17375e"],
    ["#f2dcdb", "#e6b8b7", "#da9694", "#c0504d", "#632523"],
    ["#ebf1de", "#d8e4bc", "#c4d79b", "#9bbb59", "#4f6228"],
    ["#e4dfec", "#ccc0da", "#b1a0c7", "#8064a2", "#403151"],
    ["#daeef3", "#b7dee8", "#92cddc", "#4bacc6", "#215967"],
    ["#fdeada", "#fbd5b5", "#fac08f", "#f79646", "#984807"],
    ["#fff2cc", "#ffe699", "#ffd966", "#ffc000", "#7f6000"],
    ["#e2f0d9", "#c5e0b4", "#a9d18e", "#70ad47", "#375623"],
  ].map(column => Object.freeze(column)));
  const TEXT_STANDARD = Object.freeze([
    "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050",
    "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0",
  ]);
  const HIGHLIGHTS = Object.freeze([
    "#ffff00", "#00ff00", "#00ffff", "#ff00ff", "#0000ff",
    "#ff0000", "#000080", "#008080", "#008000", "#800080",
    "#800000", "#808000", "#808080", "#c0c0c0", "#000000",
  ]);
  const DEFAULT_COLORS = Object.freeze({ text: "#c00000", highlight: "#ffff00" });

  function pushRecent(list, item, max = 5) {
    return [item, ...(list || []).filter(x => x !== item)].slice(0, max);
  }

  function captureFormat(cs, blockTag) {
    const decoration = String(cs.textDecorationLine || "");
    const weight = cs.fontWeight === "bold" ? 700 : cs.fontWeight === "normal" ? 400 : parseInt(cs.fontWeight, 10);
    return {
      family: firstFamily(cs.fontFamily),
      sizePt: ptFromPx(parseFloat(cs.fontSize)),
      color: hexFromRgb(cs.color),
      highlight: hexFromRgb(cs.backgroundColor),
      bold: weight >= 600,
      italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
      underline: decoration.includes("underline"),
      strike: decoration.includes("line-through"),
      sub: cs.verticalAlign === "sub",
      sup: cs.verticalAlign === "super",
      style: styleForBlock(blockTag),
    };
  }

  // Toggles carry booleans: the engine flips the state when the value is undefined.
  function formatToOperations(f) {
    return [
      { op: "fontFamily", value: f.family },
      { op: "fontSize", value: f.sizePt },
      { op: "color", value: f.color },
      { op: "highlight", value: f.highlight },
      { op: "bold", value: !!f.bold },
      { op: "italic", value: !!f.italic },
      { op: "underline", value: !!f.underline },
      { op: "strike", value: !!f.strike },
      { op: "subscript", value: !!f.sub },
      { op: "superscript", value: !!f.sup },
      { op: "style", value: f.style },
    ];
  }

  return {
    SIZES, nextSize, previousSize, ptFromPx, firstFamily, hexFromRgb,
    STYLES, STYLE_KEYS, STYLE_SETS, STYLE_SET_KEYS, blockStyle, styleForBlock,
    TEXT_THEME, TEXT_STANDARD, HIGHLIGHTS, DEFAULT_COLORS, pushRecent,
    captureFormat, formatToOperations,
  };
})();
