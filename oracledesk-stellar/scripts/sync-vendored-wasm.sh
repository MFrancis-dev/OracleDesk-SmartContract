#!/usr/bin/env bash
# Copies freshly built cross-contract wasm into the dependent crates' vendored
# copies and refreshes the committed sha256 pins (issue #58).
#
# `contractimport!` reads `market_core.wasm` / `reasoning_registry.wasm` from
# the *dependent* crate's directory at its compile time, so a stale copy
# silently compiles against an old interface. Since #58 the copy is also
# verified against `<name>.wasm.sha256` by each crate's `build.rs`, which turns
# a mismatch into a compile error. This script is the one supported way to
# refresh both the wasm and its pin, so they can never be committed apart.
#
# Run it after any change to market-core or reasoning-registry, *before*
# building resolver/treasury (`make build` does this automatically).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WASM_DIR=${WASM_DIR:-target/wasm32v1-none/release}

# `sha256sum` is GNU coreutils (Linux/CI); `shasum -a 256` is the macOS
# default. Accept either so `make build` works on a contributor's laptop too.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "error: neither sha256sum nor shasum is installed" >&2
  exit 1
fi

for f in market_core reasoning_registry; do
  if [ ! -f "$WASM_DIR/$f.wasm" ]; then
    echo "error: $WASM_DIR/$f.wasm is missing — run 'stellar contract build' first" >&2
    exit 1
  fi
done

sync() { # <built wasm> <vendored wasm>
  local built=$1 vendored=$2
  cp "$built" "$vendored"
  sha256_of "$built" > "$vendored.sha256"
  echo "synced $vendored -> $(cat "$vendored.sha256")"
}

sync "$WASM_DIR/market_core.wasm" contracts/resolver/market_core.wasm
sync "$WASM_DIR/market_core.wasm" contracts/treasury/market_core.wasm
sync "$WASM_DIR/reasoning_registry.wasm" contracts/resolver/reasoning_registry.wasm
