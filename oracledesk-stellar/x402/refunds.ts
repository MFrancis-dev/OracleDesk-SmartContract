// x402/refunds.ts - Issue #90: Refund and dispute handling for failed x402 trace deliveries

import { createHash } from "node:crypto";

export enum PaymentState {
  SettledNotDelivered = "settled-not-delivered",
  Indeterminate = "indeterminate",
  Delivered = "delivered",
}

export enum RefundState {
  Requested = "requested",
  AutoApproved = "auto_approved",
  PendingReview = "pending_review",
  Approved = "approved",
  Rejected = "rejected",
  Executing = "executing",
  Completed = "completed",
  Failed = "failed",
}

export interface PaymentRecord {
  paymentId: string;
  traceId: string;
  network: string;
  payer: string;
  amount: bigint;
  asset: string;
  settlementTx?: string;
  state: PaymentState;
  deliveredAt?: number;
}

export interface RefundRequest {
  id: string;
  paymentId: string;
  traceId: string;
  nonce: string;
  signature: string;
  payer: string;
  amount: bigint;
  state: RefundState;
  createdAt: number;
  refundTx?: string;
  disputeBytes?: Uint8Array;
}

export interface ChallengeNonce {
  nonce: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/**
 * Store interface for payment records (to be implemented on top of PaymentLedger)
 */
export interface RefundablePaymentStore {
  get(paymentId: string): Promise<PaymentRecord | undefined>;
  findBySettlementTx(tx: string): Promise<PaymentRecord | undefined>;
  markRefund(paymentId: string, refundId: string): Promise<void>;
  recordPayment(record: PaymentRecord): Promise<void>;
  updatePaymentState(paymentId: string, state: PaymentState, deliveredAt?: number): Promise<void>;
}

/**
 * In-memory implementation of payment store for testing
 */
export class MemoryPaymentStore implements RefundablePaymentStore {
  private payments = new Map<string, PaymentRecord>();
  private txIndex = new Map<string, string>();

  async get(paymentId: string): Promise<PaymentRecord | undefined> {
    return this.payments.get(paymentId);
  }

  async findBySettlementTx(tx: string): Promise<PaymentRecord | undefined> {
    const paymentId = this.txIndex.get(tx);
    return paymentId ? this.payments.get(paymentId) : undefined;
  }

  async markRefund(paymentId: string, refundId: string): Promise<void> {
    const payment = this.payments.get(paymentId);
    if (payment) {
      // Mark refund in audit log (simplified)
    }
  }

  async recordPayment(record: PaymentRecord): Promise<void> {
    this.payments.set(record.paymentId, record);
    if (record.settlementTx) {
      this.txIndex.set(record.settlementTx, record.paymentId);
    }
  }

  async updatePaymentState(paymentId: string, state: PaymentState, deliveredAt?: number): Promise<void> {
    const payment = this.payments.get(paymentId);
    if (payment) {
      payment.state = state;
      if (deliveredAt) payment.deliveredAt = deliveredAt;
    }
  }
}

export interface RefundManager {
  issueChallenge(paymentId: string, traceId: string): Promise<{ nonce: string; expiresAt: number }>;
  requestRefund(req: {
    paymentId?: string;
    settlementTx?: string;
    traceId: string;
    nonce: string;
    signature: string;
    network: string;
  }): Promise<{ refundId: string; eligible: boolean; reason?: string }>;
  getRefunds(state?: RefundState, limit?: number): Promise<RefundRequest[]>;
  approveRefund(refundId: string): Promise<void>;
  rejectRefund(refundId: string, reason: string): Promise<void>;
}

export class RefundManagerImpl implements RefundManager {
  private nonces = new Map<string, ChallengeNonce>();
  private refunds = new Map<string, RefundRequest>();
  private refundWindow = 72 * 3600 * 1000; // 72 hours
  private autoApproveMax = 1_000_000n; // stroops
  private dailyCap = 100_000_000n; // stroops
  private paymentRefundMap = new Map<string, string>(); // paymentId -> refundId

  constructor(
    private paymentStore: RefundablePaymentStore,
    private rpcUrl: string,
  ) {}

  async issueChallenge(paymentId: string, traceId: string): Promise<{ nonce: string; expiresAt: number }> {
    const nonce = this.generateNonce();
    const now = Date.now();
    const expiresAt = now + 5 * 60 * 1000; // 5 minutes

    this.nonces.set(nonce, {
      nonce,
      createdAt: now,
      expiresAt,
      used: false,
    });

    return { nonce, expiresAt };
  }

