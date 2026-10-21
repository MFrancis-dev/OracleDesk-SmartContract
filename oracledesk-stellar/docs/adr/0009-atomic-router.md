# ADR 0009: Atomic router for multi-step flows

## Status

Accepted.

## Context

Several flows are naturally multi-step and are only correct if every step
lands together:

- A market must be created **and** the resolution rule revealed. ADR 0001
  splits this into a commit (at creation) and a reveal, but a creator that
  creates a market and never reveals leaves it unresolvable, and the
  reveal's hash must match the commitment exactly.
- A trade should be accompanied by a reasoning trace. The registry exists for
  exactly this, but a client that calls `market-core.buy` and then drops the
  `publish_trace` call produces an unaccountable trade.

Doing these from a client means several transactions: a partial failure
(e.g. the reveal hash mismatch, or the process dying between the buy and the
trace) leaves an inconsistent state that nobody re-checks. Having each client
orchestrate the calls also means each one decides *which* resolver and
registry to trust.

## Decision

Add a stateless `router` contract (`contracts/router`) whose only stored value
is an address book.

### Immutable address book

`__constructor(market_core, resolver, reasoning_registry: Option)` stores a
`RouterConfig` once. There is no privileged role — the values never change —
so the router cannot be repointed at a hostile resolver mid-flight and callers
need no per-call address arguments. `config()` exposes it.

### Atomic entrypoints

- `create_and_reveal_signers(creator, ..., spec_v2)` and
  `create_and_reveal_price(...)` — create the market through market-core and
  reveal its spec through the resolver in one transaction. The commitment is
  computed from `spec_v2` **locally** (mirroring the resolver's own hashing)
  and passed to `market-core.create_market`, so the commitment and the reveal
  are consistent by construction; a mismatch is impossible rather than merely
  checked. Emits `MarketCreatedAndRevealed`.
- `reveal_spec(market_id, spec_v2)` — the deferred reveal for a market created
  by the commit-now/reveal-later path, validating the rule before
  `resolver.register_spec_v2`.
- `buy_and_publish_trace(trader, market_id, outcome, collateral_in,
  min_shares_out, action, trace_hash, ipfs_cid)` — buys through market-core
  and publishes the trace through the registry in one transaction, so the
  trace cannot be skipped after the trade. Emits `BoughtAndPublishedTrace`.
  Rejects empty `action`/`ipfs_cid` with `InvalidTrace`.

### Authorization

Each entrypoint calls `creator.require_auth()` / `trader.require_auth()` at the
**root** of the call tree. market-core and the registry call `require_auth`
for the same address deeper down; a non-root `require_auth` fails unless the
address is already anchored, so the router anchors it first. A caller still
authorizes exactly one account — the router adds no authority of its own.

`reasoning_registry` is optional: if it is `None`, `buy_and_publish_trace`
returns `NotInitialized`.

## Consequences

- The create+reveal and buy+trace flows are all-or-nothing; there is no window
  in which a market exists without its rule or a trade exists without its
  trace.
- Clients point at one router address and never choose a resolver or registry
  themselves, so they cannot be tricked into a different one.
- The router holds no funds, no roles and no admin, so it is not a target for
  a governance action and needs no timelock.
