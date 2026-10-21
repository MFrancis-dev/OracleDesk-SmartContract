/**
 * Verify x402 payments by reading the on-chain reasoning registry.
 * Ensures the payment actually happened and the trace is recorded.
 */
import { publicKeyFromString, xdr } from "@stellar/stellar-sdk";
import type { Client as RegistryClient } from "@oracledesk/bindings-reasoning-registry";
import { TraceNotFound, VerificationFailed } from "./errors.js";

export interface VerifyOptions {
  traceHash: string;
  paymentId: string;
  expectedAmount: bigint;
  registry: RegistryClient;
}

export interface VerificationResult {
  verified: boolean;
  traceHash: string;
  paymentId: string;
  timestamp: number;
  message?: string;
}

export async function verifyPayment(opts: VerifyOptions): Promise<VerificationResult> {
  const { traceHash, paymentId, expectedAmount, registry } = opts;

  try {
    const result = await registry.get_trace(Buffer.from(traceHash, "hex"));
    if (!result) throw new TraceNotFound(traceHash);

    const unpacked = result.unwrap();
    const metadata = unpacked.metadata ?? {};

    // Verify payment_id and amount match
    if (metadata.payment_id !== paymentId) {
      throw new VerificationFailed(
        `Payment ID mismatch: expected ${paymentId}, got ${metadata.payment_id}`,
      );
    }

    const amount = BigInt(metadata.amount ?? "0");
    if (amount < expectedAmount) {
      throw new VerificationFailed(
        `Amount insufficient: expected >= ${expectedAmount}, got ${amount}`,
      );
    }

    return {
      verified: true,
      traceHash,
      paymentId,
      timestamp: Math.floor(Date.now() / 1000),
    };
  } catch (e) {
    if (e instanceof (TraceNotFound || VerificationFailed)) throw e;
    throw new VerificationFailed(`Verification failed: ${String(e)}`);
  }
}
