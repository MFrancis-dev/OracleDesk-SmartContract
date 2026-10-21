# ADR 0005: Share-based treasury vault with a conservative NAV

## Status

Accepted.

## Context

`Treasury::deposit(from, amount)` used to accept collateral from anyone and
record nothing: no shares, no receipt, no way back out. Only the admin could
move funds out, through `withdraw(to, amount)`. A deposit from anyone other
than the operator was a donation to the admin key, so outside funders could
not back an agent and share in its results.

Turning the treasury into a vault needs a net asset value (NAV) to price
shares. The treasury holds positions across many markets, and the obvious
valuation, the FPMM spot price, can be moved by anyone who trades. If NAV
followed spot, a depositor could push prices up, withdraw at the inflated
NAV, and leave the loss with everyone else. Vaults also have a well-known
first-depositor attack: deposit 1 unit, donate a large amount straight to the
contract, and round the next depositor's shares down to almost nothing.

## Decision

### Valuation: settled-plus-floor

```
nav = idle
    + Σ over the open-market index of
        open market:  min(pos.yes, pos.no)                      complete sets
                    + min(reserve_yes, reserve_no) if LP role    unclaimed LP
        final market: settle_value(position) + settle_value(LP reserves)
    - queue_reserved
```

- `idle` is the treasury's collateral balance.
- Complete sets redeem 1:1 whatever the outcome, so `min(yes, no)` is value
  the treasury gets back for certain.
- For an LP role that has not been claimed, `min(reserve_yes, reserve_no)` is
  the least the pool remainder can pay out.
- A final market counts exactly what market-core's `settle_value` pays
  (`Yes → yes`, `No → no`, `Void → (yes + no) / 2`).
- `queue_reserved` is collateral already owed to burned shares (see
  "Withdrawals"). Subtracting it stops that collateral being counted twice.

The directional part of a position (`|yes - no|`) is valued at **zero**. Spot
and TWAP valuations were rejected: spot can be manipulated within a single
transaction, and no TWAP exists yet.

**Trade-off, worked example.** The treasury holds 1,000 USDC idle and 150 YES
/ 40 NO shares in an open market where YES trades at 70%. Mark-to-market
would value the position at about 150 × 0.7 + 40 × 0.3 = 117. The floor is
`min(150, 40) = 40`, so NAV is 1,040, not 1,117. While the position is open,
a new depositor's shares are slightly cheap and a withdrawing shareholder's
are slightly expensive. Once the market resolves YES, the position is worth
exactly 150, NAV rises to 1,150, and every shareholder gains pro rata. The
bias always favours the shareholders who stay in the vault over those
entering or leaving. Under-valuation is the price of a NAV that third-party
trades cannot push up.

### Open-market index

NAV needs the list of markets where the treasury holds capital, and nothing
on-chain gave that list. The treasury keeps an index:
`OpenMarketAt(0..count) -> { core, market_id }` plus a reverse
`OpenMarketSlot(core, id)` for swap-and-pop removal.

- A market joins the index on its first buy or creation.
- It leaves once the treasury holds nothing in it: no shares and no unclaimed
  LP role. This is checked after `redeem`, `claim_pool_remainder` and their
  `legacy_*` variants. `migrate_market` also removes it.
- Each entry records its market-core, so positions left in a market-core the
  treasury has since switched away from (see "Timelocked configuration" in
  `docs/architecture.md`) keep counting.

The index is capped at `MAX_OPEN_MARKETS = 12`. A buy or creation in a 13th
market fails with `TooManyOpenMarkets`. Each entry costs two cross-contract
reads, and each read instantiates market-core at about 2.5 MB of memory.
Measured with the test host's per-invocation limit checks:

| Open markets | Call | Memory | Limit |
| ---: | --- | ---: | ---: |
| 32 | `nav()` alone | ~81 MB | 40 MiB |
| 16 | `deposit` | ~40.4 MB | 40 MiB |
| 12 | `deposit` / `request_withdraw` | ~30.3 MB, ~15M instructions | 40 MiB |

The 12-market case is pinned by `nav_budget_within_limits_at_max_open_markets`.

### Shares

