#!/bin/sh
# Installs a fresh build into a Thunderbird started with Marionette; restarts it only
# when an experiment schema changed (Thunderbird keeps the old schema until restart).
# Env: MARIONETTE_PORT (default 2828), QOL_TB_PROFILE (default "default-release"),
# QOL_TB_PROFILE_PATH (test instance folder; required to restart on any other port).
set -e
cd "$(dirname "$0")/../.."
export MARIONETTE_PORT="${MARIONETTE_PORT:-2828}"
PROFILE="${QOL_TB_PROFILE:-default-release}"
STAMP=".dev-schema-$MARIONETTE_PORT"

scripts/build.sh
node scripts/dev/marionette.mjs --install-xpi "$PWD/dist/officebird.xpi"

SCHEMA_HASH=$(cat experiments/*/schema.json | shasum | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null)" = "$SCHEMA_HASH" ]; then
  echo "schema unchanged: add-on reloaded, no restart needed"
  exit 0
fi

if [ "$MARIONETTE_PORT" != 2828 ] && [ -z "$QOL_TB_PROFILE_PATH" ]; then
  echo "schema changed: restart this Thunderbird yourself (or set QOL_TB_PROFILE_PATH)"
  exit 2
fi
echo "schema changed: restarting Thunderbird"
node scripts/dev/marionette.mjs --quit >/dev/null 2>&1 || true
for i in $(seq 1 30); do nc -z 127.0.0.1 "$MARIONETTE_PORT" 2>/dev/null || break; sleep 1; done
sleep 2
if [ -n "$QOL_TB_PROFILE_PATH" ]; then
  nohup /Applications/Thunderbird.app/Contents/MacOS/thunderbird -profile "$QOL_TB_PROFILE_PATH" -no-remote \
    -marionette -remote-allow-system-access >/dev/null 2>&1 &
else
  open -n -a Thunderbird --args -P "$PROFILE" -marionette -remote-allow-system-access
fi
for i in $(seq 1 60); do nc -z 127.0.0.1 "$MARIONETTE_PORT" 2>/dev/null && break; sleep 1; done
echo "$SCHEMA_HASH" > "$STAMP"
echo "Thunderbird restarted with the new version"
