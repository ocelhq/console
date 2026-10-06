#!/usr/bin/env bash
# Publishes every public workspace package whose version is not on npm yet.
# bun pm pack resolves workspace: and catalog: before npm publish sees the manifest.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

field() {
  bun -e "process.stdout.write(String(require('$1/package.json')['$2'] ?? ''))"
}

for manifest in "$root"/packages/*/package.json; do
  dir="$(dirname "$manifest")"
  [ "$(field "$dir" private)" = "true" ] && continue
  name="$(field "$dir" name)"
  version="$(field "$dir" version)"

  if ! npm view "$name" name >/dev/null 2>&1; then
    echo "error: $name is not on npm yet; trusted publishing cannot create a package." >&2
    echo "Publish $name@$version by hand once, then configure its trusted publisher." >&2
    exit 1
  fi
  if [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]; then
    echo "skip $name@$version: already on npm"
    continue
  fi

  cp "$root/LICENSE" "$dir/LICENSE"
  tarball="$(cd "$dir" && bun pm pack --destination "$out" --quiet | tail -n 1)"
  npm publish "$tarball" --provenance --access public
done

"$root/node_modules/.bin/changeset" git-tag
