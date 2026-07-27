import { DurableObject } from "cloudflare:workers";
import { sendNotification, type ApnsReason, type ApnsResult } from "../apns/client";
import { buildPayload } from "../apns/payload";
import type { AppConfig } from "../apps";
import { constantTimeEqual } from "../auth";
import type { Env } from "../types";
import {
  CHANNEL_SCHEMA,
  CHANNEL_SCHEMA_VERSION,
  MIGRATE_CHANNEL_V1_TO_V2,
} from "./schema";

const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DELIVERY_BATCH_SIZE = 100;
const DIRECT_DELIVERY_MAX = 20;

type MutationFailure =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "rate_limited"; retryAfter: number }
  | { ok: false; code: "idempotency_conflict" }
  | { ok: false; code: "credential_conflict" };

export type ProvisionResult =
  | { ok: true; alreadyProvisioned: boolean }
  | Extract<MutationFailure, { code: "not_found" }>;

export type RegistrationResult =
  | {
      ok: true;
      created: boolean;
      tokenReplaced: boolean;
      registrationDelta: number;
    }
  | MutationFailure;

export type UnregistrationResult =
  | { ok: true; removed: boolean; registrationDelta: number }
  | MutationFailure;

export interface PublishInput {
  app: AppConfig;
  appID: string;
  clientCreatedAt: number;
  event: string;
  excludeInstallationID?: string;
  excludeInstallationCapabilityDigest?: string;
  fingerprint: string;
  idempotencyKey: string;
}

export interface PublishSuccess {
  ok: true;
  eventID: string;
  idempotency: "new" | "duplicate" | "retry";
  mode: "direct" | "queued";
  pendingBatchIDs: number[];
  state: "accepted" | "delivering" | "completed";
}

export type PublishResult = PublishSuccess | MutationFailure;

export type CloseResult =
  | { ok: true; alreadyClosed: boolean }
  | MutationFailure;

export interface DeliveryResult {
  ok: true;
  accepted: number;
  apnsLatencyMaxMs: number;
  apnsLatencyTotalMs: number;
  apnsReason: ApnsReason;
  apnsReasonCounts: Partial<Record<ApnsReason, number>>;
  apnsRequestID?: string;
  apnsStatus: number;
  failed: number;
  invalidRemoved: number;
  retryable: boolean;
}

interface StateRow extends Record<string, SqlStorageValue> {
  admin_capability_digest: string | null;
  closed_at: number | null;
  provisioned_at: number | null;
}

interface EventRow extends Record<string, SqlStorageValue> {
  delivery_mode: "direct" | "queued";
  request_fingerprint: string;
  state: "accepted" | "delivering" | "completed";
}

interface DeliveryRow extends Record<string, SqlStorageValue> {
  installation_id: string;
  token_version: number;
  current_token_version: number | null;
  device_token: string | null;
  token_registered_at: number | null;
  suspect_count: number | null;
}

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