Shares are internal balances (`Shares(owner)`, `TotalShares`), not a SEP-41
token. A transferable share token can wrap them later. Keeping them internal
avoids a second contract, a cross-contract call per transfer, and the
question of what a share transfer means for the withdrawal queue while the
economics are still settling.

```
shares_for_deposit(amount) = amount × (supply + 1_000) / (nav + 1)     floor
assets_for_shares(shares)  = shares × (nav + 1) / (supply + 1_000)     floor
```

Both directions round down, in favour of the vault. A deposit followed
immediately by a withdrawal never returns more than was put in. This is
checked by a randomized property test (1,000 cases) and end to end.

**Inflation protection.** The virtual offset (1,000 virtual shares, 1
virtual stroop; the ERC-4626 mitigation) is what defeats the donation
attack. The attacker's donation is shared with the virtual shares, so
inflating the price enough to round a victim's deposit to zero costs the
attacker about 1,000 times what it takes from the victim. Two further
measures support it:

- The first mint withholds 1,000 dead shares that no one owns.
- Deposits must be at least `MIN_DEPOSIT = 10 USDC`.

`donation_attack_does_not_steal_from_second_depositor` shows a victim losing
at most rounding dust after a 1,000 USDC donation.

NAV is computed before the deposit's own transfer, so a deposit never prices
itself.

### Withdrawals

`request_withdraw(owner, shares)`:

1. Computes `assets` at the current NAV and burns the shares immediately,
   which locks in the price.
2. Pays `min(assets, idle - queue_reserved)` now.
3. Records any remainder as a FIFO `WithdrawTicket { owner, remaining,
   created_at }` and adds it to `queue_reserved`.

Agents can never spend reserved collateral. `agent_buy` and
`agent_create_market` fail with `CapitalReserved` unless
`idle - amount >= queue_reserved`.

`claim_withdraw(ticket_id)` pays the head ticket as far as idle collateral
allows. Anyone can call it, but the money always goes to the ticket's owner.
Tickets wait while capital stays deployed, which is bounded by the close
times of the open markets. UIs can read `queue_reserved()`,
`queue_bounds()` and `withdraw_ticket(id)`.

### Custody migration

- The constructor mints any balance the treasury already holds to `admin` as
  shares.
- A stored pre-vault config is migrated lazily and does the same with the
  balance it finds.
- Admin `withdraw` is removed. The admin is an ordinary shareholder.
- `emergency_withdraw(owner, shares)` works only while paused. It pays the
  owner their pro-rata part of free idle collateral without reading
  market-core, for the case where market-core is what broke. The owner
  forfeits their part of open positions, which stays with the remaining
  shareholders.

The treasury has no upgrade path, so existing deployments move by
redeploying:

1. Deploy the new treasury.
2. Admin `withdraw` from the old (pre-vault) treasury.
3. `deposit` into the new treasury.
4. Call `market_core.propose_treasury`, then the new treasury's
   `accept_market_core_role` (the `set_treasury` API this ADR predates was
   replaced by the authenticated handshake in ADR 0006).

Positions moved with `migrate_market` are not in the successor's index and
count as zero in its NAV until they are redeemed.

## Consequences

- Outside funders can back an agent. Their claim is enforced on-chain, and
  no trade against a pool can raise the price of their exit.
- Remaining risks, documented rather than solved:
  - **LP floor moved by rebalancing.** `min(reserve_yes, reserve_no)` rises
    when a trade pushes a skewed pool back toward 50/50. An attacker could
    rebalance, withdraw, then trade back. The gain is bounded by the LP
    floor's movement times the attacker's share of the vault, and it costs
    two trading fees plus slippage. It is not free, but it is not zero.
  - **Fee sweeps.** `collect_market_fees` (admin) raises NAV for every
    shareholder at the moment fees arrive. A depositor who knows a sweep is
    imminent gets a slightly better entry. Sweep often.
  - **Admin custody.** `set_successor` + `migrate_market` can move positions
    out of the vault without compensation (SECURITY.md).
  - **Unindexed positions** (pre-migration, or received from a predecessor)
    are valued at zero until redeemed.
- Agent activity is capped at 12 markets with open capital at once.
