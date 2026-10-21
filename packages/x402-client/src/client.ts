/**
 * X402Client: isomorphic buyer client for x402 payment protocol.
 * Handles payment, verification, and on-chain trace registration.
 */
import { randomUUID } from "node:crypto";
import type { RegistryClient } from "@oracledesk/bindings-reasoning-registry";
import { PaymentError, VerificationFailed } from "./errors.js";
import { verifyPayment } from "./verify.js";
import type { WalletSigner, SignatureResult } from "./signers.js";

export interface X402ClientConfig {
  facilityUrl: string;
  paymentAddress: string;
  registry: RegistryClient;
  walletSigner?: WalletSigner;
}

export interface PaymentRequest {
  traceHash: string;
  amount: bigint;
  deadline?: number;
}

export interface PaymentResponse {
  paymentId: string;
  status: "verified" | "pending" | "failed";
  receipt?: string;
  error?: string;
}

export class X402Client {
  private readonly config: X402ClientConfig;

  constructor(config: X402ClientConfig) {
    this.config = config;
  }

  async pay(req: PaymentRequest): Promise<PaymentResponse> {
    const paymentId = randomUUID();

    try {
      // Call facility to process payment
      const payResp = await fetch(`${this.config.facilityUrl}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment_id: paymentId,
          trace_hash: req.traceHash,
          amount: String(req.amount),
          deadline: req.deadline ?? Math.floor(Date.now() / 1000) + 300,
        }),
      });

      if (!payResp.ok) {
        return {
          paymentId,
          status: "failed",
          error: `Payment API error: ${payResp.status}`,
        };
      }

      const payResult = await payResp.json();
      if (!payResult.verified) {
        return { paymentId, status: "pending", receipt: payResult.receipt };
      }

      // Verify trace is on-chain
      try {
        await verifyPayment({
          traceHash: req.traceHash,
          paymentId,
          expectedAmount: req.amount,
          registry: this.config.registry,
        });
      } catch (e) {
        if (e instanceof VerificationFailed) {
          return {
            paymentId,
            status: "failed",
            error: e.message,
          };
        }
        throw e;
      }

      return {
        paymentId,
        status: "verified",
        receipt: payResult.receipt,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        paymentId,
        status: "failed",
        error: `Payment failed: ${msg}`,
      };
    }
  }
}
