import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { apps } from "../src/apps";
import {
  capabilityDigest,
  deriveChannelName,
  encodeBase64Url,
} from "../src/auth";

const appID = "chain_of_custody";
const app = apps[appID];

describe("channel delivery state", () => {
  it("has no device-count ceiling and partitions large snapshots into queue batches", async () => {
    const stub = await provisionedChannel();
    const registrations = await Promise.all(
      Array.from({ length: 205 }, async (_, index) =>
        stub.registerDevice(
          randomSecret(),
          index.toString(16).padStart(8, "0"),
          await capabilityDigest(
            "installation",
            appID,
            randomSecret(),
          ),
        ),
      ),
    );
    expect(registrations.every((result) => result.ok)).toBe(true);
    const result = await stub.publish({
      app,
      appID,
      clientCreatedAt: Date.now(),
      event: "check_requested",
      fingerprint: randomHex(),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("queued");
    expect(result.pendingBatchIDs).toEqual([0, 1, 2]);
  });

  it("deletes a 410 token only when the invalidation timestamp covers the same version", async () => {
    const stub = await provisionedChannel();
    const installationID = randomSecret();
    const installationCapability = randomSecret();
    const installationDigest = await capabilityDigest(
      "installation",
      appID,
      installationCapability,
    );
    await stub.registerDevice(
      installationID,
      "aabbccdd",
      installationDigest,
    );
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          reason: "Unregistered",
          timestamp: Date.now() + 1_000,
        },
        { status: 410 },
      ),
    );
    const eventID = crypto.randomUUID();
    const publish = await stub.publish({
      app,
      appID,
      clientCreatedAt: Date.now(),
      event: "submission_ready",
      fingerprint: randomHex(),
      idempotencyKey: eventID,
    });
    expect(publish.ok).toBe(true);
    const delivery = await stub.deliverBatch(eventID, 0, app);
    expect(delivery.invalidRemoved).toBe(1);
    const removal = await stub.unregisterDevice(
      installationID,
      installationDigest,
    );
    expect(removal).toMatchObject({ ok: true, removed: false });
    vi.unstubAllGlobals();
  });

  it("never lets a stale delivery snapshot remove a re-registered token", async () => {
    const stub = await provisionedChannel();
    const installationID = randomSecret();
    const installationDigest = await capabilityDigest(
      "installation",
      appID,
      randomSecret(),
    );
    await stub.registerDevice(
      installationID,
      "11111111",
      installationDigest,
    );
    const eventID = crypto.randomUUID();
    await stub.publish({
      app,
      appID,
      clientCreatedAt: Date.now(),
      event: "submission_ready",
      fingerprint: randomHex(),
      idempotencyKey: eventID,
    });
    await stub.registerDevice(
      installationID,
      "22222222",
      installationDigest,
    );
    let sent = false;
    vi.stubGlobal("fetch", async () => {
      sent = true;
      return new Response(null, { status: 200 });
    });
    await stub.deliverBatch(eventID, 0, app);
    expect(sent).toBe(false);
    const removal = await stub.unregisterDevice(
      installationID,
      installationDigest,
    );
    expect(removal).toMatchObject({ ok: true, removed: true });
    vi.unstubAllGlobals();
  });

  it("quarantines one BadDeviceToken response and deletes only on repetition", async () => {
    const stub = await provisionedChannel();
    const installationID = randomSecret();
    const installationDigest = await capabilityDigest(
      "installation",
      appID,
      randomSecret(),
    );
    await stub.registerDevice(
      installationID,
      "33333333",
      installationDigest,
    );
    vi.stubGlobal("fetch", async () =>
      Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
    );
    for (const event of ["check_requested", "decision_available"] as const) {
      const eventID = crypto.randomUUID();
      await stub.publish({
        app,
        appID,
        clientCreatedAt: Date.now(),
        event,
        fingerprint: randomHex(),
        idempotencyKey: eventID,
      });
      await stub.deliverBatch(eventID, 0, app);
    }
    const removal = await stub.unregisterDevice(
      installationID,
      installationDigest,
    );
    expect(removal).toMatchObject({ ok: true, removed: false });
    vi.unstubAllGlobals();
  });

  it("suspends cleanup before a burst of 410 responses can erase the channel", async () => {
    const stub = await provisionedChannel();
    const installations = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const installationID = randomSecret();
        const installationDigest = await capabilityDigest(
          "installation",
          appID,
          randomSecret(),
        );
        await stub.registerDevice(
          installationID,
          (index + 1).toString(16).padStart(8, "0"),
          installationDigest,
        );
        return { installationID, installationDigest };
      }),
    );
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { reason: "Unregistered", timestamp: Date.now() + 1_000 },
        { status: 410 },
      ),
    );
    const eventID = crypto.randomUUID();
    await stub.publish({
      app,
      appID,
      clientCreatedAt: Date.now(),
      event: "submission_ready",
      fingerprint: randomHex(),
      idempotencyKey: eventID,
    });
    const delivery = await stub.deliverBatch(eventID, 0, app);
    expect(delivery.invalidRemoved).toBeGreaterThan(0);
    expect(delivery.invalidRemoved).toBeLessThan(10);
    const remaining = await Promise.all(
      installations.map(({ installationID, installationDigest }) =>
        stub.unregisterDevice(installationID, installationDigest),
      ),
    );
    expect(
      remaining.filter((result) => result.ok && result.removed).length,
    ).toBe(12 - delivery.invalidRemoved);
    vi.unstubAllGlobals();
  });
});

async function provisionedChannel() {
  const channelCapability = randomSecret();
  const name = await deriveChannelName(appID, channelCapability);
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(name));
  const adminDigest = await capabilityDigest("admin", appID, randomSecret());
  const result = await stub.provision(adminDigest);
  expect(result.ok).toBe(true);
  return stub;
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomHex(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
