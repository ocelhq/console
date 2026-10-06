#!/usr/bin/env bash
# Usage: scripts/check-contract.sh [ocel-ref, default main]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
synced="$(mktemp -d)"
trap 'rm -rf "$synced"' EXIT

"$root/scripts/sync-contract.sh" "${1:-main}" "$synced" > /dev/null
if ! diff -r --exclude OCEL_REF "$root/packages/api/test/contract" "$synced"; then
  echo "packages/api/test/contract differs from ocel ${1:-main}; run scripts/sync-contract.sh ${1:-main}" >&2
  exit 1
fi
