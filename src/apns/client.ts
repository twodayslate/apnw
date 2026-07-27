import type { AppConfig } from "../apps";
import type { Env } from "../types";
import type { ApnsPayload } from "./payload";
import { getProviderToken } from "./jwt";

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
  | "upstream_unknown";

export interface ApnsResult {
  accepted: boolean;
  invalidToken: boolean;
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
  let response: Response;
  try {
    const providerToken = await getProviderToken(
      env.APNS_TEAM_ID,
      env.APNS_KEY_ID,
      env.APNS_KEY_P8,
    );
    const host =
      env.APNS_ENVIRONMENT === "production"
        ? "api.push.apple.com"
        : "api.sandbox.push.apple.com";
    const collapseID = await collapseIdentifier(idempotencyKey);
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
      invalidToken: false,
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
      invalidToken: false,
      retryable: false,
      status: response.status,
      reason: "none",
      ...(requestID ? { requestID } : {}),
      latencyMs: Date.now() - startedAt,
    };
  }

  const rawReason = await readReason(response);
  return {
    accepted: false,
    invalidToken:
      response.status === 410 ||
      rawReason === "BadDeviceToken" ||
      rawReason === "Unregistered",
    retryable: response.status === 429 || response.status >= 500,
    status: response.status,
    reason: categorizeReason(response.status, rawReason),
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
  if (reason === "InvalidProviderToken") return "invalid_provider_token";
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

async function readReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : undefined;
  } catch {
    return undefined;
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
