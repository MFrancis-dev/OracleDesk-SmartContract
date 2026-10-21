/**
 * The market-maker as a runtime task: the body of the old
 * bin/market-maker.ts main(), with dedupe and crash-safe bookkeeping.
 *
 * Per signal: skip if its id (sha256 of source, observedAt, question) was
 * already processed or its question already has a market; build and store
 * the trace; record an *intent* and mark the question "creating" (so the
 * trader keeps off it) BEFORE submitting; submit the create; record the
 * market as created (and revealed, once a reveal step exists); publish the
 * trace, tracked as pending until it lands so a later tick retries it.
 */
import { createHash } from "node:crypto";
import { buildTrace, type TraceStore } from "../../core/trace.js";
import { decideMarketProposal, type SignalSource } from "../../core/strategy.js";
import type { StellarAdapter } from "../../stellar/adapter.js";
import type { Task, TaskContext } from "../runtime.js";
import { publishPendingTraces, recordPendingTrace } from "./traces.js";

export interface MakerDeps {
  adapter: Pick<StellarAdapter, "mode" | "agent" | "agentCreateMarket" | "publishTrace">;
  traceStore: TraceStore;
  signals: SignalSource;
  /** Question hashes that already have a market on-chain. */
  knownQuestionHashes?: () => Promise<Set<string>>;
  /**
   * Reveals the market's resolution spec. Until one is wired in (see the
   * commit/reveal issue), created markets stay "created" and the trader
   * leaves them alone.
   */
  reveal?: (marketId: bigint) => Promise<unknown>;
  confidenceThresholdBps: number;
  defaultSeedStroops: bigint;
  closeInSecs: number;
}

export const SIGNALS = "maker.signals";

export function signalId(source: string, observedAt: number, question: string): string {
  return createHash("sha256").update(`${source}\u0000${observedAt}\u0000${question}`).digest("hex");
}

export async function makerTick(deps: MakerDeps, ctx: TaskContext): Promise<void> {
  const live = deps.adapter.mode === "live";
  if (live) await publishPendingTraces(deps.adapter, ctx);
  const known = (await deps.knownQuestionHashes?.()) ?? new Set<string>();
  const signals = await deps.signals.poll();
  for (const signal of signals) {
    if (ctx.signal.aborted) return;
    const decision = decideMarketProposal(signal, {
      confidenceThresholdBps: deps.confidenceThresholdBps,
      defaultSeedStroops: deps.defaultSeedStroops,
    });
    ctx.log.info("MAKER_DECISION", { action: decision.action, reasoning: decision.reasoning });
    if (decision.action === "skip") continue;

    const id = signalId(signal.source, signal.observedAt, decision.question!);
    const seen = ctx.state.get<{ status: string }>(SIGNALS, id);
    if (seen && seen.status !== "failed") {
      ctx.log.info("MAKER_SKIP_PROCESSED", { signal: id, status: seen.status });
      continue;
    }
    const questionHash = createHash("sha256").update(decision.question!).digest();
    const questionHashHex = questionHash.toString("hex");
    if (known.has(questionHashHex)) {
      ctx.log.info("MAKER_SKIP_DUPLICATE", { questionHash: questionHashHex });
      continue;
    }

    const built = buildTrace({
      agent: "market-maker",
      marketId: null,
      action: "propose_market",
      reasoning: decision.reasoning,
      inputs: { signal, decision },
    });
    const { cid } = await deps.traceStore.put(built.hash, built.json);
    ctx.log.info("MAKER_TRACE", { trace: built.hash, cid });

    const placeholderResolutionHash = createHash("sha256").update("unrevealed").digest();
    const args = {
      question_hash: questionHash,
      resolution_hash: placeholderResolutionHash,
      meta_uri: `local://${built.hash}`,
      category: { tag: "Macro", values: undefined as void },
      close_time: BigInt(Math.floor(ctx.now() / 1000) + deps.closeInSecs),
      seed_amount: decision.seedAmountStroops!,
      initial_yes_bps: decision.initialYesBps!,
    };

    // Intent before the submission it describes; "created" only after.
    if (live) {
      ctx.state.set(SIGNALS, id, { status: "intent", questionHash: questionHashHex, trace: built.hash, at: ctx.now() });
      ctx.locks.markCreating(questionHashHex);
      await ctx.state.flush();
    }
    let result: Awaited<ReturnType<MakerDeps["adapter"]["agentCreateMarket"]>>;
    try {
      result = await ctx.submit(() => deps.adapter.agentCreateMarket(args), `create:${questionHashHex}`);
    } catch (err) {
      // Left as "intent": the create may or may not have landed. It is never
      // retried blindly; an operator (or the tx journal) reconciles it.
      ctx.log.error("MAKER_CREATE_FAILED", { signal: id, err });
      throw err;
    }
    ctx.log.info("MAKER_CREATE", { result });
    if (result.dryRun) continue;

    const marketId = result.value;
    ctx.locks.markCreated(marketId, questionHashHex);
    ctx.locks.clearCreating(questionHashHex);
    ctx.state.set(SIGNALS, id, { status: "created", marketId, questionHash: questionHashHex, trace: built.hash, at: ctx.now() });
    known.add(questionHashHex);
    if (deps.reveal) {
      await ctx.locks.withLock(marketId, async () => {
        await ctx.submit(() => deps.reveal!(marketId), `reveal:${marketId}`);
        ctx.locks.markRevealed(marketId);
      });
    }

    recordPendingTrace(ctx, { marketId, action: "create_market", traceHash: built.hash, cid });
    await publishPendingTraces(deps.adapter, ctx);
  }
}

export function makerTask(deps: MakerDeps, opts: { intervalMs: number; jitterMs?: number }): Task {
  return { name: "maker", mode: deps.adapter.mode, ...opts, run: (ctx) => makerTick(deps, ctx) };
}
