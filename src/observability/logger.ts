import {
  TELEMETRY_SCHEMA_VERSION,
  type CompletionLog,
} from "./schema";
import type { RequestContext } from "../types";

export type LogDetails = Omit<
  CompletionLog,
  | "schema"
  | "timestamp"
  | "level"
  | "operation"
  | "requestID"
  | "serviceVersion"
  | "deployment"
  | "appID"
  | "channelRef"
  | "durationMs"
> & {
  apnsReasonCounts?: Readonly<Record<string, number>>;
  operationDelta?: number;
  tokenReplacementCount?: number;
};

export function writeCompletionLog(
  context: RequestContext,
  details: LogDetails,
  sampleRate: number,
): void {
  if (
    details.httpStatus < 400 &&
    sampleRate < 1 &&
    Math.random() >= Math.max(0, sampleRate)
  ) {
    return;
  }

  const level =
    details.httpStatus >= 500
      ? "error"
      : details.httpStatus >= 400
        ? "warn"
        : "info";
  const reviewed = reviewDetails(details);
  const entry: CompletionLog = {
    schema: TELEMETRY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    level,
    operation: context.operation,
    requestID: context.requestID,
    serviceVersion: safeVersion(context.serviceVersion),
    deployment: context.deployment,
    ...(context.appID && /^[a-z0-9_]{1,64}$/.test(context.appID)
      ? { appID: context.appID }
      : {}),
    ...(context.channelRef && /^[0-9a-f]{16}$/.test(context.channelRef)
      ? { channelRef: context.channelRef }
      : {}),
    durationMs: Date.now() - context.startedAt,
    ...stripMetricOnlyFields(reviewed),
  };
  console.log(entry);
}

function reviewDetails(details: LogDetails): LogDetails {
  const safeReason = details.apnsReason?.match(/^[a-z0-9_]{1,40}$/)?.[0];
  const safeEvent = details.event?.match(/^[a-z0-9_]{1,64}$/)?.[0];
  const safeRequestID = details.apnsRequestID?.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )?.[0];
  return {
    ...details,
    outcome: safeDimension(details.outcome),
    ...(safeReason ? { apnsReason: safeReason } : { apnsReason: undefined }),
    ...(safeEvent ? { event: safeEvent } : { event: undefined }),
    ...(safeRequestID
      ? { apnsRequestID: safeRequestID }
      : { apnsRequestID: undefined }),
  };
}

function safeDimension(value: string): string {
  return /^[a-z0-9_]{1,48}$/.test(value) ? value : "invalid_dimension";
}

function safeVersion(value: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value)
    ? value
    : "invalid-version";
}

export function parseSampleRate(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

function stripMetricOnlyFields(details: LogDetails): Omit<
  LogDetails,
  "apnsReasonCounts" | "operationDelta" | "tokenReplacementCount"
> {
  const {
    apnsReasonCounts: _apnsReasonCounts,
    operationDelta: _operationDelta,
    tokenReplacementCount: _tokenReplacementCount,
    ...logDetails
  } = details;
  return logDetails;
}
