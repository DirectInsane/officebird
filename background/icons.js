// Decides which icon a message card gets, and fetches/caches it.
import { domainOf, orgDomain } from "./domain.js";
import { isFreemail } from "./freemail.js";
import { evaluateAuth } from "./auth.js";
import { responseToDataUrl } from "./image.js";
import { lookupBimiLogoUrl } from "./bimi.js";
import { fetchOptions } from "./net.js";
import { trustedIdsFor } from "./settings.js";

const MAX_IN_FLIGHT = 4;
const TRANSIENT_BACKOFF_MS = 10 * 60 * 1000;
const INITIALS = Object.freeze({ dataUrl: null, unverified: false });
const UNVERIFIED = Object.freeze({ dataUrl: null, unverified: true });
// The message has no local copy yet, so its headers can't be checked; the
// experiment asks again once the message is stored locally.
const PENDING = Object.freeze({ dataUrl: null, unverified: false, pending: true });

// Fails the lookup without caching the result on disk.
class TransientError extends Error {}

async function checkedFetch(fetchFn, url, options) {
  let response;
  try {
    response = await fetchFn(url, options);
  } catch (e) {
    throw new TransientError(String(e));
  }
  if (response.status >= 500 || response.status === 429) {
    throw new TransientError(`HTTP ${response.status}`);
  }
  return response;
}

function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async function limit(fn) {
    if (active >= max) {
      await new Promise(resolve => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createIconResolver({ cache, fetchFn, lookupContactPhoto, getSettings, now = Date.now }) {
  const limit = createLimiter(MAX_IN_FLIGHT);
  const pending = new Map();
  const backoff = new Map(); // cache key → retry-after timestamp (ms)
  const limitedFetch = (url, opts) => limit(() => checkedFetch(fetchFn, url, opts));

  function cached(key, source, load) {
    if (!pending.has(key)) {
      const promise = (async () => {
        const hit = await cache.get(key);
        if (hit) {
          return hit.dataUrl;
        }
        if ((backoff.get(key) ?? 0) > now()) {
          return null;
        }
        let dataUrl;
        try {
          dataUrl = await load();
        } catch (e) {
          // Offline, timeouts and server errors: retry later, but don't
          // remember "no icon" for days.
          backoff.set(key, now() + TRANSIENT_BACKOFF_MS);
          return null;
        }
        backoff.delete(key);
        await cache.put(key, dataUrl, dataUrl ? source : "none");
        return dataUrl;
      })().finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    return pending.get(key);
  }

  async function bimiIcon(domain, resolver) {
    return cached(`bimi:${domain}`, "bimi", async () => {
      const logoUrl = await lookupBimiLogoUrl(domain, resolver, limitedFetch);
      return logoUrl ? responseToDataUrl(await limitedFetch(logoUrl, fetchOptions())) : null;
    });
  }

  async function ddgIcon(domain) {
    return cached(`ddg:${domain}`, "ddg", async () =>
      responseToDataUrl(await limitedFetch(`https://icons.duckduckgo.com/ip3/${domain}.ico`, fetchOptions()))
    );
  }

  async function resolve(card) {
    const all = getSettings();
    const settings = all.icons;
    const fromDomain = domainOf(card.email);
    if (!settings.enabled || !fromDomain) {
      return INITIALS;
    }
    const photo = await lookupContactPhoto(card.email).catch(() => null);
    if (photo) {
      return { dataUrl: photo, unverified: false };
    }
    const domain = orgDomain(fromDomain);
    if (isFreemail(domain, settings.freemailExtra)) {
      return INITIALS;
    }
    if (card.authResults === null) {
      return PENDING;
    }
    // Only the provider of the account the mail arrived in vouches for it.
    const trusted = trustedIdsFor(all, card.serverKey);
    const auth = evaluateAuth(card.authResults, fromDomain, trusted);
    if (!auth.authenticated) {
      // Without a trusted provider nothing can be verified; a warning on
      // every card would only be noise.
      return trusted.length ? UNVERIFIED : INITIALS;
    }
    if (settings.bimi.enabled && auth.dmarcPass) {
      const logo = await bimiIcon(domain, settings.bimi.resolver);
      if (logo) {
        return { dataUrl: logo, unverified: false };
      }
    }
    return { dataUrl: await ddgIcon(domain), unverified: false };
  }

  return { resolve };
}
