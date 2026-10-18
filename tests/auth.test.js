import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthResults, evaluateAuth } from "../background/auth.js";

const TRUSTED = ["mx.provider.example"];
const OK =
  "mx.provider.example; dkim=pass header.d=example.com header.s=s1; spf=pass smtp.mailfrom=example.com; dmarc=pass (p=reject dis=none) header.from=example.com";

test("trusted dmarc=pass is authenticated", () => {
  assert.deepEqual(evaluateAuth(OK, "example.com", TRUSTED), { authenticated: true, dmarcPass: true });
});

test("nothing trusted fails safe", () => {
  assert.equal(evaluateAuth(OK, "example.com", []).authenticated, false);
});

test("authserv-id match is case-insensitive", () => {
  assert.equal(evaluateAuth(OK, "example.com", ["MX.PROVIDER.EXAMPLE"]).authenticated, true);
});

test("untrusted authserv-id is ignored", () => {
  assert.equal(evaluateAuth("evil.example; dmarc=pass", "example.com", TRUSTED).authenticated, false);
});

test("aligned dkim=pass authenticates without dmarc pass; version number after id is ignored", () => {
  const dkimOnly = "mx.provider.example 1; dkim=pass header.d=mail.example.com; dmarc=none";
  assert.deepEqual(evaluateAuth(dkimOnly, "example.com", TRUSTED), { authenticated: true, dmarcPass: false });
});

test("unaligned dkim=pass does not authenticate", () => {
  const dkimOther = "mx.provider.example; dkim=pass header.d=attacker.net; dmarc=fail";
  assert.equal(evaluateAuth(dkimOther, "example.com", TRUSTED).authenticated, false);
});

test("only the topmost header counts (forged pass below a real fail)", () => {
  const forgedBelow = "mx.provider.example; dmarc=fail header.from=paypal.com\nmx.provider.example; dmarc=pass header.from=paypal.com";
  assert.equal(evaluateAuth(forgedBelow, "paypal.com", TRUSTED).authenticated, false);
});

test("garbage and empty input", () => {
  assert.equal(parseAuthResults(""), null);
  assert.equal(parseAuthResults(undefined), null);
  assert.equal(evaluateAuth("garbage ;;; ===", "x.com", ["x"]).authenticated, false);
});

test("parseAuthResults extracts methods and properties", () => {
  const parsed = parseAuthResults(OK);
  assert.equal(parsed.authservId, "mx.provider.example");
  assert.deepEqual(parsed.results[0], { method: "dkim", result: "pass", props: { "header.d": "example.com", "header.s": "s1" } });
  assert.equal(parsed.results[2].method, "dmarc");
});

test("rankAuthservIds counts topmost authserv-ids, most frequent first", async () => {
  const { rankAuthservIds } = await import("../background/auth.js");
  const ranked = rankAuthservIds([
    "mx.provider.example; dmarc=pass",
    "mx.provider.example 1; dkim=pass header.d=a.com\nspoof.example; dmarc=pass",
    "MX.PROVIDER.EXAMPLE; spf=pass",
    "mx.google.com; dmarc=pass",
    "",
    "garbage",
  ]);
  assert.deepEqual(ranked, [{ id: "mx.provider.example", count: 3 }, { id: "mx.google.com", count: 1 }]);
});

test("semicolons inside quoted strings and nested comments are not separators", () => {
  const quoted = 'mx.provider.example; spf=pass smtp.mailfrom="x;dmarc=pass"@evil.com; dmarc=fail header.from=bank.com';
  assert.equal(evaluateAuth(quoted, "bank.com", TRUSTED).authenticated, false);
  const nested = "mx.provider.example; spf=pass (sender x) ;dmarc=pass (y) smtp.mailfrom=evil.com; dmarc=fail header.from=bank.com";
  assert.equal(evaluateAuth(nested, "bank.com", TRUSTED).authenticated, false);
  const nestedDeep = "mx.provider.example; spf=pass ((a);dmarc=pass) smtp.mailfrom=evil.com; dmarc=none";
  assert.equal(evaluateAuth(nestedDeep, "bank.com", TRUSTED).authenticated, false);
});

test("any non-pass dmarc result fails", () => {
  assert.equal(evaluateAuth("mx.provider.example; dmarc=pass; dmarc=fail", "bank.com", TRUSTED).dmarcPass, false);
  assert.equal(evaluateAuth("mx.provider.example; dmarc=pass; dmarc=fail", "bank.com", TRUSTED).authenticated, false);
});

test("a quoted authserv-id-looking value does not split the header", () => {
  const parsed = parseAuthResults('mx.provider.example; dkim=pass header.d=example.com header.b="ab;cd"');
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].props["header.b"], "ab;cd");
});

test("sibling domains under a shared public suffix are not aligned", () => {
  assert.equal(evaluateAuth("mx.provider.example; dkim=pass header.d=evil.com.sg", "bank.com.sg", TRUSTED).authenticated, false);
  assert.equal(evaluateAuth("mx.provider.example; dkim=pass header.d=bank.com.sg", "mail.bank.com.sg", TRUSTED).authenticated, true);
});

test("Gmail-style header.i=@domain counts as the DKIM identity", () => {
  const gmail = "mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc; spf=pass; dmarc=none";
  assert.deepEqual(evaluateAuth(gmail, "example.com", ["mx.google.com"]), { authenticated: true, dmarcPass: false });
  const user = "mx.google.com; dkim=pass header.i=news@mail.example.com; dmarc=none";
  assert.equal(evaluateAuth(user, "example.com", ["mx.google.com"]).authenticated, true);
  const other = "mx.google.com; dkim=pass header.i=@attacker.net; dmarc=none";
  assert.equal(evaluateAuth(other, "example.com", ["mx.google.com"]).authenticated, false);
  const failed = "mx.google.com; dkim=fail header.i=@example.com; dmarc=none";
  assert.equal(evaluateAuth(failed, "example.com", ["mx.google.com"]).authenticated, false);
});

test("header.d wins over header.i when both are present", () => {
  const both = "mx.google.com; dkim=pass header.d=attacker.net header.i=@example.com; dmarc=none";
  assert.equal(evaluateAuth(both, "example.com", ["mx.google.com"]).authenticated, false);
});

test("dominantAuthservId needs a 60 % share", async () => {
  const { dominantAuthservId } = await import("../background/auth.js");
  assert.equal(dominantAuthservId([{ id: "a.example", count: 6 }, { id: "b.example", count: 4 }]), "a.example");
  assert.equal(dominantAuthservId([{ id: "a.example", count: 5 }, { id: "b.example", count: 5 }]), null);
  assert.equal(dominantAuthservId([]), null);
});
