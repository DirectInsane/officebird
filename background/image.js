// Turns a fetched icon response into a validated data: URL.

export const MAX_ICON_BYTES = 102400;

// DuckDuckGo's generic icon for unknown domains (served with HTTP 404).
export const DDG_PLACEHOLDER_SHA256 = "e5db88ea2322863ca17817b99d60006c625a31cff0dad49cf05d3c6d16a75c17";

const ALLOWED_TYPES = new Set([
  "image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml",
  "image/gif", "image/jpeg", "image/webp",
]);

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export async function responseToDataUrl(response, { placeholderHash = DDG_PLACEHOLDER_SHA256 } = {}) {
  if (response.status !== 200) {
    return null;
  }
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return null;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_ICON_BYTES) {
    return null;
  }
  if ((await sha256Hex(buffer)) === placeholderHash) {
    return null;
  }
  return `data:${type};base64,${toBase64(new Uint8Array(buffer))}`;
}
