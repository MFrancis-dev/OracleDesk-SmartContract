#!/usr/bin/env bash
# Negative test for the #58 hash pin: a vendored wasm whose bytes no longer
# match its committed `.sha256` must be a **compile** error, not a silent
# build against an old interface.
#
# Appends one byte to `contracts/resolver/market_core.wasm` in place, asserts
# that building resolver fails with the pinned-hash message, then restores the
# original bytes (also on interrupt).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

target=contracts/resolver/market_core.wasm
backup="$(mktemp)"
log="$(mktemp)"
cp "$target" "$backup"
trap 'cp "$backup" "$target"; rm -f "$backup" "$log"' EXIT

printf '\0' >>"$target"

if cargo build -p resolver 2>"$log"; then
  echo "expected the build to fail on a hash mismatch, but it succeeded" >&2
  exit 1
fi

if ! grep -q "does not match its pinned hash" "$log"; then
  echo "build failed, but not with the pinned-hash error:" >&2
  cat "$log" >&2
  exit 1
fi

echo "ok: a stale vendored wasm is a compile error"
