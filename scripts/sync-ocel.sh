#!/usr/bin/env bash
# Usage: scripts/sync-ocel.sh   (syncs from the ocel commit buf.gen.yaml pins)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ref="$(sed -n 's/^ *ref: *//p' "$root/buf.gen.yaml" | head -n 1)"
if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  echo "buf.gen.yaml pins no full ocel commit sha" >&2
  exit 1
fi
repository="${OCEL_REPOSITORY:-https://github.com/ocelhq/ocel.git}"
contract=cli/internal/console/testdata/contract
pricing=pkg/pricing/ingest

checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT

git -C "$checkout" init -q
git -C "$checkout" fetch -q --depth 1 "$repository" "$ref"
git -C "$checkout" archive FETCH_HEAD "$contract" "$pricing/manifest.json" "$pricing/static" |
  tar -x -C "$checkout"

sync() {
  local destination="$root/$1"
  shift
  rm -rf "$destination"
  mkdir -p "$destination"
  cp -R "$@" "$destination/"
  echo "$ref" > "$destination/OCEL_REF"
}

sync packages/api/test/contract "$checkout/$contract"/*.json
sync packages/pricing/catalog "$checkout/$pricing/manifest.json" "$checkout/$pricing/static"
