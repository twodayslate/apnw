import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/apps";
import {
  categorizeReason,
  sendNotification,
  type Fetcher,
} from "../src/apns/client";
import {
  clearProviderTokenCache,
  getProviderToken,
} from "../src/apns/jwt";
import { buildPayload } from "../src/apns/payload";
import type { Env } from "../src/types";

const app: AppConfig = {
  bundleID: "com.example.first",
  appAttest: {
    extensionPolicy: "if-present",
    maxFraudRiskMetric: 10,
    allowedValidationCategories: {
      development: [3],
      production: [2, 4],
    },
  },
  provisioning: { shardCount: 256, shardVersion: 1 },
  notificationFallback: {
    title: "Update",
    body: "Something changed.",
  },
};

describe("APNs provider", () => {
  beforeEach(() => clearProviderTokenCache());

  it("builds a generic fallback plus versioned application data", () => {
    expect(
      buildPayload(app, "check.response", {
        event_id: "event-123",
        media: { kind: "image" },
      }),
    ).toEqual({
      aps: {
        alert: { title: "Update", body: "Something changed." },
        sound: "default",
        "mutable-content": 1,
      },
      apnw: {
        version: 1,
        event: "check.response",
        data: {
          event_id: "event-123",
          media: { kind: "image" },
        },
      },
    });
  });

  it("rejects application data that would exceed the APNs payload limit", () => {
    expect(() =>
      buildPayload(app, "check.response", { value: "x".repeat(4_096) }),
    ).toThrow("Notification payload too large");
  });

  it("creates a valid ES256 token and reuses it within the cache window", async () => {
    const encodedP8 = await makeEncodedP8();
    const token = await getProviderToken(
      "TEAM123456",
      "KEY1234567",
      encodedP8,
      1_700_000_000,
    );
    const cached = await getProviderToken(
      "TEAM123456",
      "KEY1234567",
      encodedP8,
      1_700_000_100,
    );
    const refreshed = await getProviderToken(
      "TEAM123456",
      "KEY1234567",
      encodedP8,
      1_700_003_000,
    );
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(decodeSegment(header ?? ""))).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(decodeSegment(claims ?? ""))).toEqual({
      iss: "TEAM123456",
      iat: 1_700_000_000,
    });
    expect(decodeBase64Url(signature ?? "")).toHaveLength(64);
    expect(cached).toBe(token);
    expect(refreshed).not.toBe(token);
    expect(
      JSON.parse(decodeSegment(refreshed.split(".")[1] ?? "")),
    ).toMatchObject({ iat: 1_700_003_000 });
  });

  it("uses the sandbox host and per-app topic", async () => {
    const requests: Request[] = [];
    const fetcher: Fetcher = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "test-apns-id" },
      });
    };
    const result = await sendNotification(
      await makeEnv("development"),
      app,
      "aabbccdd",
      buildPayload(app, "changed", {}),
      "event-1",
      fetcher,
    );
    expect(result.accepted).toBe(true);
    expect(requests[0]?.url).toBe(
      "https://api.sandbox.push.apple.com/3/device/aabbccdd",
    );
    expect(requests[0]?.headers.get("apns-topic")).toBe(
      "com.example.first",
    );
  });

  it("uses the production host and the selected app's distinct topic", async () => {
    const requests: Request[] = [];
    const secondApp = { ...app, bundleID: "com.example.second" };
    const result = await sendNotification(
      await makeEnv("production"),
      secondApp,
      "00112233",
      buildPayload(secondApp, "changed", {}),
      "event-production",
      async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 200 });
      },
    );

    expect(result.accepted).toBe(true);
    expect(requests[0]?.url).toBe(
      "https://api.push.apple.com/3/device/00112233",
    );
    expect(requests[0]?.headers.get("apns-topic")).toBe(
      "com.example.second",
    );
  });

  it("marks APNs throttling and server failures as retryable", async () => {
    const throttled = await sendNotification(
      await makeEnv("development"),
      app,
      "00112233",
      buildPayload(app, "changed", {}),
      "event-throttled",
      async () =>
        Response.json({ reason: "TooManyRequests" }, { status: 429 }),
    );
    const unavailable = await sendNotification(
      await makeEnv("development"),
      app,
      "00112233",
      buildPayload(app, "changed", {}),
      "event-unavailable",
      async () => new Response(null, { status: 503 }),
    );

    expect(throttled).toMatchObject({
      reason: "rate_limited",
      retryable: true,
    });
    expect(unavailable).toMatchObject({
      reason: "service_unavailable",
      retryable: true,
    });
  });

  it("refreshes an expired provider token and retries once", async () => {
    let requestCount = 0;
    const result = await sendNotification(
      await makeEnv("development"),
      app,
      "00112233",
      buildPayload(app, "changed", {}),
      "event-expired-token",
      async () => {
        requestCount += 1;
        return requestCount === 1
          ? Response.json(
              { reason: "ExpiredProviderToken" },
              { status: 403 },
            )
          : new Response(null, { status: 200 });
      },
    );

    expect(requestCount).toBe(2);
    expect(result).toMatchObject({
      accepted: true,
      retryable: false,
    });
  });

  it("defers provider configuration failures instead of losing targets", async () => {
    const result = await sendNotification(
      await makeEnv("production"),
      app,
      "00112233",
      buildPayload(app, "changed", {}),
      "event-provider-failure",
      async () =>
        Response.json(
          { reason: "InvalidProviderToken" },
          { status: 403 },
        ),
    );

    expect(result).toMatchObject({
      accepted: false,
      configurationFailure: true,
      reason: "invalid_provider_token",
      retryable: true,
    });
  });

  it("classifies cleanup without conflating topic errors", async () => {
    const now = Date.now();
    const unregistered = await sendNotification(
      await makeEnv("production"),
      { ...app, bundleID: "com.example.second" },
      "00112233",
      buildPayload(app, "changed", {}),
      "event-2",
      async () =>
        Response.json(
          { reason: "Unregistered", timestamp: now },
          { status: 410 },
        ),
    );
    const wrongTopic = await sendNotification(
      await makeEnv("production"),
      app,
      "00112233",
      buildPayload(app, "changed", {}),
      "event-3",
      async () =>
        Response.json(
          { reason: "DeviceTokenNotForTopic" },
          { status: 400 },
        ),
    );
    expect(unregistered).toMatchObject({
      accepted: false,
      cleanup: "unregistered",
      invalidationTimestamp: now,
      reason: "unregistered",
      status: 410,
    });
    expect(wrongTopic).toMatchObject({
      cleanup: "none",
      configurationFailure: true,
      reason: "topic_error",
    });
    expect(categorizeReason(503, "attacker-controlled")).toBe(
      "service_unavailable",
    );
    expect(categorizeReason(400, "attacker-controlled")).toBe(
      "upstream_unknown",
    );
    expect(categorizeReason(403, "BadEnvironmentKeyIdInToken")).toBe(
      "environment_mismatch",
    );
    expect(categorizeReason(403, "MissingProviderToken")).toBe(
      "invalid_provider_token",
    );
  });

  it("fails closed before a request when key and endpoint environments differ", async () => {
    const env = await makeEnv("production");
    env.APNS_KEY_ENVIRONMENT = "development";
    let called = false;
    const result = await sendNotification(
      env,
      app,
      "00112233",
      buildPayload(app, "changed", {}),
      "event-4",
      async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
    );
    expect(called).toBe(false);
    expect(result).toMatchObject({
      configurationFailure: true,
      reason: "environment_mismatch",
    });
  });
});

async function makeEnv(
  environment: "development" | "production",
): Promise<Env> {
  return {
    APNS_ENVIRONMENT: environment,
    APNS_KEY_ENVIRONMENT: environment,
    APP_ATTEST_ENVIRONMENT: environment,
    SERVICE_VERSION: "test",
    APNS_KEY_P8: await makeEncodedP8(),
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
  } as Env;
}

async function makeEncodedP8(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const bytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const der = btoa(binary);
  const pem = `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`;
  return btoa(pem);
}

function decodeSegment(value: string): string {
  return new TextDecoder().decode(decodeBase64Url(value));
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    (character) => character.charCodeAt(0),
  );
}