  async requestRefund(req: {
    paymentId?: string;
    settlementTx?: string;
    traceId: string;
    nonce: string;
    signature: string;
    network: string;
  }): Promise<{ refundId: string; eligible: boolean; reason?: string }> {
    // Resolve payment
    let payment: PaymentRecord | undefined;
    if (req.paymentId) {
      payment = await this.paymentStore.get(req.paymentId);
    } else if (req.settlementTx) {
      payment = await this.paymentStore.findBySettlementTx(req.settlementTx);
    }

    if (!payment) {
      return { refundId: "", eligible: false, reason: "Payment not found" };
    }

    // Check for existing refund
    if (this.paymentRefundMap.has(payment.paymentId)) {
      return { refundId: "", eligible: false, reason: "Refund already requested for this payment" };
    }

    // Verify nonce
    const nonceData = this.nonces.get(req.nonce);
    if (!nonceData || nonceData.used || Date.now() > nonceData.expiresAt) {
      return { refundId: "", eligible: false, reason: "Invalid or expired nonce" };
    }

    // Verify signature
    const message = this.buildRefundMessage(payment.paymentId, req.traceId, req.nonce, payment.network);
    const valid = this.verifySignature(message, req.signature, payment.payer);
    if (!valid) {
      return { refundId: "", eligible: false, reason: "Invalid signature" };
    }

    // Mark nonce as used
    nonceData.used = true;

    // Check eligibility
    const now = Date.now();
    const age = now - (payment.deliveredAt || payment.state === PaymentState.Delivered ? now : 0);

    if (age > this.refundWindow) {
      return { refundId: "", eligible: false, reason: "Refund window expired" };
    }

    if (payment.state === PaymentState.Delivered) {
      // Can only refund delivered traces with verifiable hash dispute
      return { refundId: "", eligible: false, reason: "Delivered traces require hash dispute" };
    }

    // Create refund request
    const refundId = this.generateRefundId();
    const refundRequest: RefundRequest = {
      id: refundId,
      paymentId: payment.paymentId,
      traceId: req.traceId,
      nonce: req.nonce,
      signature: req.signature,
      payer: payment.payer,
      amount: payment.amount,
      state: payment.amount <= this.autoApproveMax ? RefundState.AutoApproved : RefundState.PendingReview,
      createdAt: now,
    };

    this.refunds.set(refundId, refundRequest);
    this.paymentRefundMap.set(payment.paymentId, refundId);
    await this.paymentStore.markRefund(payment.paymentId, refundId);

    return {
      refundId,
      eligible: true,
    };
  }

  async getRefunds(state?: RefundState, limit = 100): Promise<RefundRequest[]> {
    let refunds = Array.from(this.refunds.values());
    if (state) {
      refunds = refunds.filter((r) => r.state === state);
    }
    return refunds.slice(0, limit);
  }

  async approveRefund(refundId: string): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error("Refund not found");
    refund.state = RefundState.Approved;
  }

  async rejectRefund(refundId: string, reason: string): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error("Refund not found");
    refund.state = RefundState.Rejected;
  }

  private buildRefundMessage(paymentId: string, traceId: string, nonce: string, network: string): string {
    return `oracledesk-x402-refund:v1\nnetwork:${network}\npayment:${paymentId}\ntrace:${traceId}\nnonce:${nonce}`;
  }

  private verifySignature(message: string, signature: string, publicKey: string): boolean {
    // In a real implementation, verify Ed25519 signature using the payer's public key
    // For now, a placeholder
    try {
      const messageHash = createHash("sha256").update(message).digest();
      // Would verify signature here with publicKey
      return true;
    } catch {
      return false;
    }
  }

  private generateNonce(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  }

  private generateRefundId(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  }
}

/**
 * SEP-41 transfer builder for refund execution
 */
export interface TransferOp {
  to: string;
  from: string;
  amount: bigint;
  asset: string;
  memo?: string;
}

/**
 * Refund executor - sends SEP-41 transfers from float account
 */
export class RefundExecutor {
  private executing = new Map<string, { txHash: string; startTime: number }>();

  constructor(
    private refundStore: Map<string, RefundRequest>,
    private floatAccount: string,
    private rpcUrl: string,
  ) {}

  async executeRefund(refund: RefundRequest): Promise<{ txHash: string; success: boolean }> {
    // Check if already executing
    if (this.executing.has(refund.id)) {
      const exec = this.executing.get(refund.id)!;
      // Check if still executing or completed
      return { txHash: exec.txHash, success: true };
    }

    try {
      // Build transfer operation
      const transferOp: TransferOp = {
        from: this.floatAccount,
        to: refund.payer,
        amount: refund.amount,
        asset: "native", // or the specific asset from payment record
      };

      // Simulate transaction (placeholder)
      const simResult = await this.simulateTransfer(transferOp);
      if (!simResult.ok) {
        throw new Error(`Simulation failed: ${simResult.error}`);
      }

      // Build and sign transaction
      const txHash = this.generateTxHash();
      this.executing.set(refund.id, { txHash, startTime: Date.now() });

      // Send transaction
      const sendResult = await this.sendTransaction(txHash, transferOp);
      if (!sendResult.ok) {
        this.executing.delete(refund.id);
        throw new Error(`Send failed: ${sendResult.error}`);
      }

      // Poll for confirmation
      const confirmed = await this.pollForConfirmation(txHash);
      this.executing.delete(refund.id);

      refund.refundTx = txHash;
      refund.state = confirmed ? RefundState.Completed : RefundState.Failed;

      return { txHash, success: confirmed };
    } catch (error) {
      this.executing.delete(refund.id);
      refund.state = RefundState.Failed;
      throw error;
    }
  }

  private async simulateTransfer(
    op: TransferOp,
  ): Promise<{ ok: boolean; error?: string }> {
    // Placeholder: would call Soroban RPC simulateTransaction
    return { ok: true };
  }

  private async sendTransaction(
    txHash: string,
    op: TransferOp,
  ): Promise<{ ok: boolean; error?: string }> {
    // Placeholder: would call Soroban RPC sendTransaction
    return { ok: true };
  }

  private async pollForConfirmation(txHash: string, maxAttempts = 30): Promise<boolean> {
    // Placeholder: would poll getTransaction until SUCCESS or FAILED
    return true;
  }

  private generateTxHash(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  }
}