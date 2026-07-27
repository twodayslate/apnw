import type { AppConfig } from "../apps";
import type { Env } from "../types";
import type { ApnsPayload } from "./payload";
import { getProviderToken, invalidateProviderToken } from "./jwt";

export type ApnsReason =
  | "none"
  | "bad_device_token"
  | "unregistered"
  | "rate_limited"
  | "service_unavailable"
  | "expired_provider_token"
  | "invalid_provider_token"
  | "topic_error"
  | "payload_error"
  | "request_timeout"
  | "network_error"
  | "upstream_unknown"
  | "environment_mismatch"
  | "circuit_open";

export interface ApnsResult {
  accepted: boolean;
  cleanup: "none" | "suspect" | "unregistered";
  configurationFailure: boolean;
  invalidationTimestamp?: number;
  retryable: boolean;
  status: number;
  reason: ApnsReason;
  requestID?: string;
  latencyMs: number;
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function sendNotification(
  env: Env,
  app: AppConfig,
  deviceToken: string,
  payload: ApnsPayload,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
): Promise<ApnsResult> {
  const startedAt = Date.now();
  if (env.APNS_KEY_ENVIRONMENT !== env.APNS_ENVIRONMENT) {
    return {
      accepted: false,
      cleanup: "none",
      configurationFailure: true,
      retryable: false,
      status: 0,
      reason: "environment_mismatch",
      latencyMs: 0,
    };
  }
  const host =
    env.APNS_ENVIRONMENT === "production"
      ? "api.push.apple.com"
      : "api.sandbox.push.apple.com";
  const collapseID = await collapseIdentifier(idempotencyKey);
  let response: Response;
  let errorBody: { reason?: string; timestamp?: number };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const providerToken = await getProviderToken(
        env.APNS_TEAM_ID,
        env.APNS_KEY_ID,
        env.APNS_KEY_P8,
      );
      response = await fetcher(
        `https://${host}/3/device/${encodeURIComponent(deviceToken)}`,
        {
          method: "POST",
          headers: {
            authorization: `bearer ${providerToken}`,
            "apns-collapse-id": collapseID,
            "apns-expiration": String(Math.floor(Date.now() / 1_000) + 3_600),
            "apns-priority": "10",
            "apns-push-type": "alert",
            "apns-topic": app.bundleID,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      const isTimeout =
        error instanceof DOMException && error.name === "TimeoutError";
      return {
        accepted: false,
        cleanup: "none",
        configurationFailure: false,
        retryable: true,
        status: 0,
        reason: isTimeout ? "request_timeout" : "network_error",
        latencyMs: Date.now() - startedAt,
      };
    }

    const requestID = response.headers.get("apns-id") ?? undefined;
    if (response.ok) {
      return {
        accepted: true,
        cleanup: "none",
        configurationFailure: false,
        retryable: false,
        status: response.status,
        reason: "none",
        ...(requestID ? { requestID } : {}),
        latencyMs: Date.now() - startedAt,
      };
    }

    errorBody = await readReason(response);
    if (errorBody.reason === "ExpiredProviderToken" && attempt === 0) {
      invalidateProviderToken(env.APNS_TEAM_ID, env.APNS_KEY_ID);
      continue;
    }
    break;
  }

  const requestID = response.headers.get("apns-id") ?? undefined;
  const rawReason = errorBody.reason;
  const reason = categorizeReason(response.status, rawReason);
  const configurationFailure =
    reason === "expired_provider_token" ||
    reason === "invalid_provider_token" ||
    reason === "topic_error" ||
    reason === "environment_mismatch";
  return {
    accepted: false,
    cleanup:
      response.status === 410 || rawReason === "Unregistered"
        ? "unregistered"
        : rawReason === "BadDeviceToken"
          ? "suspect"
          : "none",
    configurationFailure,
    ...(typeof errorBody.timestamp === "number"
      ? { invalidationTimestamp: errorBody.timestamp }
      : {}),
    retryable:
      configurationFailure || response.status === 429 || response.status >= 500,
    status: response.status,
    reason,
    ...(requestID ? { requestID } : {}),
    latencyMs: Date.now() - startedAt,
  };
}

export function categorizeReason(status: number, reason?: string): ApnsReason {
  if (reason === "BadDeviceToken") return "bad_device_token";
  if (reason === "Unregistered" || status === 410) return "unregistered";
  if (status === 429 || reason === "TooManyRequests") return "rate_limited";
  if (status >= 500) return "service_unavailable";
  if (reason === "ExpiredProviderToken") return "expired_provider_token";
  if (reason === "BadEnvironmentKeyIdInToken") {
    return "environment_mismatch";
  }
  if (
    reason === "InvalidProviderToken" ||
    reason === "MissingProviderToken" ||
    reason === "UnrelatedKeyIdInToken" ||
    reason === "Forbidden" ||
    status === 403
  ) {
    return "invalid_provider_token";
  }
  if (
    reason === "BadTopic" ||
    reason === "DeviceTokenNotForTopic" ||
    reason === "MissingTopic" ||
    reason === "TopicDisallowed"
  ) {
    return "topic_error";
  }
  if (
    reason === "BadCollapseId" ||
    reason === "BadExpirationDate" ||
    reason === "BadMessageId" ||
    reason === "BadPriority" ||
    reason === "PayloadEmpty" ||
    reason === "PayloadTooLarge"
  ) {
    return "payload_error";
  }
  return "upstream_unknown";
}

async function readReason(
  response: Response,
): Promise<{ reason?: string; timestamp?: number }> {
  try {
    const body = (await response.json()) as {
      reason?: unknown;
      timestamp?: unknown;
    };
    return {
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(typeof body.timestamp === "number" &&
      Number.isFinite(body.timestamp) &&
      body.timestamp >= 0
        ? { timestamp: body.timestamp }
        : {}),
    };
  } catch {
    return {};
  }
}

async function collapseIdentifier(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `apnw-${Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}
