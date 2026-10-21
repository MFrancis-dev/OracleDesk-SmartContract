#!/usr/bin/env bash
# The auth matrix must prove authorization with *targeted* mocks. A blanket
# `mock_all_auths()` would make every positive test pass for the wrong reason,
# so this guard fails CI if one appears anywhere in the integration-test crate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

matches=$(grep -RIn --include='*.rs' -E '\.?mock_all_auths[[:space:]]*\(' contracts/integration-tests || true)
if [ -n "$matches" ]; then
  echo "error: contracts/integration-tests must not use mock_all_auths:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "ok: auth matrix uses targeted mocks only (no mock_all_auths)"
