import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

const capabilityA =
  "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY";
const capabilityB =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const capabilityC =
  "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY";
const capabilityD =
  "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg";
const installationID = "f85f665c-79d1-4eea-b87c-65f8476e5a88";
const worker = exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

describe("APNW HTTP API", () => {
  it("returns a minimal health response", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      environment: "development",
      version: "local",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps unknown apps and bad capabilities opaque", async () => {
    const unknown = await call(
      "/v1/apps/not_registered/devices/f85f665c-79d1-4eea-b87c-65f8476e5a88",
      { method: "DELETE", capability: capabilityA },
    );
    const unauthenticated = await call(
      `/v1/apps/chain_of_custody/devices/${installationID}`,
      { method: "DELETE" },
    );
    expect(unknown.status).toBe(404);
    expect(unauthenticated.status).toBe(404);
    expect(await unknown.json()).toEqual(await unauthenticated.json());
  });

  it("registers, updates, and idempotently unregisters a device", async () => {
    const path = `/v1/apps/chain_of_custody/devices/${installationID}`;
    const first = await call(path, {
      method: "PUT",
      capability: capabilityA,
      json: { deviceToken: "aabbccdd" },
    });
    const repeat = await call(path, {
      method: "PUT",
      capability: capabilityA,
      json: { deviceToken: "00112233" },
    });
    const removed = await call(path, {
      method: "DELETE",
      capability: capabilityA,
    });
    const removedAgain = await call(path, {
      method: "DELETE",
      capability: capabilityA,
    });
    expect(first.status).toBe(201);
    expect(repeat.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(removedAgain.status).toBe(200);
  });

  it("rejects unknown fields before accessing channel state", async () => {
    const response = await call(
      `/v1/apps/chain_of_custody/devices/${installationID}`,
      {
        method: "PUT",
        capability: capabilityB,
        json: { deviceToken: "aabbccdd", title: "not allowed" },
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("rejects oversized bodies and lookalike JSON media types", async () => {
    const path = `/v1/apps/chain_of_custody/devices/${installationID}`;
    const oversized = await worker.default.fetch(
      new Request(`https://apnw.test${path}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${capabilityC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceToken: "aa", padding: "x".repeat(9_000) }),
      }),
    );
    const lookalike = await worker.default.fetch(
      new Request(`https://apnw.test${path}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${capabilityC}`,
          "content-type": "application/json-patch+json",
        },
        body: JSON.stringify({ deviceToken: "aa" }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(lookalike.status).toBe(415);
  });

  it("excludes the sender and returns a stored result on repeat", async () => {
    const devicePath = `/v1/apps/chain_of_custody/devices/${installationID}`;
    await call(devicePath, {
      method: "PUT",
      capability: capabilityB,
      json: { deviceToken: "deadbeef" },
    });
    const request = {
      method: "POST",
      capability: capabilityB,
      headers: { "idempotency-key": "event-sender-excluded" },
      json: {
        event: "submission_ready",
        excludeInstallationID: installationID,
        route: "coc://submission/example",
      },
    } as const;
    const first = await call("/v1/apps/chain_of_custody/events", request);
    const repeat = await call("/v1/apps/chain_of_custody/events", request);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      deviceCount: 0,
      accepted: 0,
      failed: 0,
      retryable: false,
    });
    expect(await repeat.json()).toEqual({
      eventID: "event-sender-excluded",
      deviceCount: 0,
      accepted: 0,
      failed: 0,
      retryable: false,
    });
  });

  it("isolates channels and keeps a closed channel tombstoned", async () => {
    const path = `/v1/apps/chain_of_custody/devices/${installationID}`;
    await call(path, {
      method: "PUT",
      capability: capabilityA,
      json: { deviceToken: "cafebabe" },
    });
    const otherChannelPublish = await call(
      "/v1/apps/chain_of_custody/events",
      {
        method: "POST",
        capability: capabilityC,
        headers: { "idempotency-key": "other-channel-event" },
        json: { event: "check_requested" },
      },
    );
    expect(await otherChannelPublish.json()).toMatchObject({ deviceCount: 0 });

    const closed = await call("/v1/apps/chain_of_custody/channel", {
      method: "DELETE",
      capability: capabilityA,
    });
    const rejected = await call(path, {
      method: "PUT",
      capability: capabilityA,
      json: { deviceToken: "cafebabe" },
    });
    expect(closed.status).toBe(200);
    expect(rejected.status).toBe(404);
  });

  it("retries only transient APNs targets", async () => {
    const firstInstallation = "5111eab4-a2c1-4df0-ab48-59b727dd6591";
    const secondInstallation = "bbbd4091-7f4c-4501-8862-8c9bd748c11b";
    await call(
      `/v1/apps/chain_of_custody/devices/${firstInstallation}`,
      {
        method: "PUT",
        capability: capabilityD,
        json: { deviceToken: "aaaaaaaa" },
      },
    );
    await call(
      `/v1/apps/chain_of_custody/devices/${secondInstallation}`,
      {
        method: "PUT",
        capability: capabilityD,
        json: { deviceToken: "bbbbbbbb" },
      },
    );

    const attempts = new Map<string, number>();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      const token = url.split("/").at(-1) ?? "";
      attempts.set(token, (attempts.get(token) ?? 0) + 1);
      if (token === "bbbbbbbb" && attempts.get(token) === 1) {
        return Response.json(
          { reason: "ServiceUnavailable" },
          { status: 503 },
        );
      }
      return new Response(null, { status: 200 });
    });

    const options = {
      method: "POST",
      capability: capabilityD,
      headers: { "idempotency-key": "partial-retry-event" },
      json: { event: "decision_available" },
    } as const;
    const first = await call("/v1/apps/chain_of_custody/events", options);
    const retry = await call("/v1/apps/chain_of_custody/events", options);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      deviceCount: 2,
      accepted: 1,
      retryable: true,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      deviceCount: 2,
      accepted: 2,
      retryable: false,
    });
    expect(attempts.get("aaaaaaaa")).toBe(1);
    expect(attempts.get("bbbbbbbb")).toBe(2);
    vi.unstubAllGlobals();
  });

  it("emits one reviewed completion log without request secrets", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const secretToken = "feedface";
    const response = await call(
      `/v1/apps/chain_of_custody/devices/${installationID}`,
      {
        method: "PUT",
        capability: capabilityA,
        json: { deviceToken: secretToken },
      },
    );
    expect(response.status).toBeLessThan(500);
    expect(spy).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(spy.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(capabilityA);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain(installationID);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      schema: 1,
      operation: "register",
      appID: "chain_of_custody",
    });
    spy.mockRestore();
  });

  it("does not expose state-listing or history routes", async () => {
    for (const path of [
      "/v1/apps/chain_of_custody/devices",
      "/v1/apps/chain_of_custody/events/history",
      "/v1/apps/chain_of_custody/stats",
    ]) {
      expect((await call(path, { capability: capabilityA })).status).toBe(404);
    }
  });
});

async function call(
  path: string,
  options: {
    method?: string;
    capability?: string;
    json?: object;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.capability) {
    headers.set("authorization", `Bearer ${options.capability}`);
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
