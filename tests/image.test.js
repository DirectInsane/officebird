import { test } from "node:test";
import assert from "node:assert/strict";
import { responseToDataUrl, sha256Hex, DDG_PLACEHOLDER_SHA256, MAX_ICON_BYTES } from "../background/image.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const resp = (body, status, type) => new Response(body, { status, headers: { "content-type": type } });

test("accepts a small image as data URL", async () => {
  const url = await responseToDataUrl(resp(png, 200, "image/png"));
  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(url, "data:image/png;base64," + Buffer.from(png).toString("base64"));
});

test("rejects non-200, non-image and oversized responses", async () => {
  assert.equal(await responseToDataUrl(resp(png, 404, "image/png")), null);
  assert.equal(await responseToDataUrl(resp("<html>", 200, "text/html")), null);
  assert.equal(MAX_ICON_BYTES, 102400);
  assert.equal(await responseToDataUrl(resp(new Uint8Array(102401), 200, "image/png")), null);
  assert.ok(await responseToDataUrl(resp(new Uint8Array(102400), 200, "image/png")));
});

test("content-type parameters are ignored", async () => {
  assert.match(await responseToDataUrl(resp("<svg/>", 200, "image/svg+xml; charset=utf-8")), /^data:image\/svg\+xml;base64,/);
});

test("placeholder icon is rejected", async () => {
  const ok200 = () => resp(png, 200, "image/png");
  assert.equal(await responseToDataUrl(ok200(), { placeholderHash: await sha256Hex(png.buffer) }), null);
  assert.equal(DDG_PLACEHOLDER_SHA256, "e5db88ea2322863ca17817b99d60006c625a31cff0dad49cf05d3c6d16a75c17");
});