export class ChannelObject extends DurableObject<Env> {
  private exclusiveTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
    `);
    const current = sql
      .exec<{ version: number }>(
        "SELECT version FROM schema_metadata WHERE singleton = 1",
      )
      .toArray()[0]?.version;
    if (current === 1) sql.exec(MIGRATE_CHANNEL_V1_TO_V2);
    sql.exec(CHANNEL_SCHEMA);
    const version = sql
      .exec<{ version: number }>(
        "SELECT version FROM schema_metadata WHERE singleton = 1",
      )
      .one()?.version;
    if (version !== CHANNEL_SCHEMA_VERSION) {
      throw new Error("Unsupported channel schema version");
    }
  }

  provision(adminCapabilityDigest: string): ProvisionResult {
    const state = this.state();
    if (state.closed_at !== null) return { ok: false, code: "not_found" };
    if (state.provisioned_at !== null) {
      return constantTimeEqual(
        state.admin_capability_digest ?? "",
        adminCapabilityDigest,
      )
        ? { ok: true, alreadyProvisioned: true }
        : { ok: false, code: "not_found" };
    }
    this.ctx.storage.sql.exec(
      `UPDATE channel_state SET provisioned_at = ?,
        admin_capability_digest = ? WHERE singleton = 1`,
      Date.now(),
      adminCapabilityDigest,
    );
    return { ok: true, alreadyProvisioned: false };
  }

  registerDevice(
    installationID: string,
    deviceToken: string,
    installationCapabilityDigest: string,
  ): RegistrationResult {
    if (!this.isUsable()) return { ok: false, code: "not_found" };
    const limit = this.takeRateLimit("register", 10_000, 60_000);
    if (!limit.allowed) return rateFailure(limit.retryAfter);

    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec<{
        device_token: string;
        installation_capability_digest: string;
        token_version: number;
      }>(
        `SELECT device_token, installation_capability_digest, token_version
         FROM devices WHERE installation_id = ?`,
        installationID,
      )
      .toArray()[0];
    if (
      existing &&
      existing.installation_capability_digest !== "" &&
      !constantTimeEqual(
        existing.installation_capability_digest,
        installationCapabilityDigest,
      )
    ) {
      return { ok: false, code: "not_found" };
    }
    const tokenOwner = sql
      .exec<{ installation_id: string }>(
        "SELECT installation_id FROM devices WHERE device_token = ?",
        deviceToken,
      )
      .toArray()[0];
    if (tokenOwner && tokenOwner.installation_id !== installationID) {
      return { ok: false, code: "credential_conflict" };
    }

    const now = Date.now();
    const tokenReplaced = Boolean(existing && existing.device_token !== deviceToken);
    const tokenVersion = existing
      ? existing.token_version + (tokenReplaced ? 1 : 0)
      : 1;
    sql.exec(
      `INSERT INTO devices(
        installation_id, installation_capability_digest, device_token,
        token_version, token_registered_at, suspect_count, quarantined_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        installation_capability_digest = excluded.installation_capability_digest,
        device_token = excluded.device_token,
        token_version = excluded.token_version,
        token_registered_at = CASE
          WHEN devices.device_token <> excluded.device_token
            THEN excluded.token_registered_at
          ELSE devices.token_registered_at
        END,
        suspect_count = 0,
        quarantined_at = NULL,
        updated_at = excluded.updated_at`,
      installationID,
      installationCapabilityDigest,
      deviceToken,
      tokenVersion,
      now,
      now,
      now,
    );
    return {
      ok: true,
      created: !existing,
      tokenReplaced,
      registrationDelta: existing ? 0 : 1,
    };
  }

  unregisterDevice(
    installationID: string,
    installationCapabilityDigest: string,
  ): UnregistrationResult {
    if (!this.isUsable()) return { ok: false, code: "not_found" };
    const limit = this.takeRateLimit("unregister", 10_000, 60_000);
    if (!limit.allowed) return rateFailure(limit.retryAfter);
    const existing = this.ctx.storage.sql
      .exec<{ installation_capability_digest: string }>(
        `SELECT installation_capability_digest FROM devices
         WHERE installation_id = ?`,
        installationID,
      )
      .toArray()[0];
    if (!existing) {
      // Do not expose whether a supplied installation identifier exists.
      return { ok: true, removed: false, registrationDelta: 0 };
    }
    if (
      !constantTimeEqual(
        existing.installation_capability_digest,
        installationCapabilityDigest,
      )
    ) {
      return { ok: false, code: "not_found" };
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM devices WHERE installation_id = ?",
      installationID,
    );
    return { ok: true, removed: true, registrationDelta: -1 };
  }

  publish(input: PublishInput): Promise<PublishResult> {
    return this.withExclusive(() => this.publishLocked(input));
  }

  async alarm(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ app_id: string; batch_id: number; idempotency_key: string }>(
        `SELECT e.app_id, b.idempotency_key, b.batch_id
         FROM delivery_batches b
         JOIN events e ON e.idempotency_key = b.idempotency_key
         WHERE b.state = 'pending'
         ORDER BY b.idempotency_key, b.batch_id`,
      )
      .toArray();
    for (let offset = 0; offset < pending.length; offset += 100) {
      const group = pending.slice(offset, offset + 100);
      await this.env.DELIVERY_QUEUE.sendBatch(
        group.map((row) => ({
          body: {
            appID: row.app_id,
            channelID: this.ctx.id.toString(),
            eventID: row.idempotency_key,
            batchID: row.batch_id,
          },
        })),
      );
      for (const row of group) {
        this.markEnqueued(row.idempotency_key, [row.batch_id]);
      }
    }
  }

  markEnqueued(eventID: string, batchIDs: number[]): void {
    for (const batchID of batchIDs) {
      this.ctx.storage.sql.exec(
        `UPDATE delivery_batches SET state = 'enqueued', updated_at = ?
         WHERE idempotency_key = ? AND batch_id = ?
           AND state IN ('pending', 'enqueued')`,
        Date.now(),
        eventID,
        batchID,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE events SET state = 'delivering'
       WHERE idempotency_key = ? AND state = 'accepted'`,
      eventID,
    );
  }

  deliverBatch(
    eventID: string,
    batchID: number,
    app: AppConfig,
  ): Promise<DeliveryResult> {
    return this.withExclusive(() =>
      this.deliverBatchLocked(eventID, batchID, app),
    );
  }

  closeChannel(adminCapabilityDigest: string): Promise<CloseResult> {
    return this.withExclusive(() => this.closeChannelLocked(adminCapabilityDigest));
  }

  private closeChannelLocked(adminCapabilityDigest: string): CloseResult {
    const state = this.state();
    if (
      state.provisioned_at === null ||
      !constantTimeEqual(
        state.admin_capability_digest ?? "",
        adminCapabilityDigest,
      )
    ) {
      return { ok: false, code: "not_found" };
    }
    if (state.closed_at !== null) return { ok: true, alreadyClosed: true };
    const limit = this.takeRateLimit("close", 10, 60_000);
    if (!limit.allowed) return rateFailure(limit.retryAfter);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM event_deliveries");
    sql.exec("DELETE FROM delivery_batches");
    sql.exec("DELETE FROM events");
    sql.exec("DELETE FROM devices");
    sql.exec("UPDATE channel_state SET closed_at = ? WHERE singleton = 1", Date.now());
    return { ok: true, alreadyClosed: false };
  }

  private publishLocked(input: PublishInput): PublishResult {
    if (!this.isUsable()) return { ok: false, code: "not_found" };
    const limit = this.takeRateLimit("publish", 1_200, 60_000);
    if (!limit.allowed) return rateFailure(limit.retryAfter);
    if (
      input.excludeInstallationID &&
      !this.installationAuthorized(
        input.excludeInstallationID,
        input.excludeInstallationCapabilityDigest ?? "",
      )
    ) {
      return { ok: false, code: "not_found" };
    }
    this.pruneEvents();
    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec<EventRow>(
        `SELECT request_fingerprint, delivery_mode, state FROM events
         WHERE idempotency_key = ?`,
        input.idempotencyKey,
      )
      .toArray()[0];
    if (existing && existing.request_fingerprint !== input.fingerprint) {
      return { ok: false, code: "idempotency_conflict" };
    }
    if (existing) {
      return {
        ok: true,
        eventID: input.idempotencyKey,
        idempotency: existing.state === "completed" ? "duplicate" : "retry",
        mode: existing.delivery_mode,
        pendingBatchIDs: this.pendingBatchIDs(input.idempotencyKey),
        state: existing.state,
      };
    }

    const now = Date.now();
    sql.exec(
      `INSERT INTO events(
        idempotency_key, app_id, request_fingerprint, event_name, client_created_at,
        created_at, state, delivery_mode
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'direct')`,
      input.idempotencyKey,
      input.appID,
      input.fingerprint,
      input.event,
      input.clientCreatedAt,
      now,
    );
    const installations = input.excludeInstallationID
      ? sql
          .exec<{ installation_id: string; token_version: number }>(
            `SELECT installation_id, token_version FROM devices
             WHERE installation_id <> ? ORDER BY installation_id`,
            input.excludeInstallationID,
          )
          .toArray()
      : sql
          .exec<{ installation_id: string; token_version: number }>(
            "SELECT installation_id, token_version FROM devices ORDER BY installation_id",
          )
          .toArray();
    for (let index = 0; index < installations.length; index += 1) {
      const installation = installations[index];
      if (!installation) continue;
      sql.exec(
        `INSERT INTO event_deliveries(
          idempotency_key, installation_id, token_version, batch_id,
          status, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?)`,
        input.idempotencyKey,
        installation.installation_id,
        installation.token_version,
        Math.floor(index / DELIVERY_BATCH_SIZE),
        now,
      );
    }
    const batchCount = Math.ceil(installations.length / DELIVERY_BATCH_SIZE);
    for (let batchID = 0; batchID < batchCount; batchID += 1) {
      sql.exec(
        `INSERT INTO delivery_batches(
          idempotency_key, batch_id, state, updated_at
        ) VALUES (?, ?, 'pending', ?)`,
        input.idempotencyKey,
        batchID,
        now,
      );
    }
    const mode = installations.length <= DIRECT_DELIVERY_MAX ? "direct" : "queued";
    sql.exec(
      `UPDATE events SET device_count = ?, delivery_mode = ?,
        state = CASE WHEN ? = 0 THEN 'completed' ELSE 'accepted' END,
        completed_at = CASE WHEN ? = 0 THEN ? ELSE NULL END
       WHERE idempotency_key = ?`,
      installations.length,
      mode,
      installations.length,
      installations.length,
      now,
      input.idempotencyKey,
    );
    if (batchCount > 0) {
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 10_000));
    }
    return {
      ok: true,
      eventID: input.idempotencyKey,
      idempotency: "new",
      mode,
      pendingBatchIDs: Array.from({ length: batchCount }, (_, index) => index),
      state: installations.length === 0 ? "completed" : "accepted",
    };
  }

  private async deliverBatchLocked(
    eventID: string,
    batchID: number,
    app: AppConfig,
  ): Promise<DeliveryResult> {
    const empty = (): DeliveryResult => ({
      ok: true,
      accepted: 0,
      apnsLatencyMaxMs: 0,
      apnsLatencyTotalMs: 0,
      apnsReason: "none",
      apnsReasonCounts: {},
      apnsStatus: 200,
      failed: 0,
      invalidRemoved: 0,
      retryable: false,
    });
    if (!this.isUsable()) return empty();
    const batch = this.ctx.storage.sql
      .exec<{ state: string }>(
        `SELECT state FROM delivery_batches
         WHERE idempotency_key = ? AND batch_id = ?`,
        eventID,
        batchID,
      )
      .toArray()[0];
    if (!batch || batch.state === "completed") return empty();
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec(
      `UPDATE event_deliveries SET status = 'unknown', updated_at = ?
       WHERE idempotency_key = ? AND batch_id = ? AND status = 'attempting'`,
      now,
      eventID,
      batchID,
    );
    sql.exec(
      `UPDATE delivery_batches SET state = 'processing', updated_at = ?
       WHERE idempotency_key = ? AND batch_id = ?`,
      now,
      eventID,
      batchID,
    );
    const deliveries = sql
      .exec<DeliveryRow>(
        `SELECT d.installation_id, d.token_version,
          v.token_version AS current_token_version, v.device_token,
          v.token_registered_at, v.suspect_count
         FROM event_deliveries d
         LEFT JOIN devices v ON v.installation_id = d.installation_id
         WHERE d.idempotency_key = ? AND d.batch_id = ?
           AND d.status IN ('pending', 'transient')`,
        eventID,
        batchID,
      )
      .toArray();
    const event = sql
      .exec<{ event_name: string }>(
        "SELECT event_name FROM events WHERE idempotency_key = ?",
        eventID,
      )
      .toArray()[0];
    if (!event) return empty();
    const payload = buildPayload(app, event.event_name);

    let accepted = 0;
    let failed = 0;
    let invalidRemoved = 0;
    let retryable = false;
    let apnsLatencyTotalMs = 0;
    let apnsLatencyMaxMs = 0;
    let apnsReason: ApnsReason = "none";
    let apnsStatus = 200;
    let apnsRequestID: string | undefined;
    const apnsReasonCounts: Partial<Record<ApnsReason, number>> = {};

    for (let offset = 0; offset < deliveries.length; offset += 6) {
      const group = deliveries.slice(offset, offset + 6);
      const sendable: DeliveryRow[] = [];
      for (const delivery of group) {
        if (
          !delivery.device_token ||
          delivery.current_token_version !== delivery.token_version
        ) {
          sql.exec(
            `UPDATE event_deliveries SET status = 'permanent', updated_at = ?
             WHERE idempotency_key = ? AND installation_id = ?`,
            Date.now(),
            eventID,
            delivery.installation_id,
          );
          failed += 1;
          continue;
        }
        sql.exec(
          `UPDATE event_deliveries SET status = 'attempting',
            attempt_count = attempt_count + 1, updated_at = ?
           WHERE idempotency_key = ? AND installation_id = ?`,
          Date.now(),
          eventID,
          delivery.installation_id,
        );
        sendable.push(delivery);
      }

      const results = await Promise.all(
        sendable.map(async (delivery) => {
          if (this.circuitOpen()) return circuitOpenResult();
          const result = await sendNotification(
            this.env,
            app,
            delivery.device_token ?? "",
            payload,
            eventID,
          );
          this.recordApnsHealth(result);
          return result;
        }),
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const delivery = sendable[index];
        if (!result || !delivery) continue;
        apnsLatencyTotalMs += result.latencyMs;
        apnsLatencyMaxMs = Math.max(apnsLatencyMaxMs, result.latencyMs);
        if (result.requestID) apnsRequestID = result.requestID;
        if (result.accepted) {
          accepted += 1;
          sql.exec(
            `UPDATE event_deliveries SET status = 'accepted', updated_at = ?
             WHERE idempotency_key = ? AND installation_id = ?`,
            Date.now(),
            eventID,
            delivery.installation_id,
          );
          continue;
        }
        apnsReason = result.reason;
        apnsStatus = result.status;
        apnsReasonCounts[result.reason] =
          (apnsReasonCounts[result.reason] ?? 0) + 1;
        const status = result.retryable ? "transient" : "permanent";
        retryable ||= result.retryable;
        if (!result.retryable) failed += 1;
        sql.exec(
          `UPDATE event_deliveries SET status = ?, updated_at = ?
           WHERE idempotency_key = ? AND installation_id = ?`,
          status,
          Date.now(),
          eventID,
          delivery.installation_id,
        );
        if (this.applySafeCleanup(delivery, result)) invalidRemoved += 1;
      }
    }

    sql.exec(
      `UPDATE delivery_batches SET state = ?, retry_count = retry_count + ?,
        updated_at = ? WHERE idempotency_key = ? AND batch_id = ?`,
      retryable ? "enqueued" : "completed",
      retryable ? 1 : 0,
      Date.now(),
      eventID,
      batchID,
    );
    this.refreshEventState(eventID, invalidRemoved);
    return {
      ok: true,
      accepted,
      apnsLatencyMaxMs,
      apnsLatencyTotalMs,
      apnsReason,
      apnsReasonCounts,
      ...(apnsRequestID ? { apnsRequestID } : {}),
      apnsStatus,
      failed,
      invalidRemoved,
      retryable,
    };
  }

  private applySafeCleanup(delivery: DeliveryRow, result: ApnsResult): boolean {
    if (this.cleanupCircuitOpen()) return false;
    if (!delivery.device_token || delivery.current_token_version !== delivery.token_version) {
      return false;
    }
    const sql = this.ctx.storage.sql;
    if (result.cleanup === "unregistered") {
      if (
        result.invalidationTimestamp === undefined ||
        delivery.token_registered_at === null ||
        delivery.token_registered_at > result.invalidationTimestamp
      ) {
        return false;
      }
      const cursor = sql.exec(
        `DELETE FROM devices WHERE installation_id = ? AND device_token = ?
          AND token_version = ? AND token_registered_at <= ?`,
        delivery.installation_id,
        delivery.device_token,
        delivery.token_version,
        result.invalidationTimestamp,
      );
      return cursor.rowsWritten === 1;
    }
    if (result.cleanup === "suspect") {
      const suspectCount = delivery.suspect_count ?? 0;
      if (suspectCount >= 1) {
        const cursor = sql.exec(
          `DELETE FROM devices WHERE installation_id = ? AND device_token = ?
            AND token_version = ? AND suspect_count >= 1`,
          delivery.installation_id,
          delivery.device_token,
          delivery.token_version,
        );
        return cursor.rowsWritten === 1;
      }
      sql.exec(
        `UPDATE devices SET suspect_count = 1, quarantined_at = ?,
          updated_at = ? WHERE installation_id = ? AND device_token = ?
          AND token_version = ?`,
        Date.now(),
        Date.now(),
        delivery.installation_id,
        delivery.device_token,
        delivery.token_version,
      );
    }
    return false;
  }

  private recordApnsHealth(result: ApnsResult): void {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const circuit = this.circuitConfiguration();
    const row = sql
      .exec<{
        window_started_at: number;
        request_count: number;
        failure_count: number;
        cleanup_candidate_count: number;
      }>(
        `SELECT window_started_at, request_count, failure_count,
          cleanup_candidate_count
         FROM apns_health WHERE singleton = 1`,
      )
      .one();
    const reset = !row || now - row.window_started_at >= circuit.windowMs;
    const requestCount = (reset ? 0 : row.request_count) + 1;
    const upstreamFailure =
      result.configurationFailure ||
      result.retryable ||
      result.reason === "network_error" ||
      result.reason === "request_timeout";
    const failureCount = (reset ? 0 : row.failure_count) + (upstreamFailure ? 1 : 0);
    const cleanupCandidate =
      result.cleanup !== "none" || result.reason === "topic_error";
    const cleanupCandidateCount =
      (reset ? 0 : row.cleanup_candidate_count) + (cleanupCandidate ? 1 : 0);
    const shouldOpenDelivery =
      result.configurationFailure ||
      (requestCount >= circuit.minimumAttempts &&
        failureCount / requestCount > circuit.failureRate);
    const shouldSuspendCleanup =
      result.reason === "topic_error" ||
      (requestCount >= circuit.minimumAttempts &&
        cleanupCandidateCount / requestCount > circuit.failureRate);
    sql.exec(
      `UPDATE apns_health SET window_started_at = ?, request_count = ?,
        failure_count = ?, circuit_open_until = ?,
        cleanup_candidate_count = ?, cleanup_suspended_until = ?
       WHERE singleton = 1`,
      reset ? now : row?.window_started_at ?? now,
      requestCount,
      failureCount,
      shouldOpenDelivery ? now + circuit.openMs : null,
      cleanupCandidateCount,
      shouldSuspendCleanup ? now + circuit.openMs : null,
    );
  }

  private circuitOpen(): boolean {
    const until = this.ctx.storage.sql
      .exec<{ circuit_open_until: number | null }>(
        "SELECT circuit_open_until FROM apns_health WHERE singleton = 1",
      )
      .one()?.circuit_open_until;
    return until !== null && until !== undefined && until > Date.now();
  }

  private cleanupCircuitOpen(): boolean {
    const until = this.ctx.storage.sql
      .exec<{ cleanup_suspended_until: number | null }>(
        `SELECT cleanup_suspended_until FROM apns_health
         WHERE singleton = 1`,
      )
      .one()?.cleanup_suspended_until;
    return until !== null && until !== undefined && until > Date.now();
  }

  private circuitConfiguration(): {
    failureRate: number;
    minimumAttempts: number;
    openMs: number;
    windowMs: number;
  } {
    return {
      failureRate: boundedNumber(
        this.env.APNS_CIRCUIT_FAILURE_RATE,
        0.05,
        0.001,
        1,
      ),
      minimumAttempts: Math.floor(
        boundedNumber(
          this.env.APNS_CIRCUIT_MIN_ATTEMPTS,
          10,
          1,
          10_000,
        ),
      ),
      openMs:
        boundedNumber(
          this.env.APNS_CIRCUIT_OPEN_SECONDS,
          300,
          10,
          3_600,
        ) * 1_000,
      windowMs:
        boundedNumber(
          this.env.APNS_CIRCUIT_WINDOW_SECONDS,
          300,
          10,
          3_600,
        ) * 1_000,
    };
  }

  private refreshEventState(
    eventID: string,
    invalidRemovedThisAttempt: number,
  ): void {
    const pending =
      this.ctx.storage.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM delivery_batches
           WHERE idempotency_key = ? AND state <> 'completed'`,
          eventID,
        )
        .one()?.count ?? 0;
    const aggregates = this.ctx.storage.sql
      .exec<{ accepted: number; failed: number }>(
        `SELECT
          SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN status IN ('permanent', 'unknown') THEN 1 ELSE 0 END)
            AS failed
         FROM event_deliveries WHERE idempotency_key = ?`,
        eventID,
      )
      .one();
    this.ctx.storage.sql.exec(
      `UPDATE events SET state = ?, completed_at = ?, accepted = ?,
        failed = ?, invalid_removed = invalid_removed + ?
       WHERE idempotency_key = ?`,
      pending === 0 ? "completed" : "delivering",
      pending === 0 ? Date.now() : null,
      aggregates?.accepted ?? 0,
      aggregates?.failed ?? 0,
      invalidRemovedThisAttempt,
      eventID,
    );
  }

  private pendingBatchIDs(eventID: string): number[] {
    return this.ctx.storage.sql
      .exec<{ batch_id: number }>(
        `SELECT batch_id FROM delivery_batches
         WHERE idempotency_key = ? AND state = 'pending' ORDER BY batch_id`,
        eventID,
      )
      .toArray()
      .map((row) => row.batch_id);
  }

  private installationAuthorized(
    installationID: string,
    capabilityDigest: string,
  ): boolean {
    const stored = this.ctx.storage.sql
      .exec<{ installation_capability_digest: string }>(
        `SELECT installation_capability_digest FROM devices
         WHERE installation_id = ?`,
        installationID,
      )
      .toArray()[0]?.installation_capability_digest;
    return Boolean(stored && constantTimeEqual(stored, capabilityDigest));
  }

  private state(): StateRow {
    return (
      this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT provisioned_at, admin_capability_digest, closed_at
           FROM channel_state WHERE singleton = 1`,
        )
        .one() ?? {
        provisioned_at: null,
        admin_capability_digest: null,
        closed_at: null,
      }
    );
  }

  private isUsable(): boolean {
    const state = this.state();
    return state.provisioned_at !== null && state.closed_at === null;
  }

  private takeRateLimit(
    operation: string,
    maximum: number,
    windowMs: number,
  ): { allowed: true } | { allowed: false; retryAfter: number } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const row = sql
      .exec<{ window_started_at: number; request_count: number }>(
        "SELECT window_started_at, request_count FROM rate_limits WHERE operation = ?",
        operation,
      )
      .toArray()[0];
    if (!row || now - row.window_started_at >= windowMs) {
      sql.exec(
        `INSERT INTO rate_limits(operation, window_started_at, request_count)
         VALUES (?, ?, 1) ON CONFLICT(operation) DO UPDATE SET
          window_started_at = excluded.window_started_at, request_count = 1`,
        operation,
        now,
      );
      return { allowed: true };
    }
    if (row.request_count >= maximum) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((windowMs - (now - row.window_started_at)) / 1_000)),
      };
    }
    sql.exec(
      "UPDATE rate_limits SET request_count = request_count + 1 WHERE operation = ?",
      operation,
    );
    return { allowed: true };
  }

  private pruneEvents(): void {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `DELETE FROM event_deliveries WHERE idempotency_key IN (
        SELECT idempotency_key FROM events
        WHERE created_at < ? AND state = 'completed'
      )`,
      cutoff,
    );
    sql.exec(
      `DELETE FROM delivery_batches WHERE idempotency_key IN (
        SELECT idempotency_key FROM events
        WHERE created_at < ? AND state = 'completed'
      )`,
      cutoff,
    );
    sql.exec(
      "DELETE FROM events WHERE created_at < ? AND state = 'completed'",
      cutoff,
    );
  }

  private async withExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.exclusiveTail;
    let release = (): void => undefined;
    this.exclusiveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function rateFailure(
  retryAfter: number,
): Extract<MutationFailure, { code: "rate_limited" }> {
  return { ok: false, code: "rate_limited", retryAfter };
}

function circuitOpenResult(): ApnsResult {
  return {
    accepted: false,
    cleanup: "none",
    configurationFailure: false,
    retryable: true,
    status: 503,
    reason: "circuit_open",
    latencyMs: 0,
  };
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}
