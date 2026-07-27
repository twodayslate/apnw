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
  routeSchemes: ["first"],
  templates: {
    changed: { title: "Update", body: "Something changed." },
  },
};

describe("APNs provider", () => {
  beforeEach(() => clearProviderTokenCache());

  it("builds only allowlisted payloads and routes", () => {
    expect(buildPayload(app, "changed", "first://item/1")).toEqual({
      aps: {
        alert: { title: "Update", body: "Something changed." },
        sound: "default",
      },
      route: "first://item/1",
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
    expect(requests[0]?.headers.get("apns-push-type")).toBe("alert");
  });

  it("uses the production host and categorizes safe APNs errors", async () => {
    let request: Request | undefined;
    const result = await sendNotification(
      await makeEnv("production"),
      { ...app, bundleID: "com.example.second" },
      "00112233",
      buildPayload(app, "changed"),
      "event-2",
      async (input, init) => {
        request = new Request(input, init);
        return Response.json(
          { reason: "Unregistered", timestamp: Date.now() },
          { status: 410 },
        );
      },
    );
    expect(request?.url).toContain("https://api.push.apple.com/");
    expect(request?.headers.get("apns-topic")).toBe("com.example.second");
    expect(result).toMatchObject({
      accepted: false,
      invalidToken: true,
      retryable: false,
      reason: "unregistered",
      status: 410,
    });
    expect(categorizeReason(503, "malicious secret response")).toBe(
      "service_unavailable",
    );
    expect(categorizeReason(400, "malicious secret response")).toBe(
      "upstream_unknown",
    );
  });
});

async function makeEnv(
  environment: "development" | "production",
): Promise<Env> {
  return {
    APNS_ENVIRONMENT: environment,
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
