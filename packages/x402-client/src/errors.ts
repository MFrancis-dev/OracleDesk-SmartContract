export class X402ClientError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "X402ClientError";
  }
}

export class VerificationFailed extends X402ClientError {
  constructor(message: string) {
    super(message, "VERIFICATION_FAILED");
  }
}

export class InvalidSignature extends X402ClientError {
  constructor(message: string) {
    super(message, "INVALID_SIGNATURE");
  }
}

export class TraceNotFound extends X402ClientError {
  constructor(traceHash: string) {
    super(`Trace not found: ${traceHash}`, "TRACE_NOT_FOUND");
  }
}

export class PaymentError extends X402ClientError {
  constructor(message: string, code?: string) {
    super(message, code ?? "PAYMENT_ERROR");
  }
}

export function classifyClientError(e: unknown): { kind: string; message: string } {
  if (e instanceof VerificationFailed) return { kind: "verification_failed", message: e.message };
  if (e instanceof InvalidSignature) return { kind: "invalid_signature", message: e.message };
  if (e instanceof TraceNotFound) return { kind: "trace_not_found", message: e.message };
  if (e instanceof X402ClientError) return { kind: "x402_error", message: e.message };
  if (e instanceof Error) return { kind: "unknown", message: e.message };
  return { kind: "unknown", message: String(e) };
}
