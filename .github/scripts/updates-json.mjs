// Thunderbird's update manifest for a release: node updates-json.mjs <tag> <xpi>.
// The release workflow uploads it as updates.json, which manifest.json's update_url
// finds through GitHub's releases/latest link.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";

export function updatesJson(manifest, repository, tag, fileName, data) {
  const { id, strict_min_version } = manifest.browser_specific_settings.gecko;
  return {
    addons: {
      [id]: {
        updates: [
          {
            version: manifest.version,
            update_link: `https://github.com/${repository}/releases/download/${tag}/${fileName}`,
            update_hash: "sha256:" + createHash("sha256").update(data).digest("hex"),
            applications: { gecko: { strict_min_version } },
          },
        ],
      },
    },
  };
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, xpi] = argv.slice(2);
  const manifest = JSON.parse(await readFile(new URL("../../manifest.json", import.meta.url), "utf8"));
  const data = await readFile(xpi);
  console.log(JSON.stringify(updatesJson(manifest, env.GITHUB_REPOSITORY, tag, basename(xpi), data), null, 2));
}
