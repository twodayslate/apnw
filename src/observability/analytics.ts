import type { Env, RequestContext } from "../types";
import type { Metric } from "./schema";

/**
 * Dataset schema (apnw_dev / apnw_prod)
 *
 * index1: app ID, or "_service" for app-independent requests
 * blob1..9: deployment, operation, outcome, HTTP status class,
 *   service version, colo, event template, allowlisted APNs reason, idempotency
 * double1..11: request count, duration ms, target, accepted, failed, invalid
 *   token removals, total APNs latency, max APNs latency, registration delta,
 *   token replacements, HTTP status
 */
export function writeMetric(
  env: Env,
  context: RequestContext,
  metric: Omit<
    Metric,
    | "appID"
    | "deployment"
    | "operation"
    | "serviceVersion"
    | "colo"
    | "durationMs"
  >,
): void {
  try {
    env.APNW_ANALYTICS?.writeDataPoint({
      indexes: [context.appID ?? "_service"],
      blobs: [
        context.deployment,
        context.operation,
        metric.outcome,
        `${Math.floor(metric.httpStatus / 100)}xx`,
        context.serviceVersion,
        context.colo ?? "unknown",
        metric.event ?? "none",
        metric.apnsReason ?? "none",
        metric.idempotency ?? "none",
      ],
      doubles: [
        1,
        Date.now() - context.startedAt,
        metric.targetCount ?? 0,
        metric.acceptedCount ?? 0,
        metric.failedCount ?? 0,
        metric.invalidTokenRemovalCount ?? 0,
        metric.apnsLatencyTotalMs ?? 0,
        metric.apnsLatencyMaxMs ?? 0,
        metric.registrationDelta ?? 0,
        metric.tokenReplacementCount ?? 0,
        metric.httpStatus,
      ],
    });
  } catch {
    console.warn({
      schema: 1,
      level: "warn",
      operation: "telemetry",
      outcome: "analytics_write_failed",
      requestID: context.requestID,
    });
  }
}

export function writeApnsReasonMetrics(
  env: Env,
  context: RequestContext,
  counts: Readonly<Record<string, number>> | undefined,
): void {
  if (!env.APNW_ANALYTICS || !counts) return;
  try {
    for (const [reason, count] of Object.entries(counts)) {
      if (count <= 0) continue;
      env.APNW_ANALYTICS.writeDataPoint({
        indexes: [context.appID ?? "_service"],
        blobs: [
          context.deployment,
          "apns_result",
          "error",
          "none",
          context.serviceVersion,
          context.colo ?? "unknown",
          "none",
          reason,
          "none",
        ],
        doubles: [count, 0, 0, 0, count, 0, 0, 0, 0, 0, 0],
      });
    }
  } catch {
    console.warn({
      schema: 1,
      level: "warn",
      operation: "telemetry",
      outcome: "analytics_write_failed",
      requestID: context.requestID,
    });
  }
}
