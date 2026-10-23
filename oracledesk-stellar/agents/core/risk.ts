/**
 * Pre-trade risk checks for cross-market arbitrage (#108). The planner
 * already sizes a plan inside the hard treasury caps; these checks add the
 * arbitrage-specific limits that exist because the two legs are not atomic.
 */
import { BPS } from "./fpmm.js";
import type { ArbPlan } from "./strategies/arbitrage.js";

export interface ArbRiskLimits {
  /** ARB_MAX_NOTIONAL: most one plan may spend across both legs. */
  maxNotional: bigint;
  /** ARB_MAX_UNHEDGED_STROOPS: the first leg alone, if the second never fills. */
  maxUnhedged: bigint;
  /** ARB_MARKET_HEADROOM_BPS: share of each market's max_market kept free for hedges. */
  marketHeadroomBps: bigint;
  /** ARB_MAX_OPEN_LEGS: arbitrage legs in flight at once, across plans. */
  maxOpenLegs: number;
  /** ARB_MAX_UNWIND_RETRIES: attempts to sell a stranded first leg. */
  maxUnwindRetries: number;
}

export interface TreasuryRiskState {
  maxTrade: bigint;
  maxMarket: bigint;
  /** What the treasury has already committed per market (cost basis). */
  marketSpent: Map<bigint, bigint>;
  dailyRemaining: bigint;
  /** Arbitrage legs currently submitted but not settled. */
  openLegs: number;
}

/** Every limit `plan` breaks; empty means it may execute. */
export function checkArbPlan(plan: ArbPlan, state: TreasuryRiskState, limits: ArbRiskLimits): string[] {
  const problems: string[] = [];
  if (limits.maxUnwindRetries < 1) problems.push("ARB_MAX_UNWIND_RETRIES must allow at least one unwind attempt");
  if (limits.marketHeadroomBps < 0n || limits.marketHeadroomBps >= BPS) problems.push("ARB_MARKET_HEADROOM_BPS must be 0-9999");
  // Usable share of max_market once the reserved headroom is set aside.
  const usable = (state.maxMarket * (BPS - limits.marketHeadroomBps)) / BPS;
  for (const leg of plan.legs) {
    if (leg.collateral > state.maxTrade) {
      problems.push(`leg on market ${leg.marketId}: ${leg.collateral} exceeds max_trade ${state.maxTrade}`);
    }
    const spent = state.marketSpent.get(leg.marketId) ?? 0n;
    if (spent + leg.collateral > usable) {
      problems.push(
        `leg on market ${leg.marketId}: exposure ${spent + leg.collateral} would exceed ${usable} (max_market ${state.maxMarket} less ARB_MARKET_HEADROOM_BPS=${limits.marketHeadroomBps})`,
      );
    }
  }
  if (plan.cost > state.dailyRemaining) problems.push(`cost ${plan.cost} exceeds the remaining daily budget ${state.dailyRemaining}`);
  if (plan.cost > limits.maxNotional) problems.push(`cost ${plan.cost} exceeds ARB_MAX_NOTIONAL=${limits.maxNotional}`);
  const firstLeg = plan.legs[0].collateral;
  if (firstLeg > limits.maxUnhedged) {
    problems.push(`first leg ${firstLeg} exceeds ARB_MAX_UNHEDGED_STROOPS=${limits.maxUnhedged}, the exposure left if the second leg fails`);
  }
  if (state.openLegs + plan.legs.length > limits.maxOpenLegs) {
    problems.push(`${state.openLegs} arbitrage legs already open; ${plan.legs.length} more would exceed ARB_MAX_OPEN_LEGS=${limits.maxOpenLegs}`);
  }
  return problems;
}
