/**
 * Distributed payment coordinator: ensures at most one settle per payment
 * across all x402 instances using distributed locks and fencing tokens.
 */
import { type SharedStore } from "./store.js";
import { logger } from "./logger.js";

const LOCK_TTL_MS = Number(process.env.X402_LOCK_TTL_MS ?? 30_000);
const LOCK_WAIT_MS = Number(process.env.X402_LOCK_WAIT_MS ?? 0);
const RESULT_TTL_MS = Number(process.env.X402_RESULT_TTL_MS ?? 600_000);

type PaymentState = "verified" | `settling:${number}` | "settled" | "failed" | "indeterminate";

export interface PaymentCoordinator {
  /** Called before verify. Returns false if another instance already handled this payment. */
  beforeVerify(paymentId: string): Promise<"proceed" | "replay" | "busy">;
  /** Called before settle. Returns false if lease was lost. */
  beforeSettle(paymentId: string, fence: number): Promise<boolean>;
  /** Called after successful settle. */
  afterSettle(paymentId: string, fence: number, receipt: string): Promise<void>;
  /** Called on settle failure. */
  onSettleFailure(paymentId: string, fence: number, timedOut: boolean): Promise<void>;
  /** Called in finally to release lease. */
  release(paymentId: string): Promise<void>;
  /** Returns stored result for replay. */
  getStoredResult(paymentId: string): Promise<{ state: string; receipt?: string } | undefined>;
}

interface InFlightEntry {
  fence: number;
  renewalTimer?: ReturnType<typeof setInterval>;
  leaseLost: boolean;
}

export function createPaymentCoordinator(store: SharedStore): PaymentCoordinator {
  const inFlight = new Map<string, InFlightEntry>();

  return {
    async beforeVerify(paymentId: string): Promise<"proceed" | "replay" | "busy"> {
      // Check if already handled
      const existing = await store.get(`state:pay:${paymentId}`);
      if (existing === "settled" || existing === "indeterminate") {
        return "replay";
      }

      // Try to acquire lock
      const lease = await store.acquire(`pay:${paymentId}`, LOCK_TTL_MS);
      if (!lease) {
        if (LOCK_WAIT_MS > 0) {
          // Poll briefly
          const deadline = Date.now() + LOCK_WAIT_MS;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            const state = await store.get(`state:pay:${paymentId}`);
            if (state === "settled") return "replay";
            const retryLease = await store.acquire(`pay:${paymentId}`, LOCK_TTL_MS);
            if (retryLease) {
              startRenewal(paymentId, retryLease.fence);
              return "proceed";
            }
          }
        }
        return "busy";
      }

      startRenewal(paymentId, lease.fence);
      return "proceed";

      function startRenewal(pid: string, fence: number) {
        const entry: InFlightEntry = { fence, leaseLost: false };
        const interval = setInterval(async () => {
          const current = inFlight.get(pid);
          if (!current) { clearInterval(interval); return; }
          const renewed = await store.renew({ key: `pay:${pid}`, token: "", fence, expiresAt: 0 }, LOCK_TTL_MS);
          if (!renewed) {
            current.leaseLost = true;
            clearInterval(interval);
            logger.warn({ paymentId: pid }, "payment lock lease lost mid-settle");
          }
        }, Math.floor(LOCK_TTL_MS / 3));
        entry.renewalTimer = interval;
        inFlight.set(pid, entry);
      }
    },

    async beforeSettle(paymentId: string, fence: number): Promise<boolean> {
      const entry = inFlight.get(paymentId);
      if (!entry || entry.leaseLost) {
        logger.error({ paymentId }, "beforeSettle: lease lost, aborting settle");
        return false;
      }
      // CAS: state must be undefined or "verified" -> "settling:<fence>"
      const ok = await store.cas(
        `state:pay:${paymentId}`,
        undefined,
        `settling:${fence}`,
        LOCK_TTL_MS,
      ) || await store.cas(
        `state:pay:${paymentId}`,
        "verified",
        `settling:${fence}`,
        LOCK_TTL_MS,
      );
      if (!ok) {
        logger.warn({ paymentId }, "beforeSettle: CAS failed, another instance settling");
        return false;
      }
      return true;
    },

    async afterSettle(paymentId: string, fence: number, receipt: string): Promise<void> {
      const ok = await store.cas(
        `state:pay:${paymentId}`,
        `settling:${fence}`,
        "settled",
        RESULT_TTL_MS,
      );
      if (ok) {
        await store.set(`result:pay:${paymentId}`, JSON.stringify({ state: "settled", receipt }), {
          ttlMs: RESULT_TTL_MS,
        });
      }
    },

    async onSettleFailure(paymentId: string, fence: number, timedOut: boolean): Promise<void> {
      const nextState = timedOut ? "indeterminate" : "failed";
      await store.cas(`state:pay:${paymentId}`, `settling:${fence}`, nextState, RESULT_TTL_MS);
      logger.error({ paymentId, nextState }, "settle failure");
    },

    async release(paymentId: string): Promise<void> {
      const entry = inFlight.get(paymentId);
      if (entry?.renewalTimer) clearInterval(entry.renewalTimer);
      inFlight.delete(paymentId);
      await store.release({ key: `pay:${paymentId}`, token: "", fence: 0, expiresAt: 0 });
    },

    async getStoredResult(paymentId: string): Promise<{ state: string; receipt?: string } | undefined> {
      const raw = await store.get(`result:pay:${paymentId}`);
      if (!raw) return undefined;
      try { return JSON.parse(raw) as { state: string; receipt?: string }; }
      catch { return undefined; }
    },
  };
}
