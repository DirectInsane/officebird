// BIMI: look up a brand's logo URL via DNS-over-HTTPS.
import { fetchOptions } from "./net.js";

export const RESOLVERS = {
  quad9: "https://dns.quad9.net:5053/dns-query",
  cloudflare: "https://cloudflare-dns.com/dns-query",
};

const TXT = 16;

// Logos are fetched from the brand's server, so a record must not point the
// fetch at the user's own machine or network.
function isPublicHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  // URL() already turns 0x7f.1 or 2130706433 into dotted IPv4.
  const ip = host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host);
  const local = host === "localhost" || host.endsWith(".localhost");
  return !ip && !local && host.includes(".");
}

export function parseBimiRecord(txt) {
  if (typeof txt !== "string" || !/^\s*v=BIMI1\s*(;|$)/i.test(txt)) {
    return null;
  }
  for (const part of txt.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key.trim().toLowerCase() === "l") {
      const url = rest.join("=").trim();
      return /^https:\/\/[^\s]+$/i.test(url) && isPublicHost(url) ? url : null;
    }
  }
  return null;
}

const NXDOMAIN = 3;

// Resolves null only when no BIMI record exists (cacheable) and rejects on
// transient failures (network, HTTP, SERVFAIL) so the caller retries later.
export async function lookupBimiLogoUrl(orgDomain, resolver, fetchFn) {
  const endpoint = RESOLVERS[resolver] ?? RESOLVERS.cloudflare;
  const url = `${endpoint}?name=${encodeURIComponent(`default._bimi.${orgDomain}`)}&type=TXT`;
  const response = await fetchFn(url, fetchOptions({ headers: { accept: "application/dns-json" } }));
  if (!response.ok) {
    throw new Error(`[qol] DoH HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json.Status === NXDOMAIN) {
    return null;
  }
  if (json.Status !== 0) {
    throw new Error(`[qol] DoH status ${json.Status}`);
  }
  for (const answer of json.Answer ?? []) {
    if (answer.type !== TXT || typeof answer.data !== "string") {
      continue;
    }
    // TXT data arrives as one or more quoted strings: "a" "b" → ab
    const joined = answer.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
    const logo = parseBimiRecord(joined);
    if (logo) {
      return logo;
    }
  }
  return null;
}
