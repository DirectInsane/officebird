import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Classic script; the experiment runs it in a sandbox, so do the same.
const context = {};
vm.runInNewContext(readFileSync(new URL("../experiments/qol/grouprows.js", import.meta.url), "utf8"), context);
const { layout } = context.qolGroupRows;

const R = 80;
const H = 28;
const D = R - H;

test("without header rows nothing is converted", () => {
  const l = layout([], R, H);
  for (const v of [0, 1, 79, 80, 1234.5]) {
    assert.equal(l.toReal(v), v);
    assert.equal(l.toVirtual(v), v);
  }
  assert.equal(l.topSpacer(800), 800);
  assert.equal(l.bottomSpacer(800, 40), 800);
});

test("rows after a header move up by the height it saves", () => {
  const l = layout([0, 15], R, H);
  assert.equal(l.toReal(0), 0);
  assert.equal(l.toReal(1 * R), H);
  assert.equal(l.toReal(15 * R), 15 * R - D);
  assert.equal(l.toReal(16 * R), 16 * R - 2 * D);
  assert.equal(l.toReal(16 * R + 30), 16 * R - 2 * D + 30);
});

test("positions inside a header row are scaled to its real height", () => {
  const l = layout([0], R, H);
  assert.equal(l.toReal(R / 2), H / 2);
  assert.equal(l.toVirtual(H / 2), R / 2);
});

test("toVirtual undoes toReal", () => {
  const l = layout([0, 15, 40, 161], R, H);
  for (let v = 0; v < 312 * R; v += 37) {
    assert.ok(Math.abs(l.toVirtual(l.toReal(v)) - v) < 1e-9, `v=${v}`);
  }
});

test("toReal never goes backwards", () => {
  const l = layout([0, 1, 2, 9], R, H);
  let last = -1;
  for (let v = 0; v < 20 * R; v += 5) {
    const y = l.toReal(v);
    assert.ok(y >= last, `v=${v}`);
    last = y;
  }
});

test("row spans use the real heights", () => {
  const l = layout([0, 15], R, H);
  assert.deepEqual({ ...l.rowSpan(15) }, { top: 15 * R - D, bottom: 15 * R - D + H });
  assert.deepEqual({ ...l.rowSpan(16) }, { top: 16 * R - 2 * D, bottom: 17 * R - 2 * D });
  assert.equal(l.isHeader(15), true);
  assert.equal(l.isHeader(16), false);
});

test("the top spacer stands in for the rows before the buffer", () => {
  const l = layout([0, 15, 40], R, H);
  assert.equal(l.topSpacer(0), 0);
  assert.equal(l.topSpacer(10 * R), 10 * R - D); // rows 0-9 hold header 0
  assert.equal(l.topSpacer(15 * R), 15 * R - D); // header 15 is in the buffer
  assert.equal(l.topSpacer(16 * R), 16 * R - 2 * D);
});

test("the bottom spacer stands in for the rows after the buffer", () => {
  const l = layout([0, 15, 40], R, H);
  // Of 50 rows, 30-49 hold header 40.
  assert.equal(l.bottomSpacer(20 * R, 50), 20 * R - D);
  // Rows 10-49 hold headers 15 and 40.
  assert.equal(l.bottomSpacer(40 * R, 50), 40 * R - 2 * D);
  assert.equal(l.bottomSpacer(0, 50), 0);
});

test("total height counts headers at their real height", () => {
  const l = layout([0, 15, 40, 161], R, H);
  assert.equal(l.totalHeight(312), 312 * R - 4 * D);
});
