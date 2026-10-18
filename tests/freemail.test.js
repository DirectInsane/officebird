import { test } from "node:test";
import assert from "node:assert/strict";
import { isFreemail, FREEMAIL_DOMAINS } from "../background/freemail.js";

test("built-in freemail domains match", () => {
  assert.equal(isFreemail("gmx.de", []), true);
  assert.ok(FREEMAIL_DOMAINS.has("gmail.com"));
});

test("user additions match, others do not", () => {
  assert.equal(isFreemail("example.org", ["example.org"]), true);
  assert.equal(isFreemail("paypal.com", []), false);
});
