import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  capabilityDigest,
  deriveChannelName,
  encodeBase64Url,
} from "../src/auth";
import workerHandler from "../src/index";

const worker = exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

describe("APNW HTTP API", () => {
  it("returns a minimal, hardened health response", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      environment: "development",
      version: "local",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=",
    );
  });

  it("fails every HTTP route closed when environments disagree", async () => {
    const mismatchedEnv = {
      ...env,
      APP_ATTEST_ENVIRONMENT: "production" as const,
    };
    const health = await workerHandler.fetch(
      new Request("https://apnw.test/health"),
      mismatchedEnv,
    );
    const challenge = await workerHandler.fetch(
      new Request(
        "https://apnw.test/v1/apps/chain_of_custody/app-attest/challenge",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            purpose: "attest_key",
            keyID: randomSecret(),
          }),
        },
      ),
      mismatchedEnv,
    );
    expect(health.status).toBe(503);
    expect(challenge.status).toBe(503);
    expect(await challenge.json()).toEqual({
      error: {
        code: "misconfigured",
        message: "Service unavailable",
      },
    });
  });

  it("fails production closed without an immutable service version", async () => {
    const unversionedProductionEnv = {
      ...env,
      APNS_ENVIRONMENT: "production" as const,
      APNS_KEY_ENVIRONMENT: "production" as const,
      APP_ATTEST_ENVIRONMENT: "production" as const,
      SERVICE_VERSION: "unset",
    };
    const response = await workerHandler.fetch(
      new Request("https://apnw.test/health"),
      unversionedProductionEnv,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "misconfigured",
        message: "Service unavailable",
      },
    });
  });

  it("keeps unknown apps, bad capabilities, and unprovisioned channels opaque", async () => {
    const capability = randomSecret();
    const installation = randomSecret();
    const unknown = await call("/v1/apps/not_registered/device", {
      method: "DELETE",
      capability,
      installationCapability: installation,
      json: { installationID: randomSecret() },
    });
    const unauthenticated = await call(
      "/v1/apps/chain_of_custody/device",
      {
        method: "DELETE",
        installationCapability: installation,
        json: { installationID: randomSecret() },
      },
    );
    const unprovisioned = await call(
      "/v1/apps/chain_of_custody/device",
      {
        method: "PUT",
        capability,
        installationCapability: installation,
        json: {
          installationID: randomSecret(),
          deviceToken: "aabbccdd",
        },
      },
    );
    expect(unknown.status).toBe(404);
    expect(unauthenticated.status).toBe(404);
    expect(unprovisioned.status).toBe(404);
    const opaqueBody = await unauthenticated.json();
    expect(await unknown.json()).toEqual(opaqueBody);
    expect(await unprovisioned.json()).toEqual(opaqueBody);
  });

  it("does not initialize persistent state for an unprovisioned capability", async () => {
    const capability = randomSecret();
    const name = await deriveChannelName("chain_of_custody", capability);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(name));
    const response = await call("/v1/apps/chain_of_custody/device", {
      method: "PUT",
      capability,
      installationCapability: randomSecret(),
      json: {
        installationID: randomSecret(),
        deviceToken: "aabbccdd",
      },
    });
    const tables = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE '_cf_%'`,
          )
          .toArray()
          .map((row) => row.name),
    );
    expect(response.status).toBe(404);
    expect(tables).toEqual([]);
  });

  it("requires the installation capability for device churn", async () => {
    const channelCapability = randomSecret();
    const adminCapability = randomSecret();
    const installationCapability = randomSecret();
    const wrongInstallationCapability = randomSecret();
    const installationID = randomSecret();
    await provision(channelCapability, adminCapability);

    const first = await call("/v1/apps/chain_of_custody/device", {
      method: "PUT",
      capability: channelCapability,
      installationCapability,
      json: { installationID, deviceToken: "aabbccdd" },
    });
    const unauthorizedUpdate = await call(
      "/v1/apps/chain_of_custody/device",
      {
        method: "PUT",
        capability: channelCapability,
        installationCapability: wrongInstallationCapability,
        json: { installationID, deviceToken: "00112233" },
      },
    );
    const updated = await call("/v1/apps/chain_of_custody/device", {
      method: "PUT",
      capability: channelCapability,
      installationCapability,
      json: { installationID, deviceToken: "00112233" },
    });
    const unauthorizedRemoval = await call(
      "/v1/apps/chain_of_custody/device",
      {
        method: "DELETE",
        capability: channelCapability,
        installationCapability: wrongInstallationCapability,
        json: { installationID },
      },
    );
    const removed = await call("/v1/apps/chain_of_custody/device", {
      method: "DELETE",
      capability: channelCapability,
      installationCapability,
      json: { installationID },
    });
    expect(first.status).toBe(201);
    expect(unauthorizedUpdate.status).toBe(404);
    expect(updated.status).toBe(200);
    expect(unauthorizedRemoval.status).toBe(404);
    expect(removed.status).toBe(200);
  });

  it("rejects unknown and duplicate JSON fields plus oversized bodies", async () => {
    const channelCapability = randomSecret();
    const adminCapability = randomSecret();
    const installationCapability = randomSecret();
    await provision(channelCapability, adminCapability);
    const headers = {
      authorization: `Bearer ${channelCapability}`,
      "x-installation-authorization": `Bearer ${installationCapability}`,
      "content-type": "application/json",
    };
    const unknown = await worker.default.fetch(
      new Request("https://apnw.test/v1/apps/chain_of_custody/device", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          installationID: randomSecret(),
          deviceToken: "aa",
          title: "not allowed",
        }),
      }),
    );
    const duplicate = await worker.default.fetch(
      new Request("https://apnw.test/v1/apps/chain_of_custody/device", {
        method: "PUT",
        headers,
        body: `{"installationID":"${randomSecret()}","deviceToken":"aa","device\\u0054oken":"bb"}`,
      }),
    );
    const oversized = await worker.default.fetch(
      new Request("https://apnw.test/v1/apps/chain_of_custody/device", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          installationID: randomSecret(),
          deviceToken: "aa",
          padding: "x".repeat(9_000),
        }),
      }),
    );
    expect(unknown.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("binds exclusions to the sender installation capability", async () => {
    const channelCapability = randomSecret();
    const adminCapability = randomSecret();
    const installationCapability = randomSecret();
    const installationID = randomSecret();
    await provision(channelCapability, adminCapability);
    await call("/v1/apps/chain_of_custody/device", {
      method: "PUT",
      capability: channelCapability,
      installationCapability,
      json: { installationID, deviceToken: "deadbeef" },
    });
    const idempotencyKey = crypto.randomUUID();
    const eventCreatedAt = new Date().toISOString();
    const wrong = await publish(channelCapability, {
      idempotencyKey,
      eventCreatedAt,
      installationCapability: randomSecret(),
      json: {
        event: "submission_ready",
        excludeInstallationID: installationID,
      },
    });
    const first = await publish(channelCapability, {
      idempotencyKey,
      eventCreatedAt,
      installationCapability,
      json: {
        event: "submission_ready",
        excludeInstallationID: installationID,
      },
    });
    const repeat = await publish(channelCapability, {
      idempotencyKey,
      eventCreatedAt,
      installationCapability,
      json: {
        event: "submission_ready",
        excludeInstallationID: installationID,
      },
    });
    expect(wrong.status).toBe(404);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      eventID: idempotencyKey,
      deliveryMode: "direct",
      state: "completed",
    });
    expect(await repeat.json()).toEqual({
      eventID: idempotencyKey,
      deliveryMode: "direct",
      state: "completed",
    });
  });

  it("requires UUIDv4 idempotency and a recent client timestamp", async () => {
    const channelCapability = randomSecret();
    await provision(channelCapability, randomSecret());
    const invalidKey = await call("/v1/apps/chain_of_custody/events", {
      method: "POST",
      capability: channelCapability,
      headers: {
        "idempotency-key": "not-a-uuid",
        "event-created-at": new Date().toISOString(),
      },
      json: { event: "check_requested" },
    });
    const stale = await call("/v1/apps/chain_of_custody/events", {
      method: "POST",
      capability: channelCapability,
      headers: {
        "idempotency-key": crypto.randomUUID(),
        "event-created-at": new Date(Date.now() - 73 * 60 * 60 * 1_000).toISOString(),
      },
      json: { event: "check_requested" },
    });
    const impossibleDate = await call(
      "/v1/apps/chain_of_custody/events",
      {
        method: "POST",
        capability: channelCapability,
        headers: {
          "idempotency-key": crypto.randomUUID(),
          "event-created-at": `${new Date().getUTCFullYear()}-02-30T12:00:00Z`,
        },
        json: { event: "check_requested" },
      },
    );
    expect(invalidKey.status).toBe(400);
    expect(stale.status).toBe(400);
    expect(impossibleDate.status).toBe(400);
  });

  it("keeps responses count-free and rejects idempotency reuse with different content", async () => {
    const channelCapability = randomSecret();
    await provision(channelCapability, randomSecret());
    const idempotencyKey = crypto.randomUUID();
    const first = await publish(channelCapability, {
      idempotencyKey,
      json: { event: "check_requested" },
    });
    const conflict = await publish(channelCapability, {
      idempotencyKey,
      json: { event: "decision_available" },
    });
    const body = (await first.json()) as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "deliveryMode",
      "eventID",
      "state",
    ]);
    expect(conflict.status).toBe(409);
  });

  it("records the private target snapshot without exposing counts in the response", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const channelCapability = randomSecret();
    const installationCapability = randomSecret();
    await provision(channelCapability, randomSecret());
    await call("/v1/apps/chain_of_custody/device", {
      method: "PUT",
      capability: channelCapability,
      installationCapability,
      json: {
        installationID: randomSecret(),
        deviceToken: "1234abcd",
      },
    });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    const writeDataPoint = vi.fn();
    const idempotencyKey = crypto.randomUUID();
    const eventCreatedAt = new Date().toISOString();
    const request = (): Request =>
      new Request("https://apnw.test/v1/apps/chain_of_custody/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${channelCapability}`,
          "content-type": "application/json",
          "event-created-at": eventCreatedAt,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ event: "check_requested" }),
      });
    const telemetryEnv = {
      ...env,
      APNW_ANALYTICS: { writeDataPoint },
    };
    const response = await workerHandler.fetch(request(), telemetryEnv);
    const duplicate = await workerHandler.fetch(request(), telemetryEnv);

    expect(response.status).toBe(200);
    expect(Object.keys((await response.json()) as object).sort()).toEqual([
      "deliveryMode",
      "eventID",
      "state",
    ]);
    expect(duplicate.status).toBe(200);
    const publishPoints = writeDataPoint.mock.calls
      .map((call) => call[0])
      .filter((point) => point.blobs?.[1] === "publish");
    expect(publishPoints[0]?.doubles?.[2]).toBe(1);
    expect(publishPoints[0]?.doubles?.[3]).toBe(1);
    expect(publishPoints[1]?.blobs?.[8]).toBe("duplicate");
    expect(publishPoints[1]?.doubles?.[2]).toBe(0);
    log.mockRestore();
    vi.unstubAllGlobals();
  });

  it("requires the independent admin capability to close a channel", async () => {
    const channelCapability = randomSecret();
    const adminCapability = randomSecret();
    await provision(channelCapability, adminCapability);
    const wrong = await call("/v1/apps/chain_of_custody/channel", {
      method: "DELETE",
      capability: channelCapability,
      adminCapability: randomSecret(),
    });
    const closed = await call("/v1/apps/chain_of_custody/channel", {
      method: "DELETE",
      capability: channelCapability,
      adminCapability,
    });
    const rejected = await publish(channelCapability, {
      idempotencyKey: crypto.randomUUID(),
      json: { event: "check_requested" },
    });
    expect(wrong.status).toBe(404);
    expect(closed.status).toBe(200);
    expect(rejected.status).toBe(404);
  });

  it("emits one reviewed completion log without request secrets", async () => {
    const channelCapability = randomSecret();
    const adminCapability = randomSecret();
    const installationCapability = randomSecret();
    const installationID = randomSecret();
    await provision(channelCapability, adminCapability);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await call("/v1/apps/chain_of_custody/device", {
      method: "PUT",
      capability: channelCapability,
      installationCapability,
      json: { installationID, deviceToken: "feedface" },
    });
    expect(response.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(spy.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(channelCapability);
    expect(serialized).not.toContain(installationCapability);
    expect(serialized).not.toContain("feedface");
    expect(serialized).not.toContain(installationID);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      operation: "register",
      appID: "chain_of_custody",
    });
    spy.mockRestore();
  });
});

