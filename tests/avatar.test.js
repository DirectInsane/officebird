import { test } from "node:test";
import assert from "node:assert/strict";
import { initialsFor, colorFor } from "../experiments/qol/avatar.mjs";

test("initials from display name", () => {
  assert.equal(initialsFor("John Doe", "j@x.com"), "JD");
  assert.equal(initialsFor("Doe, John", "j@x.com"), "DJ");
  assert.equal(initialsFor("Ölaf Ähm", "o@x.de"), "ÖÄ");
  assert.equal(initialsFor("madonna", "m@x.com"), "M");
  assert.equal(initialsFor('"Quoted Name"', "q@x.com"), "QN");
});

test("initials fall back to email, then ?", () => {
  assert.equal(initialsFor("", "anna.smith@x.com"), "A");
  assert.equal(initialsFor("  ", ""), "?");
  assert.equal(initialsFor(undefined, undefined), "?");
});

test("colorFor is deterministic hsl", () => {
  assert.equal(colorFor("a@b.c"), colorFor("a@b.c"));
  assert.notEqual(colorFor("a@b.c"), colorFor("z@y.x"));
  assert.match(colorFor("a@b.c"), /^hsl\(\d{1,3}, 45%, 45%\)$/);
  assert.match(colorFor(""), /^hsl\(\d{1,3}, 45%, 45%\)$/);
});
