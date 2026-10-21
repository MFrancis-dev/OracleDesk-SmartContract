// x402/pricing.ts - Issue #85: Dynamic trace pricing tied to market state and trace freshness

export interface PricingInputs {
  status: "Open" | "Resolved" | "Void";
  closeTime: number;
  publishedAt: number;
}

export interface PricingSchedule {
  openFar: bigint;
  openNearClose: {
    stroops: bigint;
    windowSecs: number;
  };
  closedUnresolved: bigint;
  resolved: {
    start: bigint;
    halfLifeSecs: number;
    floor: bigint;
    freeAfterSecs?: number;
  };
}

export interface Quote {
  stroops: bigint;
  tier: string;
  validUntil: number;
}

/**
 * Computes the price for a trace based on market state and freshness.
 * Uses integer math for decay: price = max(floor, start >> floor((now - closeTime) / halfLifeSecs))
 */
export function priceTrace(
  inputs: PricingInputs,
  schedule: PricingSchedule,
  now: number,
): Quote {
  const now_s = Math.floor(now / 1000);
  const close_s = Math.floor(inputs.closeTime / 1000);
  const pub_s = Math.floor(inputs.publishedAt / 1000);

  if (inputs.status === "Open") {
    // Check if within near-close window
    const near_close_window = schedule.openNearClose.windowSecs;
    const time_until_close = close_s - now_s;

    if (time_until_close >= 0 && time_until_close <= near_close_window) {
      // Within near-close window
      return {
        stroops: schedule.openNearClose.stroops,
        tier: "open_near_close",
        validUntil: (close_s + 1) * 1000, // Until market closes
      };
    } else {
      // Far from close
      return {
        stroops: schedule.openFar,
        tier: "open_far",
        validUntil:
          time_until_close < 0
            ? now_s * 1000
            : (close_s - near_close_window) * 1000,
      };
    }
  }

  if (inputs.status === "Resolved" || inputs.status === "Void") {
    // Market is resolved or void
    const time_since_close = now_s - close_s;
    const embargo_secs = inputs.status === "Resolved" ? schedule.resolved.freeAfterSecs ?? 0 : 0;

    // Check if past embargo (free)
    if (embargo_secs > 0 && time_since_close >= embargo_secs) {
      return {
        stroops: 0n,
        tier: "free_post_embargo",
        validUntil: (close_s + embargo_secs) * 1000,
      };
    }

    // Apply decay: price = max(floor, start >> floor((now - closeTime) / halfLifeSecs))
    const halfLife = schedule.resolved.halfLifeSecs;
    const decay_steps = Math.floor(Math.max(0, time_since_close) / halfLife);
    const decayed = schedule.resolved.start >> BigInt(decay_steps);
    const price = decayed < schedule.resolved.floor ? schedule.resolved.floor : decayed;

    // validUntil is next decay step boundary or embargo end
    let validUntil = (close_s + (decay_steps + 1) * halfLife) * 1000;
    if (embargo_secs > 0) {
      validUntil = Math.min(validUntil, (close_s + embargo_secs) * 1000);
    }

    return {
      stroops: price,
      tier: "resolved",
      validUntil,
    };
  }

  // closedUnresolved: past close but still Open
  return {
    stroops: schedule.closedUnresolved,
    tier: "closed_unresolved",
    validUntil: (close_s + schedule.openNearClose.windowSecs) * 1000,
  };
}

export interface MarketStateReader {
  get_market(args: {
    market_id: bigint;
  }): Promise<{
    result: {
      status: { tag: string };
      close_time: bigint;
    };
  }>;
}

export interface CachedInputs {
  status: "Open" | "Resolved" | "Void";
  closeTime: number;
  publishedAt: number;
  cachedAt: number;
  ttlMs: number;
}

export class PricingEngine {
  private traceCache = new Map<string, CachedInputs>();
  private marketCache = new Map<string, { status: string; closeTime: bigint; cachedAt: number; ttlMs: number }>();

  constructor(
    private marketReader: MarketStateReader,
    private schedule: PricingSchedule,
  ) {}

  async getPrice(
    traceId: string,
    marketId: bigint,
    publishedAt: number,
  ): Promise<Quote> {
    const now = Date.now();

    // Get cached or fresh market state
    const market = await this.getMarketState(marketId, now);

    // Build pricing inputs
    const inputs: PricingInputs = {
      status:
        market.status === "Open"
          ? "Open"
          : market.status === "Resolved"
            ? "Resolved"
            : "Void",
      closeTime: Number(market.closeTime) * 1000,
      publishedAt: publishedAt * 1000,
    };

    return priceTrace(inputs, this.schedule, now);
  }

  private async getMarketState(
    marketId: bigint,
    now: number,
  ): Promise<{ status: string; closeTime: bigint }> {
    const key = marketId.toString();
    const cached = this.marketCache.get(key);

    if (cached && now - cached.cachedAt < cached.ttlMs) {
      return { status: cached.status, closeTime: cached.closeTime };
    }

    try {
      const result = await this.marketReader.get_market({ market_id: marketId });
      const status = result.result.status.tag;
      const closeTime = result.result.close_time;

      // Cache with market-state-aware TTL
      const ttlMs = status === "Open" ? 30_000 : status === "Resolved" ? 3_600_000 : 30_000;
      this.marketCache.set(key, {
        status,
        closeTime,
        cachedAt: now,
        ttlMs,
      });

      return { status, closeTime };
    } catch (error) {
      // Fail-safe: use maximum price on RPC failure
      console.error(`Market read failed for ${key}:`, error);
      return { status: "Resolved", closeTime: BigInt(Math.floor(now / 1000)) };
    }
  }

  clearCache() {
    this.traceCache.clear();
    this.marketCache.clear();
  }
}

/**
 * Formats a stroops amount to decimal USDC string (7 decimals)
 */
export function stroopsToDecimal(stroops: bigint): string {
  const str = stroops.toString();
  const padded = str.padStart(8, "0");
  const integer = padded.slice(0, -7) || "0";
  const fractional = padded.slice(-7);
  const trimmed = fractional.replace(/0+$/, "");
  return trimmed ? `${integer}.${trimmed}` : integer;
}