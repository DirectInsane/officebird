import { test } from "node:test";
import assert from "node:assert/strict";
import { createIconResolver } from "../background/icons.js";
import { IconCache, memoryStore } from "../background/cache.js";
import { normalizeSettings } from "../background/settings.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
const AUTH_OK = "mx.provider.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";
const AUTH_DKIM_ONLY = "mx.provider.example; dkim=pass header.d=example.com; dmarc=none";

function setup({ settings = {}, fetchFn, contact = null } = {}) {
  const calls = [];
  const s = normalizeSettings({ icons: { trustedByServer: { server1: ["mx.provider.example"] }, ...settings } });
  const fetchImpl = fetchFn ?? (async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
  const resolver = createIconResolver({
    cache: new IconCache(memoryStore()),
    fetchFn: async (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
    lookupContactPhoto: async () => contact,
    getSettings: () => s,
  });
  return { resolver, calls };
}

const card = (email, authResults = AUTH_OK, serverKey = "server1") => ({ id: `f#${email}`, email, displayName: "", authResults, serverKey });

test("contact photo wins without any fetch", async () => {
  const { resolver, calls } = setup({ contact: "data:c" });
  assert.deepEqual(await resolver.resolve(card("a@example.com", "")), { dataUrl: "data:c", unverified: false });
  assert.equal(calls.length, 0);
});

test("freemail gives initials", async () => {
  const { resolver, calls } = setup();
  assert.deepEqual(await resolver.resolve(card("x@gmx.de", "mx.provider.example; dmarc=pass")), { dataUrl: null, unverified: false });
  assert.equal(calls.length, 0);
});

test("unauthenticated gives unverified initials", async () => {
  const { resolver, calls } = setup();
  assert.deepEqual(await resolver.resolve(card("a@example.com", "")), { dataUrl: null, unverified: true });
  assert.equal(calls.length, 0);
});

test("without any trusted authserv-id, unauthenticated cards get no marker", async () => {
  const { resolver } = setup({ settings: { trustedByServer: {} } });
  assert.deepEqual(await resolver.resolve(card("a@example.com")), { dataUrl: null, unverified: false });
});

test("authenticated sender uses DuckDuckGo with private fetch options", async () => {
  const { resolver, calls } = setup();
  const result = await resolver.resolve(card("a@mail.example.com"));
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.equal(result.unverified, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://icons.duckduckgo.com/ip3/example.com.ico");
  assert.equal(calls[0].opts.credentials, "omit");
  assert.equal(calls[0].opts.referrerPolicy, "no-referrer");
  assert.equal(calls[0].opts.cache, "no-store");
});

test("BIMI is used first when enabled and dmarc passes", async () => {
  const fetchFn = async url => {
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v=BIMI1; l=https://ex.com/logo.svg"' }] }));
    }
    if (url === "https://ex.com/logo.svg") {
      return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
    }
    throw new Error("unexpected " + url);
  };
  const { resolver, calls } = setup({ settings: { bimi: { enabled: true } }, fetchFn });
  const result = await resolver.resolve(card("a@example.com"));
  assert.match(result.dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.ok(!calls.some(c => c.url.includes("duckduckgo")));
});

test("BIMI is skipped when only dkim passes", async () => {
  const { resolver, calls } = setup({ settings: { bimi: { enabled: true } } });
  await resolver.resolve(card("a@example.com", AUTH_DKIM_ONLY));
  assert.deepEqual(calls.map(c => c.url), ["https://icons.duckduckgo.com/ip3/example.com.ico"]);
});

test("cache hit avoids a second fetch for the same domain", async () => {
  const { resolver, calls } = setup();
  await resolver.resolve(card("a@example.com"));
  await resolver.resolve(card("b@sub.example.com"));
  assert.equal(calls.length, 1);
});

test("failures are negatively cached (no retry storm)", async () => {
  const { resolver, calls } = setup({ fetchFn: async () => { throw new Error("offline"); } });
  assert.deepEqual(await resolver.resolve(card("a@example.com")), { dataUrl: null, unverified: false });
  for (let i = 0; i < 10; i++) {
    await resolver.resolve(card(`u${i}@example.com`));
  }
  assert.equal(calls.length, 1);
});

test("concurrent resolves for one domain fetch once", async () => {
  const { resolver, calls } = setup();
  await Promise.all([resolver.resolve(card("a@example.com")), resolver.resolve(card("b@example.com"))]);
  assert.equal(calls.length, 1);
});

test("at most 4 fetches in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const releases = [];
  const fetchFn = () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise(resolve => releases.push(() => {
      inFlight--;
      resolve(new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
    }));
  };
  const { resolver } = setup({ fetchFn });
  const all = Promise.all(Array.from({ length: 10 }, (_, i) => resolver.resolve(card(`a@d${i}.com`))));
  let done = false;
  all.then(() => { done = true; });
  while (!done) {
    await new Promise(r => setTimeout(r, 1));
    while (releases.length) {
      releases.shift()();
    }
  }
  assert.equal(peak, 4);
});

test("no local copy yet gives a neutral pending result without fetching", async () => {
  const { resolver, calls } = setup();
  assert.deepEqual(await resolver.resolve(card("a@example.com", null)), { dataUrl: null, unverified: false, pending: true });
  assert.equal(calls.length, 0);
});

test("transient failures are not persisted, definitive ones are", async () => {
  const store = memoryStore();
  const make = fetchFn => createIconResolver({
    cache: new IconCache(store),
    fetchFn,
    lookupContactPhoto: async () => null,
    getSettings: () => normalizeSettings({ icons: { trustedByServer: { server1: ["mx.provider.example"] } } }),
  });
  await make(async () => { throw new Error("offline"); }).resolve(card("a@example.com"));
  await make(async () => new Response("", { status: 503 })).resolve(card("a@example.com"));
  let calls = 0;
  const online = make(async () => { calls++; return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }); });
  assert.match((await online.resolve(card("a@example.com"))).dataUrl, /^data:image\/png/);
  assert.equal(calls, 1);
  await make(async () => new Response(PNG, { status: 404, headers: { "content-type": "image/png" } })).resolve(card("b@other.com"));
  let calls404 = 0;
  await make(async () => { calls404++; return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }); }).resolve(card("b@other.com"));
  assert.equal(calls404, 0);
});

