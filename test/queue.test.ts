import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apps } from "../src/apps";
import { capabilityDigest, encodeBase64Url } from "../src/auth";
import type { ChannelObject } from "../src/channel/ChannelObject";
import worker from "../src/index";
import type { DeliveryQueueMessage, Env } from "../src/types";

const appID = "chain_of_custody";
const app = apps[appID];

describe("delivery queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("acknowledges completed batches and emits asynchronous delivery metrics", async () => {
    const fixture = await queuedFixture(21);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    const writeDataPoint = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch(fixture.message);
    const context = createExecutionContext();

    await worker.queue(batch, {
      ...env,
      APNW_ANALYTICS: { writeDataPoint },
    } as Env);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    const deliveryPoint = writeDataPoint.mock.calls
      .map((call) => call[0])
      .find((point) => point.blobs?.[1] === "queue_delivery");
    expect(deliveryPoint?.blobs?.[2]).toBe("delivered");
    expect(deliveryPoint?.doubles?.[3]).toBe(21);
    expect(deliveryPoint?.doubles?.[4]).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "queue_delivery",
        outcome: "delivered",
      }),
    );
  });

  it("retries only transient batches and records their bounded APNs reason", async () => {
    const fixture = await queuedFixture(21);
    vi.stubGlobal("fetch", async () =>
      Response.json({ reason: "ServiceUnavailable" }, { status: 503 }),
    );
    const writeDataPoint = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const batch = queueBatch(fixture.message, 2);
    const context = createExecutionContext();

    await worker.queue(batch, {
      ...env,
      APNW_ANALYTICS: { writeDataPoint },
    } as Env);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([
      expect.objectContaining({ msgId: "message-1" }),
    ]);
    const deliveryPoint = writeDataPoint.mock.calls
      .map((call) => call[0])
      .find((point) => point.blobs?.[1] === "queue_delivery");
    expect(deliveryPoint?.blobs?.[2]).toBe("delivery_retry");
    expect(deliveryPoint?.blobs?.[7]).toBe("service_unavailable");
  });

  it("acks malformed internal messages without resolving a Durable Object", async () => {
    const writeDataPoint = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = createMessageBatch("apnw-dev-delivery", [
      {
        id: "message-1",
        timestamp: new Date(),
        attempts: 1,
        body: { appID: "chain_of_custody", channelID: "not-an-id" },
      },
    ]);
    const context = createExecutionContext();

    await worker.queue(batch as MessageBatch<DeliveryQueueMessage>, {
      ...env,
      APNW_ANALYTICS: { writeDataPoint },
    } as Env);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(["invalid_queue_message"]),
      }),
    );
  });
});

async function queuedFixture(targetCount: number): Promise<{
  message: DeliveryQueueMessage;
  stub: DurableObjectStub<ChannelObject>;
}> {
  const stub = env.CHANNELS.get(
    env.CHANNELS.idFromName(`queue:${crypto.randomUUID()}`),
  );
  await stub.provision("a".repeat(64));
  for (let index = 0; index < targetCount; index += 1) {
    await stub.registerDevice(
      randomSecret(),
      (index + 1).toString(16).padStart(8, "0"),
      await capabilityDigest("installation", appID, randomSecret()),
    );
  }
  const eventID = crypto.randomUUID();
  const publish = await stub.publish({
    app,
    appID,
    clientCreatedAt: Date.now(),
    event: "submission_ready",
    fingerprint: "b".repeat(64),
    idempotencyKey: eventID,
  });
  expect(publish).toMatchObject({ ok: true });
  return {
    message: {
      appID,
      channelID: stub.id.toString(),
      eventID,
      batchID: 0,
    },
    stub,
  };
}

function queueBatch(
  body: DeliveryQueueMessage,
  attempts = 1,
): MessageBatch<DeliveryQueueMessage> {
  return createMessageBatch("apnw-dev-delivery", [
    {
      id: "message-1",
      timestamp: new Date(),
      attempts,
      body,
    },
  ]);
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
