// x402/trace-cache.ts - Issue #81: Verified-trace caching, gateway failover and response size limits

export interface CacheStore {
  get(hash: string): Promise<Uint8Array | undefined>;
  set(hash: string, bytes: Uint8Array): Promise<void>;
}

export class MemoryLruStore implements CacheStore {
  private cache = new Map<string, Uint8Array>();
  private accessOrder: string[] = [];
  private totalBytes = 0;

  constructor(private maxBytes: number) {}

  async get(hash: string): Promise<Uint8Array | undefined> {
    const bytes = this.cache.get(hash);
    if (!bytes) return undefined;

    // Update access order
    const idx = this.accessOrder.indexOf(hash);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(hash);

    return bytes;
  }

  async set(hash: string, bytes: Uint8Array): Promise<void> {
    // Remove if already exists
    if (this.cache.has(hash)) {
      this.totalBytes -= this.cache.get(hash)!.length;
      this.cache.delete(hash);
      const idx = this.accessOrder.indexOf(hash);
      if (idx >= 0) this.accessOrder.splice(idx, 1);
    }

    // Evict LRU entries until space available
    while (this.totalBytes + bytes.length > this.maxBytes && this.cache.size > 0) {
      const oldest = this.accessOrder.shift()!;
      const evicted = this.cache.get(oldest)!;
      this.totalBytes -= evicted.length;
      this.cache.delete(oldest);
    }

    // Add new entry
    this.cache.set(hash, bytes);
    this.accessOrder.push(hash);
    this.totalBytes += bytes.length;
  }

  getStats() {
    return { size: this.cache.size, totalBytes: this.totalBytes };
  }
}

export interface TraceMetrics {
  cacheHit(tier: string): void;
  cacheMiss(): void;
  gatewayLatency(gateway: string, ms: number, ok: boolean): void;
  verificationMismatch(gateway: string): void;
  tooLarge(gateway: string): void;
}

class NoOpMetrics implements TraceMetrics {
  cacheHit() {}
  cacheMiss() {}
  gatewayLatency() {}
  verificationMismatch() {}
  tooLarge() {}
}

export class VerifiedTraceCache {
  private singleFlight = new Map<string, Promise<Uint8Array>>();
  private negativeCache = new Map<string, number>();
  private NEGATIVE_TTL_MS = 5000;

  constructor(
    private tiers: CacheStore[],
    private metrics: TraceMetrics = new NoOpMetrics(),
  ) {}

  async get(hash: string): Promise<Uint8Array | undefined> {
    // Check negative cache
    const negTime = this.negativeCache.get(hash);
    if (negTime && Date.now() - negTime < this.NEGATIVE_TTL_MS) {
      return undefined;
    }

    // Check each tier
    for (const tier of this.tiers) {
      const bytes = await tier.get(hash);
      if (bytes) {
        this.metrics.cacheHit(tier === this.tiers[0] ? "memory" : "disk");
        return bytes;
      }
    }

    this.metrics.cacheMiss();
    return undefined;
  }

  async putVerified(hash: string, bytes: Uint8Array, verify: (b: Uint8Array) => boolean): Promise<void> {
    // Defense in depth: verify again on put
    if (!verify(bytes)) {
      throw new Error("Verification failed on cache put");
    }

    // Write to all tiers
    for (const tier of this.tiers) {
      await tier.set(hash, bytes);
    }
  }

  setSingleFlight(hash: string, promise: Promise<Uint8Array>): void {
    this.singleFlight.set(hash, promise);
    promise.finally(() => {
      this.singleFlight.delete(hash);
      // On failure, set negative cache
      promise.catch(() => {
        this.negativeCache.set(hash, Date.now());
      });
    });
  }

  getSingleFlight(hash: string): Promise<Uint8Array> | undefined {
    return this.singleFlight.get(hash);
  }
}

/**
 * Reads a bounded response body from a fetch response.
 * Aborts if body exceeds maxBytes while streaming.
 */
export async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`TraceTooLarge: content-length ${contentLength} exceeds ${maxBytes}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        signal.dispatchEvent(new Event("abort"));
        throw new Error(`TraceTooLarge: streamed body exceeds ${maxBytes} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new Uint8Array(
    chunks.reduce((acc, chunk) => {
      acc.push(...chunk);
      return acc;
    }, [] as number[]),
  );
}

interface GatewayHealth {
  url: string;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
}

export interface FetchVerifiedOptions {
  gateways: string[];
  maxBytes?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  hedgeDelayMs?: number;
  metrics?: TraceMetrics;
}

/**
 * Fetches a trace from multiple gateways with hedged requests and verification.
 * Returns the first verified response.
 */
export async function fetchVerified(
  cid: string,
  hash: string,
  verify: (b: Uint8Array) => boolean,
  options: FetchVerifiedOptions,
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? 262144; // 256 KiB
  const timeoutMs = options.timeoutMs ?? 4000;
  const deadlineMs = options.deadlineMs ?? 10000;
  const hedgeDelayMs = options.hedgeDelayMs ?? 300;
  const metrics = options.metrics ?? new NoOpMetrics();

  const deadline = Date.now() + deadlineMs;
  const errors: Map<string, string> = new Map();

  const attempts = options.gateways.map((gateway, index) => ({
    gateway,
    startTime: Date.now() + index * hedgeDelayMs,
  }));

  const overallAbort = new AbortController();
  const deadlineTimeout = setTimeout(() => overallAbort.abort(), deadlineMs);

  try {
    return await Promise.race(
      attempts.map(async ({ gateway, startTime }) => {
        // Wait until it's time to start this attempt
        await new Promise((resolve) => {
          const waitTime = startTime - Date.now();
          if (waitTime > 0) {
            setTimeout(resolve, waitTime);
          } else {
            resolve(undefined);
          }
        });

        const attemptAbort = new AbortController();
        const timeoutHandle = setTimeout(
          () => attemptAbort.abort(),
          timeoutMs,
        );

        try {
          const url = `${gateway.replace(/\/$/, "")}/${encodeURIComponent(cid)}`;
          const start = Date.now();

          const response = await fetch(url, {
            signal: AbortSignal.any([attemptAbort.signal, overallAbort.signal]),
          });

          const latency = Date.now() - start;
          if (!response.ok) {
            metrics.gatewayLatency(gateway, latency, false);
            throw new Error(`HTTP ${response.status}`);
          }

          const bytes = await readBounded(response, maxBytes, overallAbort.signal);

          // Verify
          if (!verify(bytes)) {
            metrics.verificationMismatch(gateway);
            throw new Error("Verification failed");
          }

          metrics.gatewayLatency(gateway, latency, true);
          overallAbort.abort();
          return bytes;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          if (msg.includes("TraceTooLarge")) {
            metrics.tooLarge(gateway);
          }
          errors.set(gateway, msg);
          throw error;
        } finally {
          clearTimeout(timeoutHandle);
        }
      }),
    );
  } catch (error) {
    clearTimeout(deadlineTimeout);
    const errorList = Array.from(errors.entries())
      .map(([gw, msg]) => `${gw}: ${msg}`)
      .join("; ");
    throw new Error(`GatewaysExhausted: ${errorList}`);
  }
}