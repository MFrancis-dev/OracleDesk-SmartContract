#!/usr/bin/env bash
# Migrates an existing testnet market-core deployment from the old unilateral
# `set_resolver` / `set_treasury` setters to the authenticated two-step wiring
# handshake (#61).
#
# Background: deployments created before #61 let the deployer EOA be stored as
# both the resolver and the treasury, then replaced them with `set_resolver` /
# `set_treasury`. Those entrypoints are gone; the replacement is
# `propose_resolver` / `propose_treasury` (admin) followed by the resolver or
# treasury contract calling `accept_resolver` / `accept_treasury` on market-core
# through its own `accept_market_core_role` entrypoint.
#
# Running this against a deployment that is already authenticated is a no-op —
# the proposed address equals the stored one and the handshake just re-emits
# the change. It is safe to re-run.
#
# Usage: scripts/migrate-market-core-wiring.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK=testnet
DEPLOYER_KEY=oracledesk-deployer
OUT=deployments/testnet.json

[ -f "$OUT" ] || { echo "error: $OUT not found — nothing to migrate" >&2; exit 1; }

MARKET_CORE=$(jq -r '.contracts.market_core // empty' "$OUT")
RESOLVER=$(jq -r '.contracts.resolver // empty' "$OUT")
TREASURY=$(jq -r '.contracts.treasury // empty' "$OUT")
for pair in "market_core:$MARKET_CORE" "resolver:$RESOLVER" "treasury:$TREASURY"; do
  name=${pair%%:*}; addr=${pair#*:}
  [ -n "$addr" ] || { echo "error: $name missing from $OUT" >&2; exit 1; }
done

log() { echo "==> $*" >&2; }

# Read the current wiring straight from chain, so a stale json record cannot
# make us skip a migration that is still needed.
current_resolver=$(stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- get_config | jq -r '.resolver')
current_treasury=$(stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- get_config | jq -r '.treasury')

if [ "$current_resolver" = "$RESOLVER" ] && [ "$current_treasury" = "$TREASURY" ] \
  && [ "$(jq -r '.wiring_authenticated // false' "$OUT")" = "true" ]; then
  log "market-core already authenticated to the recorded resolver/treasury — nothing to do"
  exit 0
fi

log "proposing resolver $RESOLVER"
stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- propose_resolver --resolver "$RESOLVER"
log "resolver accepts (proves market_core() == market-core)"
stellar contract invoke --id "$RESOLVER" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- accept_market_core_role

log "proposing treasury $TREASURY"
stellar contract invoke --id "$MARKET_CORE" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- propose_treasury --treasury "$TREASURY"
log "treasury accepts (proves market_core() == market-core)"
stellar contract invoke --id "$TREASURY" --source-account "$DEPLOYER_KEY" \
  --network "$NETWORK" -- accept_market_core_role

tmp=$(mktemp)
jq 'del(.needs_treasury_wiring) | .wired = true | .wiring_authenticated = true' "$OUT" >"$tmp" \
  && mv "$tmp" "$OUT"

log "done. market-core is authenticated to resolver=$RESOLVER treasury=$TREASURY"
