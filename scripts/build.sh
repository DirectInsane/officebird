#!/bin/sh
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/officebird.xpi
zip -r -q dist/officebird.xpi manifest.json LICENSE images/icon.svg background experiments options -x '*.DS_Store'
echo "built dist/officebird.xpi"
