// Pure functions: imported by the background page and by Node tests.

function firstLetter(word) {
  const match = word.match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : "";
}

export function initialsFor(displayName, email) {
  const name = (displayName || "").replace(/["']/g, " ").trim();
  if (name) {
    const words = name.split(/[\s,]+/).filter(word => firstLetter(word));
    const letters = words.slice(0, 2).map(firstLetter).join("");
    if (letters) {
      return letters;
    }
  }
  const local = (email || "").split("@")[0];
  return firstLetter(local) || "?";
}

export function colorFor(email) {
  let hash = 0;
  for (const ch of email || "") {
    hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  }
  return `hsl(${hash % 360}, 45%, 45%)`;
}
