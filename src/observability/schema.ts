import type { Operation } from "../types";

export const TELEMETRY_SCHEMA_VERSION = 1;

export interface CompletionLog {
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  timestamp: string;
  level: "info" | "warn" | "error";
  operation: Operation;
  requestID: string;
  serviceVersion: string;
  deployment: string;
  appID?: string;
  channelRef?: string;
  outcome: string;
  httpStatus: number;
  durationMs: number;
  event?: string;
  targetCount?: number;
  acceptedCount?: number;
  failedCount?: number;
  invalidTokenRemovalCount?: number;
  idempotency?: "new" | "duplicate" | "retry";
  apnsReason?: string;
  apnsStatus?: number;
  apnsRequestID?: string;
  apnsLatencyTotalMs?: number;
  apnsLatencyMaxMs?: number;
}

export interface Metric {
  appID?: string;
  deployment: string;
  operation: Operation;
  outcome: string;
  httpStatus: number;
  durationMs: number;
  serviceVersion: string;
  colo?: string;
  event?: string;
  apnsReason?: string;
  idempotency?: string;
  targetCount?: number;
  acceptedCount?: number;
  failedCount?: number;
  invalidTokenRemovalCount?: number;
  apnsLatencyTotalMs?: number;
  apnsLatencyMaxMs?: number;
  registrationDelta?: number;
  tokenReplacementCount?: number;
}
