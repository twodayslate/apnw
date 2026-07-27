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
    allowedBundleVersions: ["1"],
  },
  provisioning: { shardCount: 256, shardVersion: 1 },
  templates: {
    changed: { title: "Update", body: "Something changed." },
  },
};

describe("APNs provider", () => {
  beforeEach(() => clearProviderTokenCache());

  it("builds only fixed allowlisted payloads", () => {
    expect(buildPayload(app, "changed")).toEqual({
      aps: {
        alert: { title: "Update", body: "Something changed." },
        sound: "default",
      },
    });
    expect(() => buildPayload(app, "unknown")).toThrow("Not found");
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
      buildPayload(app, "changed"),
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

  it("classifies cleanup without conflating topic errors", async () => {
    const now = Date.now();
    const unregistered = await sendNotification(
      await makeEnv("production"),
      { ...app, bundleID: "com.example.second" },
      "00112233",
      buildPayload(app, "changed"),
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
      buildPayload(app, "changed"),
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
      buildPayload(app, "changed"),
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
