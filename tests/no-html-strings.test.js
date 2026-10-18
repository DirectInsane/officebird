// Mail content may reach the UI only as text or <img> data: URLs, never as markup or code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const ROOTS = ["background", "experiments", "options"];
const FORBIDDEN = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|parseFromString|document\.write|srcdoc)\b|\beval\s*\(|\bnew Function\s*\(/;

async function sources(dir) {
  const entries = await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await sources(path)));
    } else if (/\.(m?js|html)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test("no add-on code turns strings into markup or code", async () => {
  const files = (await Promise.all(ROOTS.map(sources))).flat();
  assert.ok(files.length > 10, "found the sources");
  for (const file of files) {
    const lines = (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
    lines.forEach((line, i) => assert.doesNotMatch(line, FORBIDDEN, `${file}:${i + 1}`));
  }
});
