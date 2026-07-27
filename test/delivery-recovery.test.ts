import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apps } from "../src/apps";
import { capabilityDigest, encodeBase64Url } from "../src/auth";
import {
  DELIVERY_PROCESSING_LEASE_MS,
  type ChannelObject,
} from "../src/channel/ChannelObject";
import type { DeliveryQueueMessage } from "../src/types";

const appID = "chain_of_custody";
const app = apps[appID];

describe("delivery crash recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("re-enqueues an expired processing lease and never resends an ambiguous target", async () => {
    const fixture = await queuedFixture();
    await setBatchProcessing(
      fixture.stub,
      fixture.message.eventID,
      Date.now() - DELIVERY_PROCESSING_LEASE_MS - 1_000,
    );

    await runInDurableObject(fixture.stub, (instance) => instance.alarm?.());
    expect(await batchState(fixture.stub, fixture.message.eventID)).toBe(
      "enqueued",
    );

    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const delivery = await fixture.stub.deliverBatch(
      fixture.message.eventID,
      0,
      app,
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      failed: 1,
      retryable: false,
    });
    expect(await batchState(fixture.stub, fixture.message.eventID)).toBe(
      "completed",
    );
  });

  it("does not steal a live processing lease", async () => {
    const fixture = await queuedFixture();
    await setBatchProcessing(fixture.stub, fixture.message.eventID, Date.now());

    await runInDurableObject(fixture.stub, (instance) => instance.alarm?.());

    expect(await batchState(fixture.stub, fixture.message.eventID)).toBe(
      "processing",
    );
  });
});

async function queuedFixture(): Promise<{
  message: DeliveryQueueMessage;
  stub: DurableObjectStub<ChannelObject>;
}> {
  const stub = env.CHANNELS.get(
    env.CHANNELS.idFromName(`recovery:${crypto.randomUUID()}`),
  );
  await stub.provision("a".repeat(64));
  await stub.registerDevice(
    randomSecret(),
    "00000001",
    await capabilityDigest("installation", appID, randomSecret()),
  );
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

async function setBatchProcessing(
  stub: DurableObjectStub<ChannelObject>,
  eventID: string,
  updatedAt: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE delivery_batches SET state = 'processing', updated_at = ?
       WHERE idempotency_key = ? AND batch_id = 0`,
      updatedAt,
      eventID,
    );
    state.storage.sql.exec(
      `UPDATE event_deliveries SET status = 'attempting', updated_at = ?
       WHERE idempotency_key = ? AND batch_id = 0`,
      updatedAt,
      eventID,
    );
  });
}

function batchState(
  stub: DurableObjectStub<ChannelObject>,
  eventID: string,
): Promise<string | undefined> {
  return runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ state: string }>(
          `SELECT state FROM delivery_batches
           WHERE idempotency_key = ? AND batch_id = 0`,
          eventID,
        )
        .one()?.state,
  );
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
