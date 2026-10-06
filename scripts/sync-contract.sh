#!/usr/bin/env bash
# Usage: scripts/sync-contract.sh <ocel-ref> [destination]
set -euo pipefail

ref="${1:?usage: scripts/sync-contract.sh <ocel-ref> [destination]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="${2:-$root/packages/api/test/contract}"
repository="${OCEL_REPOSITORY:-https://github.com/ocelhq/ocel.git}"
directories=(cli/internal/console/testdata/contract pkg/connectorserver/testdata/contract)

checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT

git -C "$checkout" init -q
git -C "$checkout" fetch -q --depth 1 "$repository" "$ref"
sha="$(git -C "$checkout" rev-parse FETCH_HEAD)"
git -C "$checkout" archive FETCH_HEAD "${directories[@]}" | tar -x -C "$checkout"

rm -rf "$destination"
mkdir -p "$destination"
for directory in "${directories[@]}"; do
  for fixture in "$checkout/$directory"/*.json; do
    name="$(basename "$fixture")"
    if [[ -e "$destination/$name" ]]; then
      echo "fixture $name appears in more than one ocel directory" >&2
      exit 1
    fi
    cp "$fixture" "$destination/$name"
  done
done
echo "$sha" > "$destination/OCEL_REF"
echo "synced $(find "$destination" -name '*.json' | wc -l | tr -d ' ') fixtures from ocel $sha"
