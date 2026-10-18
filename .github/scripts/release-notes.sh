#!/bin/sh
# Release notes for a version tag, from the commit messages since the previous
# release (pre-release tags such as v0.2.0-rc.1 don't count as one).
set -e
tag="$1"

prev=""
for t in $(git tag --list 'v*' --sort=-v:refname); do
  case "$t" in "$tag" | *-*) continue ;; esac
  if git merge-base --is-ancestor "$t" "$tag"; then
    prev="$t"
    break
  fi
done

if [ -z "$prev" ]; then
  echo "First public release."
  sed -n '/^## Features/,/^## Install/p' README.md | sed '1d;$d'
  exit 0
fi

# Commit subjects of one type ("feat", "fix") or of every type not listed.
list() {
  git log --no-merges --format='%s (%h)' "$prev..$tag" \
    | grep -E "$1" \
    | sed -E 's/^[a-z]+(\([^)]*\))?!?: //' \
    | awk '{ print "- " toupper(substr($0, 1, 1)) substr($0, 2) }'
}
section() {
  items=$(list "$2")
  if [ -n "$items" ]; then
    printf '### %s\n\n%s\n\n' "$1" "$items"
  fi
}

notes=$(
  section "New features" '^feat(\(|!|:)'
  section "Fixes" '^fix(\(|!|:)'
  section "Other changes" '^(docs|perf)(\(|!|:)|^[^:]*$'
)
if [ -n "$notes" ]; then
  printf '%s\n' "$notes"
else
  echo "Maintenance release."
fi
if [ -n "$GITHUB_REPOSITORY" ]; then
  printf '\n**Full changelog:** https://github.com/%s/compare/%s...%s\n' "$GITHUB_REPOSITORY" "$prev" "$tag"
fi
