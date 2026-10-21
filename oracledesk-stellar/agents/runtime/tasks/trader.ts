/**
 * The trader as a runtime task: the body of the old bin/trader.ts main().
 *
 * For each candidate market: skip our own markets until the maker has
 * revealed them (and anything still "creating"); under that market's
 * advisory lock, decide, store the trace, quote, then submit a bounded
 * `agent_buy_v2` (intent recorded first, "done" after) and publish the
 * trace through the pending-trace queue.
 */
import { BPS } from "../../core/fpmm.js";
import { decideTrade, type MarketState } from "../../core/strategy.js";
import { buildTrace, type TraceStore } from "../../core/trace.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { Task, TaskContext } from "../runtime.js";
import { publishPendingTraces, recordPendingTrace } from "./traces.js";

export interface TraderCandidate {
  market: MarketState;
  fairValueBps: number;
  /** Creator address, when known (our treasury => one of our own markets). */
  creator?: string;
  questionHash?: string;
  /** Ledger the market state was read at, if known. */
  ledger?: number;
}

export interface TraderDeps {
  adapter: Pick<StellarAdapter, "mode" | "agent" | "quoteBuy" | "agentBuyV2" | "publishTrace">;
  traceStore: TraceStore;
  candidates: () => Promise<TraderCandidate[]>;
  /** This deployment's treasury contract id (creator of our own markets). */
  treasury?: string;
  minEdgeBps: number;
  tradeSizeStroops: bigint;
  slippageBps: bigint;
  deadlineSecs: number;
  /** Unix seconds. */
  nowSecs: () => number;
}

export const TRADES = "trader.trades";
export const EVALUATED = "trader.markets";

/** The pre-chain-state demo pair (YES at 40% vs fair 60%). */
export async function fixtureCandidates(nowSecs: number): Promise<TraderCandidate[]> {
  return [{ market: { marketId: 0, question: "demo", yesBps: 4000, closeTime: nowSecs + 3600 }, fairValueBps: 6000 }];
}

export async function traderTick(deps: TraderDeps, ctx: TaskContext): Promise<void> {
  const live = deps.adapter.mode === "live";
  if (live) await publishPendingTraces(deps.adapter, ctx);
  const candidates = await deps.candidates();
  if (candidates.length === 0) ctx.log.info("TRADER_NO_MARKETS");
  for (const c of candidates) {
    if (ctx.signal.aborted) return;
    const { market, fairValueBps } = c;
    const own = deps.treasury !== undefined && c.creator === deps.treasury;
    if (own && !ctx.locks.ownMarketTradable(market.marketId, c.questionHash)) {
      ctx.log.info("TRADER_SKIP_UNREVEALED", { market: market.marketId, status: ctx.locks.status(market.marketId) ?? "unknown" });
      continue;
    }
    await ctx.locks.withLock(market.marketId, async () => {
      ctx.state.set(EVALUATED, String(market.marketId), { at: ctx.now(), ledger: c.ledger, yesBps: market.yesBps });
      const decision = decideTrade(market, fairValueBps, { minEdgeBps: deps.minEdgeBps, tradeSizeStroops: deps.tradeSizeStroops });
      ctx.log.info("TRADER_DECISION", { market: market.marketId, action: decision.action, reasoning: decision.reasoning });
      if (decision.action === "skip") return;

      const built = buildTrace({
        agent: "trader",
        marketId: market.marketId,
        action: "buy",
        reasoning: decision.reasoning,
        inputs: { market, fairValueBps, decision },
      });
      const { cid } = await deps.traceStore.put(built.hash, built.json);
      ctx.log.info("TRADER_TRACE", { trace: built.hash, cid });

      const outcome = { tag: decision.outcome!, values: undefined as void };
      const collateralIn = decision.collateralInStroops!;
      const quoted = await deps.adapter.quoteBuy({ market_id: BigInt(market.marketId), outcome, collateral_in: collateralIn });
      const minSharesOut = (quoted * (BPS - deps.slippageBps)) / BPS;
      const limitPriceBps = decision.outcome === "Yes" ? fairValueBps : Number(BPS) - fairValueBps;
      const deadline = BigInt(deps.nowSecs() + deps.deadlineSecs);
      ctx.log.info("TRADER_QUOTE", { quoted, minSharesOut, limitPriceBps, deadline });
      if (ctx.signal.aborted) return;

      const key = `${market.marketId}:${built.hash}`;
      if (live) ctx.state.set(TRADES, key, { status: "intent", at: ctx.now() });
      const result = await ctx.submit(
        () =>
          deps.adapter.agentBuyV2({
            market_id: BigInt(market.marketId),
            outcome,
            collateral_in: collateralIn,
            min_shares_out: minSharesOut,
            limit_price_bps: limitPriceBps,
            deadline,
          }),
        `buy:${key}`,
      );
      ctx.log.info("TRADER_BUY", { result });
      if (result.dryRun) return;
      ctx.state.set(TRADES, key, { status: "done", shares: result.value, at: ctx.now() });
      recordPendingTrace(ctx, { marketId: BigInt(market.marketId), action: "buy", traceHash: built.hash, cid });
      await publishPendingTraces(deps.adapter, ctx);
    });
  }
}

export function traderTask(deps: TraderDeps, opts: { intervalMs: number; jitterMs?: number }): Task {
  return { name: "trader", mode: deps.adapter.mode, ...opts, run: (ctx) => traderTick(deps, ctx) };
}