async function provision(
  channelCapability: string,
  adminCapability: string,
): Promise<void> {
  const name = await deriveChannelName(
    "chain_of_custody",
    channelCapability,
  );
  const digest = await capabilityDigest(
    "admin",
    "chain_of_custody",
    adminCapability,
  );
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(name));
  const result = await stub.provision(digest);
  expect(result.ok).toBe(true);
}

function publish(
  capability: string,
  options: {
    idempotencyKey: string;
    eventCreatedAt?: string;
    installationCapability?: string;
    json: object;
  },
): Promise<Response> {
  return call("/v1/apps/chain_of_custody/events", {
    method: "POST",
    capability,
    installationCapability: options.installationCapability,
    headers: {
      "idempotency-key": options.idempotencyKey,
      "event-created-at": options.eventCreatedAt ?? new Date().toISOString(),
    },
    json: options.json,
  });
}

async function call(
  path: string,
  options: {
    method?: string;
    capability?: string;
    adminCapability?: string;
    installationCapability?: string;
    json?: object;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.capability) {
    headers.set("authorization", `Bearer ${options.capability}`);
  }
  if (options.adminCapability) {
    headers.set(
      "x-channel-admin-authorization",
      `Bearer ${options.adminCapability}`,
    );
  }
  if (options.installationCapability) {
    headers.set(
      "x-installation-authorization",
      `Bearer ${options.installationCapability}`,
    );
  }
  if (options.json) headers.set("content-type", "application/json");
  return worker.default.fetch(
    new Request(`https://apnw.test${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.json ? JSON.stringify(options.json) : undefined,
    }),
  );
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
