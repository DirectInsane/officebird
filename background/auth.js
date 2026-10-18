// Authentication-Results (RFC 8601) parsing and the trust decision for icons.
import { domainOf, isAligned } from "./domain.js";

// Share of sampled mails one authserv-id needs before Detect fills it in.
const DOMINANT_SHARE = 0.6;

// Gmail reports only the agent or user identifier (header.i=@example.com),
// which is the signing domain or a subdomain of it.
function dkimDomain(props) {
  return props["header.d"] || domainOf(props["header.i"]);
}

function tokenize(value) {
  const segments = [[]];
  let token = "";
  let depth = 0;
  let quoted = false;
  const endToken = () => {
    if (token) {
      segments.at(-1).push(token);
      token = "";
    }
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === "\\" && i + 1 < value.length) {
        token += value[++i];
      } else if (ch === '"') {
        quoted = false;
      } else {
        token += ch;
      }
    } else if (depth > 0) {
      if (ch === "\\") {
        i++;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === "(") {
      endToken();
      depth = 1;
    } else if (ch === ";") {
      endToken();
      segments.push([]);
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token += ch;
    }
  }
  endToken();
  return segments;
}

// Several headers arrive one per line, topmost first; only the topmost was added
// by the user's own receiving server, the others may come from the sender.
export function parseAuthResults(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const [head = [], ...segments] = tokenize(raw.split(/\r?\n/)[0]);
  const authservId = (head[0] || "").toLowerCase();
  if (!authservId || authservId.includes("=")) {
    return null;
  }
  const results = [];
  for (const [methodToken, ...propTokens] of segments) {
    const eq = methodToken?.indexOf("=") ?? -1;
    if (eq <= 0) {
      continue;
    }
    const props = {};
    for (const token of propTokens) {
      const i = token.indexOf("=");
      if (i > 0) {
        props[token.slice(0, i).toLowerCase()] = token.slice(i + 1);
      }
    }
    results.push({
      method: methodToken.slice(0, eq).toLowerCase(),
      result: methodToken.slice(eq + 1).toLowerCase(),
      props,
    });
  }
  return { authservId, results };
}

export function evaluateAuth(raw, fromDomain, trustedIds) {
  const failed = { authenticated: false, dmarcPass: false };
  const parsed = parseAuthResults(raw);
  if (!parsed || !trustedIds.some(id => id.toLowerCase() === parsed.authservId)) {
    return failed;
  }
  const dmarc = parsed.results.filter(r => r.method === "dmarc");
  const dmarcPass = dmarc.length > 0 && dmarc.every(r => r.result === "pass");
  const dkimAligned = parsed.results.some(
    r => r.method === "dkim" && r.result === "pass" && isAligned(dkimDomain(r.props), fromDomain)
  );
  return { authenticated: dmarcPass || dkimAligned, dmarcPass };
}

// The user's own provider writes the topmost header of every message, so it
// dominates the ranking.
export function rankAuthservIds(rawList) {
  const counts = new Map();
  for (const raw of rawList) {
    const id = parseAuthResults(raw)?.authservId;
    if (id && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id)) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);
}

export function dominantAuthservId(ranked) {
  const total = ranked.reduce((sum, entry) => sum + entry.count, 0);
  return total && ranked[0].count / total >= DOMINANT_SHARE ? ranked[0].id : null;
}
