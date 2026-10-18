import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/qol/previewtext.js", import.meta.url), "utf8"), context);
const { clean } = context.qolPreviewText;

test("newsletter preheader padding (zero-width non-joiner + space) disappears", () => {
  const padded = "Persönliche Informationen abrufen. " + "‌ ".repeat(80) + "Bank-Logo Sehr geehrter Herr Mustermann";
  assert.equal(clean(padded), "Persönliche Informationen abrufen. Bank-Logo Sehr geehrter Herr Mustermann");
});

test("other invisible padding characters disappear", () => {
  const chars = ["​", "‌", "⁠", "﻿", "­", "͏", "⠀", "ㅤ", "ᅟ", "ᅠ", "ﾠ", "᠎"];
  for (const c of chars) {
    assert.equal(clean(`a${c}${c} ${c} b`), "a b", `U+${c.codePointAt(0).toString(16)}`);
  }
});

test("all kinds of whitespace collapse to one space", () => {
  assert.equal(clean("  one  two\r\n\tthree four  "), "one two three four");
});

test("emoji joined with zero-width joiner stay intact", () => {
  assert.equal(clean("Familie 👨‍👩‍👧 ist da"), "Familie 👨‍👩‍👧 ist da");
});

test("empty and missing text give an empty string", () => {
  assert.equal(clean(""), "");
  assert.equal(clean(undefined), "");
  assert.equal(clean("‌ ‌ "), "");
});

// Some senders put character references into plain text; Thunderbird's own preview shows them raw.

test("named character references become their characters", () => {
  assert.equal(clean("vielen Dank f&uuml;r Deine Bestellung"), "vielen Dank für Deine Bestellung");
  assert.equal(clean("&Auml;rger, &ouml;l, Stra&szlig;e, 5&nbsp;&euro; &ndash; &bdquo;gut&ldquo; &hellip;"), "Ärger, öl, Straße, 5 € – „gut“ …");
  assert.equal(clean("Tom &amp; Jerry &copy; &trade;"), "Tom & Jerry © ™");
});

test("numeric character references become their characters", () => {
  assert.equal(clean("f&#252;r f&#xFC;r f&#XfC;r &#128512;"), "für für für 😀");
  // As in browsers: 128–159 are Windows-1252 (en dash, euro, quotes).
  assert.equal(clean("a &#150; b &#128; &#147;c&#148;"), "a – b € “c”");
});

test("references that name no character become the replacement character", () => {
  assert.equal(clean("a&#0;b&#xD800;c&#x110000;d"), "a�b�c�d");
});

test("decoded markup stays text and nothing is decoded twice", () => {
  // The preview is set as text, so this shows as the characters, never runs.
  assert.equal(clean("&lt;script&gt;alert(1)&lt;/script&gt;"), "<script>alert(1)</script>");
  assert.equal(clean("&amp;uuml; &amp;#252;"), "&uuml; &#252;");
});

test("unknown or unfinished references stay as written", () => {
  assert.equal(clean("&foo; &UUML; &uuml f&uuml r AT&T &#; &#x;"), "&foo; &UUML; &uuml f&uuml r AT&T &#; &#x;");
});

test("references to invisible or control characters disappear like the characters", () => {
  assert.equal(clean("a&shy;b&zwnj;c&#8203;d&#x200B;e&#1;f&#x7f;g"), "abcdefg");
  assert.equal(clean("a&nbsp;&nbsp;&ensp;b"), "a b");
});

test("text direction overrides are removed, so a preview cannot reverse its text", () => {
  assert.equal(clean("Rechnung‮fdp.exe"), "Rechnungfdp.exe");
  assert.equal(clean("a‪b‫c‬d‭e⁦f⁧g⁨h⁩i&#x202E;j"), "abcdefghij");
  // Marks that only set the direction of neutral characters stay.
  assert.equal(clean("a‎b‏c"), "a‎b‏c");
});
