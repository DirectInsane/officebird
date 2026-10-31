#!/bin/sh
# Takes the README screenshots in a separate test Thunderbird (.dev-profile-screens, port
# 2837) with the made-up data of screenshot-setup.js, light and dark. Writes screenshots/.
# Env: QOL_LANGPACK, the path of Mozilla's en-US language pack for this Thunderbird version
# (releases/<version>/linux-x86_64/xpi/en-US.xpi), for a build in another language.
set -e
cd "$(dirname "$0")/../.."
export MARIONETTE_PORT=2837
PROFILE="$PWD/.dev-profile-screens"
THUNDERBIRD=/Applications/Thunderbird.app/Contents/MacOS/thunderbird

port_open() { nc -z 127.0.0.1 "$MARIONETTE_PORT" 2>/dev/null; }

start_thunderbird() {
  "$THUNDERBIRD" -profile "$PROFILE" -no-remote -marionette -remote-allow-system-access >/dev/null 2>&1 &
  for i in $(seq 1 60); do port_open && break; sleep 1; done
  sleep 3
}

scripts/build.sh
if [ ! -d "$PROFILE" ]; then
  mkdir -p "$PROFILE"
  grep -v '"marionette.port"' scripts/dev/user.js > "$PROFILE/user.js"
  cat >> "$PROFILE/user.js" <<PREFS
user_pref("marionette.port", $MARIONETTE_PORT);
user_pref("intl.locale.requested", "en-US");
user_pref("ui.systemUsesDarkTheme", 0);
user_pref("mail.rights.override", true);
user_pref("mail.addressDisplayFormat", 2);
user_pref("mail.fixed_width_messages", false);
PREFS
  # The first start writes the language into the profile; the second runs fully in English.
  start_thunderbird
  if [ -n "$QOL_LANGPACK" ]; then
    node scripts/dev/marionette.mjs --install-xpi "$QOL_LANGPACK" >/dev/null
  fi
  node scripts/dev/marionette.mjs --quit >/dev/null 2>&1 || true
  for i in $(seq 1 30); do port_open || break; sleep 1; done
  sleep 2
fi
port_open || start_thunderbird
node scripts/dev/marionette.mjs --install-xpi "$PWD/dist/officebird.xpi" >/dev/null
sleep 2
node scripts/dev/marionette.mjs scripts/dev/screenshot-setup.js

mkdir -p screenshots
printf 'globalThis.QOL_SELECTOR = "#today-pane-panel";\n' | cat - scripts/dev/screenshot-rect.js > "$PROFILE/rect.js"

# Thunderbird applies dark mode fully only at startup, so each pass starts it anew. The
# dark pass also uses Thunderbird's Dark theme: without it the title bar follows macOS.
# $1: 0 for light, 1 for dark; $2: file name suffix.
take_shots() {
  node scripts/dev/marionette.mjs --quit >/dev/null 2>&1 || true
  for i in $(seq 1 30); do port_open || break; sleep 1; done
  sleep 2
  sed -i '' "s/\"ui.systemUsesDarkTheme\", [01]/\"ui.systemUsesDarkTheme\", $1/" "$PROFILE/user.js"
  start_thunderbird
  if [ "$1" = 1 ]; then theme=thunderbird-compact-dark@mozilla.org; else theme=default-theme@mozilla.org; fi
  cat > "$PROFILE/theme.js" <<THEME
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
await (await AddonManager.getAddonByID("$theme")).enable();
await new Promise(resolve => Services.wm.getMostRecentWindow("mail:3pane").setTimeout(resolve, 1500));
return 1;
THEME
  node scripts/dev/marionette.mjs "$PROFILE/theme.js" >/dev/null
  node scripts/dev/marionette.mjs scripts/dev/screenshot-setup.js >/dev/null
  node scripts/dev/marionette.mjs --screenshot "screenshots/mail$2.png" >/dev/null
  set -- $(node scripts/dev/marionette.mjs "$PROFILE/rect.js" | tr -d '"') "$2"
  sips -c "$4" "$3" --cropOffset "$2" "$1" "screenshots/mail$5.png" --out "screenshots/today-pane$5.png" >/dev/null
  node scripts/dev/marionette.mjs scripts/dev/screenshot-compose.js >/dev/null
  node scripts/dev/marionette.mjs --screenshot "screenshots/compose$5.png" msgcompose >/dev/null
}
take_shots 0 ""
take_shots 1 "-dark"
sed -i '' 's/"ui.systemUsesDarkTheme", 1/"ui.systemUsesDarkTheme", 0/' "$PROFILE/user.js"

ls -l screenshots
