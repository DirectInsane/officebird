// Domains where a logo says nothing about the individual sender.
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "gmx.de", "gmx.net", "web.de", "t-online.de",
  "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "posteo.de", "mailbox.org", "freenet.de",
]);

// `extra` must already be normalized.
export function isFreemail(orgDomain, extra) {
  return FREEMAIL_DOMAINS.has(orgDomain) || extra.includes(orgDomain);
}
