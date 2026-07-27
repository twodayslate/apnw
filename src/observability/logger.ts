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
  const entry: CompletionLog = {
    schema: TELEMETRY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    level,
    operation: context.operation,
    requestID: context.requestID,
    serviceVersion: context.serviceVersion,
    deployment: context.deployment,
    ...(context.appID ? { appID: context.appID } : {}),
    ...(context.channelRef ? { channelRef: context.channelRef } : {}),
    durationMs: Date.now() - context.startedAt,
    ...stripMetricOnlyFields(details),
  };
  console.log(entry);
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
