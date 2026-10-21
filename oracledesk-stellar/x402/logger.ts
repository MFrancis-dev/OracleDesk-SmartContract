/**
 * Structured pino logger with request correlation.
 * Redacts payment headers and API keys from logs.
 */
import pino from "pino";
import { randomUUID } from "node:crypto";

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["payment-signature"]',
      'req.headers["x-payment"]',
      'req.headers["x-api-key"]',
      "facilitatorApiKey",
    ],
    censor: "[REDACTED]",
  },
  base: { service: "oracledesk-x402" },
});

export function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const inbound = req.headers["x-request-id"];
  const id = Array.isArray(inbound) ? inbound[0] : inbound;
  if (id && REQUEST_ID_RE.test(id)) return id;
  return randomUUID();
}

export function createHttpLogger() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pinoHttp = require("pino-http");
  return pinoHttp({
    logger,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => genReqId(req),
    customSuccessMessage: (req: any, res: any) =>
      `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (_req: any, res: any, err: Error) =>
      `request failed: ${res.statusCode} ${err.message}`,
    redact: {
      paths: ["req.headers.authorization", 'req.headers["payment-signature"]'],
      censor: "[REDACTED]",
    },
  });
}