test("missing email and disabled icons", async () => {
  const { resolver } = setup();
  assert.deepEqual(await resolver.resolve({ id: "x", email: "", displayName: "", authResults: AUTH_OK, serverKey: "server1" }), { dataUrl: null, unverified: false });
  const off = setup({ settings: { enabled: false } });
  assert.deepEqual(await off.resolver.resolve(card("a@example.com")), { dataUrl: null, unverified: false });
  assert.equal(off.calls.length, 0);
});

test("another account's trusted id is not trusted on mail to an account without one", async () => {
  // server2's provider adds no Authentication-Results; a sender forges one with server1's id.
  const { resolver, calls } = setup();
  assert.deepEqual(await resolver.resolve(card("a@example.com", AUTH_OK, "server2")), { dataUrl: null, unverified: false });
  assert.deepEqual(await resolver.resolve({ ...card("a@example.com"), serverKey: undefined }), { dataUrl: null, unverified: false });
  assert.equal(calls.length, 0);
});

test("each account is checked against its own provider", async () => {
  const { resolver, calls } = setup({ settings: { trustedByServer: { server1: ["mx.provider.example"], server2: ["mx.google.com"] } } });
  const google = "mx.google.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com";
  assert.match((await resolver.resolve(card("a@example.com", google, "server2"))).dataUrl, /^data:image\/png/);
  assert.deepEqual(await resolver.resolve(card("b@other.com", google, "server1")), { dataUrl: null, unverified: true });
  assert.equal(calls.length, 1);
});
