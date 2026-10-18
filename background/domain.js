// Email address → domain → organizational domain, and DKIM alignment.

// Public suffixes with two labels that are common in mail. Not a full PSL;
// unknown suffixes fall back to "last two labels".
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "ne.jp", "com.br", "com.tr",
  "co.at", "or.at", "co.za", "com.cn", "com.mx", "co.in", "co.il",
]);

const GENERIC_SECOND_LEVEL = new Set(["com", "co", "net", "org", "gov", "ac", "edu", "or", "ne", "go", "gob", "nic", "mil"]);

// Returns the lowercased, punycoded domain, or null if unusable.
export function domainOf(email) {
  if (typeof email !== "string") {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const raw = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!raw || /[\s/\\?#:@[\]]/.test(raw)) {
    return null;
  }
  let host;
  try {
    host = new URL("http://" + raw).hostname;
  } catch {
    return null;
  }
  return host.includes(".") ? host : null;
}

export function orgDomain(domain) {
  const labels = domain.split(".");
  if (labels.length <= 2) {
    return domain;
  }
  const lastTwo = labels.slice(-2).join(".");
  const [second, tld] = labels.slice(-2);
  const ccSecondLevel = tld.length === 2 && GENERIC_SECOND_LEVEL.has(second);
  const keep = TWO_PART_SUFFIXES.has(lastTwo) || ccSecondLevel ? 3 : 2;
  return labels.slice(-keep).join(".");
}

// Equal or parent/child only: siblings under a shared suffix
// (evil.com.sg vs bank.com.sg) must never align.
export function isAligned(dkimDomain, fromDomain) {
  if (!dkimDomain || !fromDomain) {
    return false;
  }
  const d = dkimDomain.toLowerCase().replace(/\.$/, "");
  const f = fromDomain.toLowerCase().replace(/\.$/, "");
  if (!d.includes(".") || !f.includes(".")) {
    return false;
  }
  return d === f || f.endsWith("." + d) || d.endsWith("." + f);
}
