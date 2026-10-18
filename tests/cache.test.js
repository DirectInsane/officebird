import { test } from "node:test";
import assert from "node:assert/strict";
import { isFresh, IconCache, memoryStore, POSITIVE_TTL_MS, NEGATIVE_TTL_MS } from "../background/cache.js";

const t0 = 1_000_000;

test("TTL values", () => {
  assert.equal(POSITIVE_TTL_MS, 30 * 864e5);
  assert.equal(NEGATIVE_TTL_MS, 7 * 864e5);
});

test("isFresh honors positive and negative TTL", () => {
  assert.equal(isFresh({ dataUrl: "data:x", fetchedAt: t0 }, t0 + POSITIVE_TTL_MS - 1), true);
  assert.equal(isFresh({ dataUrl: "data:x", fetchedAt: t0 }, t0 + POSITIVE_TTL_MS), false);
  assert.equal(isFresh({ dataUrl: null, fetchedAt: t0 }, t0 + NEGATIVE_TTL_MS - 1), true);
  assert.equal(isFresh({ dataUrl: null, fetchedAt: t0 }, t0 + NEGATIVE_TTL_MS), false);
  assert.equal(isFresh(undefined, t0), false);
});

test("IconCache returns only fresh entries", async () => {
  let now = t0;
  const c = new IconCache(memoryStore(), () => now);
  await c.put("example.com", null, "none");
  assert.deepEqual(await c.get("example.com"), { dataUrl: null, source: "none" });
  now += NEGATIVE_TTL_MS;
  assert.equal(await c.get("example.com"), undefined);
});

test("IconCache clear empties the store", async () => {
  const c = new IconCache(memoryStore(), () => t0);
  await c.put("a.com", "data:x", "ddg");
  await c.clear();
  assert.equal(await c.get("a.com"), undefined);
});
