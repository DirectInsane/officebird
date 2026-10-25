import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { updatesJson } from "../.github/scripts/updates-json.mjs";

const SCRIPT = new URL("../.github/scripts/updates-json.mjs", import.meta.url).pathname;

test("lists the release's xpi with its hash and minimum Thunderbird version", () => {
  const manifest = {
    version: "1.2.3",
    browser_specific_settings: { gecko: { id: "addon@example.org", strict_min_version: "153.0" } },
  };
  const data = Buffer.from("xpi bytes");
  assert.deepEqual(updatesJson(manifest, "owner/repo", "v1.2.3", "addon-1.2.3.xpi", data), {
    addons: {
      "addon@example.org": {
        updates: [
          {
            version: "1.2.3",
            update_link: "https://github.com/owner/repo/releases/download/v1.2.3/addon-1.2.3.xpi",
            update_hash: "sha256:" + createHash("sha256").update(data).digest("hex"),
            applications: { gecko: { strict_min_version: "153.0" } },
          },
        ],
      },
    },
  });
});

test("the command line reads the manifest and the xpi and prints the json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "updates-json-"));
  const xpi = join(dir, "officebird-9.9.9.xpi");
  await writeFile(xpi, "test");
  const { stdout } = await promisify(execFile)("node", [SCRIPT, "v9.9.9", xpi], {
    env: { ...process.env, GITHUB_REPOSITORY: "owner/repo" },
  });
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const [update] = JSON.parse(stdout).addons[manifest.browser_specific_settings.gecko.id].updates;
  assert.equal(update.version, manifest.version);
  assert.equal(update.update_link, "https://github.com/owner/repo/releases/download/v9.9.9/officebird-9.9.9.xpi");
  assert.equal(update.update_hash, "sha256:" + createHash("sha256").update("test").digest("hex"));
});
