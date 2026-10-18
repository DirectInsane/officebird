import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBimiRecord, lookupBimiLogoUrl, RESOLVERS } from "../background/bimi.js";

test("parseBimiRecord extracts https logo URL", () => {
  assert.equal(parseBimiRecord("v=BIMI1; l=https://ex.com/logo.svg; a=https://ex.com/vmc.pem"), "https://ex.com/logo.svg");
});

test("parseBimiRecord rejects non-https, empty and non-BIMI", () => {
  assert.equal(parseBimiRecord("v=BIMI1; l=http://ex.com/logo.svg"), null);
  assert.equal(parseBimiRecord("v=BIMI1; l="), null);
  assert.equal(parseBimiRecord("v=spf1 -all"), null);
  assert.equal(parseBimiRecord(""), null);
});

test("lookupBimiLogoUrl queries DoH JSON and joins split TXT strings", async () => {
  const fakeFetch = async (url, opts) => {
    assert.equal(url, "https://dns.quad9.net:5053/dns-query?name=default._bimi.example.com&type=TXT");
    assert.equal(opts.headers.accept, "application/dns-json");
    assert.equal(opts.credentials, "omit");
    return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v=BIMI1; l=https://ex.com/" "logo.svg"' }] }));
  };
  assert.equal(await lookupBimiLogoUrl("example.com", "quad9", fakeFetch), "https://ex.com/logo.svg");
});

test("lookupBimiLogoUrl returns null when there is definitively no record", async () => {
  assert.equal(await lookupBimiLogoUrl("example.com", "quad9", async () => new Response(JSON.stringify({ Status: 3 }))), null);
  assert.equal(await lookupBimiLogoUrl("example.com", "quad9", async () => new Response(JSON.stringify({ Status: 0 }))), null);
  assert.equal(RESOLVERS.cloudflare, "https://cloudflare-dns.com/dns-query");
});

test("lookupBimiLogoUrl rejects on transient failures so they aren't cached", async () => {
  await assert.rejects(lookupBimiLogoUrl("example.com", "quad9", async () => { throw new Error("offline"); }));
  await assert.rejects(lookupBimiLogoUrl("example.com", "quad9", async () => new Response("busy", { status: 503 })));
  await assert.rejects(lookupBimiLogoUrl("example.com", "cloudflare", async () => new Response("nope")));
  await assert.rejects(lookupBimiLogoUrl("example.com", "quad9", async () => new Response(JSON.stringify({ Status: 2 }))));
});

test("logo URLs on IP literals, localhost or single-label hosts are rejected", () => {
  for (const host of ["127.0.0.1", "10.0.0.5", "[::1]", "[fe80::1]", "localhost", "LOCALHOST.", "printer.localhost", "0x7f.1", "2130706433", "intranet"]) {
    assert.equal(parseBimiRecord(`v=BIMI1; l=https://${host}/logo.svg`), null, host);
  }
  assert.equal(parseBimiRecord("v=BIMI1; l=https://ex.com:8443/logo.svg"), "https://ex.com:8443/logo.svg");
  assert.equal(parseBimiRecord("v=BIMI1; l=https://1.example/logo.svg"), "https://1.example/logo.svg");
});
