# ADR 0006: Idle Treasury Capital Deployment via Blend Lending with Just-in-Time Withdrawal

## Status

Accepted (Testnet-only).

## Context

The treasury holds pooled USDC capital for market makers and traders. In typical testnet and development environments, capital deployed by scripts (`scripts/deploy-testnet.sh` funds up to 1,000,000 USDC) dwarfs the active daily risk limits (`MAX_DAILY` defaults to 1,000 USDC). Unused collateral sits idle as an unyielding SEP-41 balance.

Blend is the standard decentralized lending protocol on Stellar/Soroban. Supplying idle USDC to a Blend lending pool allows the treasury to generate passive yield on idle assets. However, integrating external lending into the treasury introduces critical requirements:
1. **Preservation of Core Guarantees**: Caps (`max_trade`, `max_market`, `max_daily`, `max_net_exposure`) must remain hard on-chain constraints calculated against actual capital, and agent trades (`agent_buy`, `agent_create_market`) must maintain atomic execution.
2. **Just-In-Time (JIT) Liquidity**: When an agent trade requires more liquid collateral than is currently sitting in the treasury's liquid SEP-41 balance, the treasury must withdraw the exact shortfall from Blend and proceed with the trade in the identical invocation.
3. **Atomicity & Fail-Closed Behavior**: If Blend withdrawal fails (due to pool illiquidity, high utilization, or upstream contract pause), the entire invocation must revert cleanly without partially executing the trade or leaking foreign error codes.
4. **Third-Party Risk Containment**: Capital exposed to Blend must be explicitly capped (`max_allocation`) by the admin, and yield venue integration remains strictly opt-in and testnet-only.

## Target Testnet Deployment & Interface

- **Target Protocol**: Blend Protocol (Testnet Pool deployment, v1 pool interface).
- **Interface Specification**: Rather than vendoring Blend's heavy wasm bundle, the integration defines a minimal, structural `#[contractclient(name = "BlendPoolClient")]` trait matching Blend's on-chain contract spec field-for-field:

```rust
#[contracttype]
#[derive(Clone)]
pub struct BlendRequest {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct BlendPositions {
    pub supply: Map<Address, i128>,
    pub collateral: Map<Address, i128>,
    pub liabilities: Map<Address, i128>,
}

#[soroban_sdk::contractclient(name = "BlendPoolClient")]
pub trait BlendPool {
    fn submit(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<BlendRequest>,
    ) -> BlendPositions;
    fn get_positions(env: Env, address: Address) -> BlendPositions;
}
```

- **Request Types**:
  - `0`: `Supply` — transfers collateral from spender/from into pool and records supply position.
  - `1`: `Withdraw` — withdraws supplied collateral back to `to`.
- **Pre-authorization**: Transfers initiated during `submit` require the treasury to pre-authorize token transfer from itself to the pool via `authorize_transfer(token, from, pool, amount)`.

## Decision & Invariants

1. **Testnet-Only & Non-Custodial Allocation**:
   - Blend integration is bounded by `max_allocation`.
   - The treasury only interacts with single-asset supply and withdrawal; borrowing, leverage, or BLND emission farming are out of scope.
   - Allocations require admin authorization (`allocate_to_yield`, `recall_from_yield`, `set_yield_venue`).
   - `allocate_to_yield` enforces that at least `max_daily` remains liquid in the treasury at all times.

2. **JIT Liquidity with Fail-Closed Semantics**:
   - Before executing `agent_buy` or `agent_create_market`, `ensure_liquid(&env, &config, needed)` checks the SEP-41 balance.
   - If liquid < needed:
     - Calculates `shortfall = needed - liquid`.
     - Submits a withdraw request with a small rounding cushion (+1 unit) to absorb potential integer floor rounding in pool shares.
     - Confirms balance >= needed. If still insufficient or if `submit` reverts, raises `YieldWithdrawFailed` (error code 42) to abort the transaction.
   - Because Soroban transactions are fully atomic, any failure in subsequent trade execution or cap enforcement automatically reverts the JIT withdrawal.

3. **Utilization & Liquidity Risk**:
   - Blend pools are variable-utilization money markets. If borrower utilization approaches 100%, pool liquidity may be temporarily exhausted.
   - The treasury does **not** degrade security or allow unbacked trades: when pool liquidity is insufficient, the trade reverts immediately with `YieldWithdrawFailed`.

4. **Accounting & Valuation**:
   - `YieldPrincipal` records cumulative net principal deposited.
   - `available_capital()` returns `liquid_balance + yield_value`, providing an accurate measure of total deployable capital.
   - `liquid_capital()` returns solely the unencumbered liquid SEP-41 balance.
   - `capital_breakdown()` returns `{ liquid, yield_principal, yield_value }`.
   - Interest or losses reported by the pool are reflected in `yield_value` (never artificially capped or fabricated).

## Consequences

- Idle funds generate yield when enabled without altering agent trading CLI workflows.
- Agent buys seamlessly tap into supplied yield liquidity without manual rebalancing.
- High pool utilization or pool downtime immediately halts affected agent deployments (fail-closed).
