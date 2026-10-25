#!/bin/sh
# Runs search-tests.js against a separate test Thunderbird (.dev-profile-search, port
# 2833), restarting it when an experiment schema changed (Thunderbird keeps the old
# schema until restart). Prints the suite's JSON; exits 1 when a test failed.
set -e
cd "$(dirname "$0")/../.."
export MARIONETTE_PORT=2833
PROFILE="$PWD/.dev-profile-search"
STAMP=".dev-schema-$MARIONETTE_PORT"
THUNDERBIRD=/Applications/Thunderbird.app/Contents/MacOS/thunderbird

port_open() { nc -z 127.0.0.1 "$MARIONETTE_PORT" 2>/dev/null; }

start_thunderbird() {
  "$THUNDERBIRD" -profile "$PROFILE" -no-remote -marionette -remote-allow-system-access >/dev/null 2>&1 &
  for i in $(seq 1 60); do port_open && return 0; sleep 1; done
  echo "Thunderbird did not open port $MARIONETTE_PORT" >&2
  exit 1
}

stop_thunderbird() {
  node scripts/dev/marionette.mjs --quit >/dev/null 2>&1 || true
  for i in $(seq 1 30); do port_open || break; sleep 1; done
  sleep 2
}

if [ ! -d "$PROFILE" ]; then
  mkdir -p "$PROFILE"
  grep -v '"marionette.port"' scripts/dev/user.js > "$PROFILE/user.js"
  echo "user_pref(\"marionette.port\", $MARIONETTE_PORT);" >> "$PROFILE/user.js"
fi

scripts/build.sh
port_open || start_thunderbird
node scripts/dev/marionette.mjs scripts/dev/search-setup.js >/dev/null
node scripts/dev/marionette.mjs --install-xpi "$PWD/dist/officebird.xpi" >/dev/null

SCHEMA_HASH=$(cat experiments/*/schema.json | shasum | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null)" != "$SCHEMA_HASH" ]; then
  echo "schema changed: restarting the test Thunderbird"
  stop_thunderbird
  start_thunderbird
  echo "$SCHEMA_HASH" > "$STAMP"
fi

OUTPUT=$(MARIONETTE_SCRIPT_TIMEOUT=600000 node scripts/dev/marionette.mjs scripts/dev/search-tests.js)
# printf, not echo: sh's echo expands backslashes in error texts and breaks the JSON.
printf '%s\n' "$OUTPUT"
printf '%s\n' "$OUTPUT" | node -e '
  const result = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.exit(result && Array.isArray(result.failed) && result.failed.length === 0 ? 0 : 1);
'
