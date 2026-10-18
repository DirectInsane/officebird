#!/bin/sh
cd "$(dirname "$0")/../.."
exec /Applications/Thunderbird.app/Contents/MacOS/thunderbird -profile "$PWD/.dev-profile" -no-remote -marionette -remote-allow-system-access
