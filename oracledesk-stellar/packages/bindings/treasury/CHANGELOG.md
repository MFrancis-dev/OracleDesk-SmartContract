# Changelog

## 0.2.0

Withdrawal queue (#277): `request_withdraw` now writes `TicketMeta`; every
proceeds entrypoint (`settle_market`, `redeem`, `claim_pool_remainder`, the
`legacy_*` variants, `redeem_many`, `claim_pool_remainders`, `agent_sell*`,
`recall_from_yield`, `deposit`) drains the queue in the same transaction,
pro rata across a `QUEUE_WINDOW` head window. New entrypoints
`cancel_withdraw`, `transfer_ticket`, `queue_page`, `queue_position` and
`estimated_unlock`; new events `WithdrawCancelled`, `TicketTransferred` and
`QueueDrainSkipped`; new types `TicketMeta`, `QueueEntry`, `QueuePosition`;
new errors `TicketNotCancellable` (75) and `CancelTooEarly` (76).
`claim_withdraw` now drains the queue and returns the total paid.

The `Error` enum also gains the cross-contract `MarketCore*` variants
(2031–2042) of docs/adr/0006-cross-contract-errors.md, so `error Error` is
listed as a changed definition.

Breaking item: error Error: definition changed

## 0.1.0

Initial versioned interface manifest and semantic compatibility baseline.

Includes the merged permissionless-settlement, PnL/drawdown, creation-policy and
yield-venue APIs that were missing from the previous generated bindings. Keeps
published error codes 1–33 stable and assigns previously conflicting additions
to unused codes 44–58.
