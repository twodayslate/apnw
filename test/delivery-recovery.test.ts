import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apps } from "../src/apps";
import { capabilityDigest, encodeBase64Url } from "../src/auth";
import {
  DELIVERY_ENQUEUED_RECOVERY_MS,
  DELIVERY_PROCESSING_LEASE_MS,
  EVENT_RETENTION_MS,
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

  it("redrives a batch that remains enqueued beyond the DLQ recovery window", async () => {
    const fixture = await queuedFixture();
    const staleUpdatedAt =
      Date.now() - DELIVERY_ENQUEUED_RECOVERY_MS - 1_000;
    await setBatchState(
      fixture.stub,
      fixture.message.eventID,
      "enqueued",
      staleUpdatedAt,
    );

    await runInDurableObject(fixture.stub, (instance) => instance.alarm?.());

    const recovered = await batchRecord(
      fixture.stub,
      fixture.message.eventID,
    );
    expect(recovered?.state).toBe("enqueued");
    expect(recovered?.updated_at).toBeGreaterThan(staleUpdatedAt);
  });

  it("prunes completed events from quiet channels using the alarm", async () => {
    const stub = env.CHANNELS.get(
      env.CHANNELS.idFromName(`retention:${crypto.randomUUID()}`),
    );
    await stub.provision("a".repeat(64));
    const eventID = crypto.randomUUID();
    await stub.publish({
      app,
      appID,
      clientCreatedAt: Date.now(),
      event: "submission_ready",
      fingerprint: "b".repeat(64),
      idempotencyKey: eventID,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE events SET created_at = ? WHERE idempotency_key = ?",
        Date.now() - EVENT_RETENTION_MS - 1_000,
        eventID,
      );
    });

    await runInDurableObject(stub, (instance) => instance.alarm?.());

    const retained = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?",
            eventID,
          )
          .one().count,
    );
    expect(retained).toBe(0);
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

async function setBatchState(
  stub: DurableObjectStub<ChannelObject>,
  eventID: string,
  state: "enqueued" | "processing",
  updatedAt: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, durableState) => {
    durableState.storage.sql.exec(
      `UPDATE delivery_batches SET state = ?, updated_at = ?
       WHERE idempotency_key = ? AND batch_id = 0`,
      state,
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

function batchRecord(
  stub: DurableObjectStub<ChannelObject>,
  eventID: string,
): Promise<{ state: string; updated_at: number } | undefined> {
  return runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ state: string; updated_at: number }>(
          `SELECT state, updated_at FROM delivery_batches
           WHERE idempotency_key = ? AND batch_id = 0`,
          eventID,
        )
        .one(),
  );
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
