import { DurableObject } from "cloudflare:workers";
import type { AppConfig } from "../apps";
import type { Env } from "../types";
import { sendNotification, type ApnsReason } from "../apns/client";
import type { ApnsPayload } from "../apns/payload";
import { MAX_DEVICES_PER_CHANNEL } from "../validation";
import { CHANNEL_SCHEMA, CHANNEL_SCHEMA_VERSION } from "./schema";

type MutationFailure =
  | { ok: false; code: "closed" }
  | { ok: false; code: "rate_limited"; retryAfter: number }
  | { ok: false; code: "channel_full" }
  | { ok: false; code: "idempotency_conflict" };

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
  event: string;
  excludeInstallationID?: string;
  fingerprint: string;
  idempotencyKey: string;
  payload: ApnsPayload;
}

export interface PublishSuccess {
  ok: true;
  accepted: number;
  apnsLatencyMaxMs: number;
  apnsLatencyTotalMs: number;
  apnsReason: ApnsReason;
  apnsReasonCounts: Partial<Record<ApnsReason, number>>;
  apnsRequestID?: string;
  apnsStatus: number;
  deviceCount: number;
  failed: number;
  idempotency: "new" | "duplicate" | "retry";
  invalidRemoved: number;
  retryable: boolean;
}

export type PublishResult = PublishSuccess | MutationFailure;

export type CloseResult =
  | { ok: true; alreadyClosed: boolean; removedDevices: number }
  | Extract<MutationFailure, { code: "rate_limited" }>;

interface EventRow extends Record<string, SqlStorageValue> {
  request_fingerprint: string;
  completed_at: number | null;
  device_count: number;
  accepted: number;
  failed: number;
  invalid_removed: number;
}

interface DeliveryRow extends Record<string, SqlStorageValue> {
  installation_id: string;
  device_token: string | null;
}

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

export class ChannelObject extends DurableObject<Env> {
  private exclusiveTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
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

  async registerDevice(
    installationID: string,
    deviceToken: string,
  ): Promise<RegistrationResult> {
    if (this.isClosed()) return { ok: false, code: "closed" };
    const limit = this.takeRateLimit("register", 60, 60_000);
    if (!limit.allowed) {
      return { ok: false, code: "rate_limited", retryAfter: limit.retryAfter };
    }

    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec<{ device_token: string }>(
        "SELECT device_token FROM devices WHERE installation_id = ?",
        installationID,
      )
      .toArray()[0];
    const tokenOwner = sql
      .exec<{ installation_id: string }>(
        "SELECT installation_id FROM devices WHERE device_token = ?",
        deviceToken,
      )
      .toArray()[0];
    const countBefore =
      sql.exec<CountRow>("SELECT COUNT(*) AS count FROM devices").one()?.count ??
      0;
    if (!existing && !tokenOwner && countBefore >= MAX_DEVICES_PER_CHANNEL) {
      return { ok: false, code: "channel_full" };
    }

    const now = Date.now();
    const tokenReplaced = Boolean(
      existing && existing.device_token !== deviceToken,
    );
    sql.exec(
      "DELETE FROM devices WHERE device_token = ? AND installation_id <> ?",
      deviceToken,
      installationID,
    );
    sql.exec(
      `INSERT INTO devices(
        installation_id, device_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        device_token = excluded.device_token,
        updated_at = excluded.updated_at`,
      installationID,
      deviceToken,
      now,
      now,
    );
    const countAfter =
      sql.exec<CountRow>("SELECT COUNT(*) AS count FROM devices").one()?.count ??
      countBefore;
    return {
      ok: true,
      created: !existing,
      tokenReplaced,
      registrationDelta: countAfter - countBefore,
    };
  }

  async unregisterDevice(
    installationID: string,
  ): Promise<UnregistrationResult> {
    if (this.isClosed()) return { ok: false, code: "closed" };
    const limit = this.takeRateLimit("unregister", 60, 60_000);
    if (!limit.allowed) {
      return { ok: false, code: "rate_limited", retryAfter: limit.retryAfter };
    }
    const existing = this.ctx.storage.sql
      .exec<{ installation_id: string }>(
        "SELECT installation_id FROM devices WHERE installation_id = ?",
        installationID,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      "DELETE FROM devices WHERE installation_id = ?",
      installationID,
    );
    return {
      ok: true,
      removed: Boolean(existing),
      registrationDelta: existing ? -1 : 0,
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    return this.withExclusive(() => this.publishLocked(input));
  }

  async closeChannel(): Promise<CloseResult> {
    return this.withExclusive(() => this.closeChannelLocked());
  }

  private async closeChannelLocked(): Promise<CloseResult> {
    const alreadyClosed = this.isClosed();
    if (alreadyClosed) {
      return { ok: true, alreadyClosed: true, removedDevices: 0 };
    }
    const limit = this.takeRateLimit("close", 5, 60_000);
    if (!limit.allowed) {
      return { ok: false, code: "rate_limited", retryAfter: limit.retryAfter };
    }
    const sql = this.ctx.storage.sql;
    const removedDevices =
      sql.exec<CountRow>("SELECT COUNT(*) AS count FROM devices").one()?.count ??
      0;
    sql.exec("DELETE FROM event_deliveries");
    sql.exec("DELETE FROM events");
    sql.exec("DELETE FROM devices");
    sql.exec(
      "UPDATE channel_state SET closed_at = ? WHERE singleton = 1",
      Date.now(),
    );
    return { ok: true, alreadyClosed: false, removedDevices };
  }

  private async publishLocked(input: PublishInput): Promise<PublishResult> {
    if (this.isClosed()) return { ok: false, code: "closed" };
    const limit = this.takeRateLimit("publish", 30, 60_000);
    if (!limit.allowed) {
      return { ok: false, code: "rate_limited", retryAfter: limit.retryAfter };
    }
    this.pruneEvents();
    const sql = this.ctx.storage.sql;
    let event = sql
      .exec<EventRow>(
        `SELECT request_fingerprint, completed_at, device_count, accepted,
          failed, invalid_removed
        FROM events WHERE idempotency_key = ?`,
        input.idempotencyKey,
      )
      .toArray()[0];

    if (event && event.request_fingerprint !== input.fingerprint) {
      return { ok: false, code: "idempotency_conflict" };
    }
    if (event?.completed_at) {
      return this.storedResult(event, "duplicate");
    }

    const idempotency = event ? "retry" : "new";
    const now = Date.now();
    if (!event) {
      sql.exec(
        `INSERT INTO events(
          idempotency_key, request_fingerprint, event_name, created_at
        ) VALUES (?, ?, ?, ?)`,
        input.idempotencyKey,
        input.fingerprint,
        input.event,
        now,
      );
      if (input.excludeInstallationID) {
        sql.exec(
          `INSERT INTO event_deliveries(
            idempotency_key, installation_id, status, updated_at
          )
          SELECT ?, installation_id, 'pending', ? FROM devices
          WHERE installation_id <> ?`,
          input.idempotencyKey,
          now,
          input.excludeInstallationID,
        );
      } else {
        sql.exec(
          `INSERT INTO event_deliveries(
            idempotency_key, installation_id, status, updated_at
          )
          SELECT ?, installation_id, 'pending', ? FROM devices`,
          input.idempotencyKey,
          now,
        );
      }
      const deviceCount =
        sql
          .exec<CountRow>(
            "SELECT COUNT(*) AS count FROM event_deliveries WHERE idempotency_key = ?",
            input.idempotencyKey,
          )
          .one()?.count ?? 0;
      sql.exec(
        "UPDATE events SET device_count = ? WHERE idempotency_key = ?",
        deviceCount,
        input.idempotencyKey,
      );
    } else {
      // A request interrupted after marking a delivery as attempting must not
      // resend it. Treat its outcome as unknown and include it in failed.
      sql.exec(
        `UPDATE event_deliveries SET status = 'unknown', updated_at = ?
         WHERE idempotency_key = ? AND status = 'attempting'`,
        now,
        input.idempotencyKey,
      );
    }

    const deliveries = sql
      .exec<DeliveryRow>(
        `SELECT d.installation_id, v.device_token
         FROM event_deliveries d
         LEFT JOIN devices v ON v.installation_id = d.installation_id
         WHERE d.idempotency_key = ? AND d.status IN ('pending', 'transient')`,
        input.idempotencyKey,
      )
      .toArray();

    let apnsLatencyTotalMs = 0;
    let apnsLatencyMaxMs = 0;
    let apnsReason: ApnsReason = "none";
    let apnsStatus = 200;
    let apnsRequestID: string | undefined;
    let invalidRemovedThisAttempt = 0;
    const apnsReasonCounts: Partial<Record<ApnsReason, number>> = {};

    for (let offset = 0; offset < deliveries.length; offset += 6) {
      const batch = deliveries.slice(offset, offset + 6);
      const results = await Promise.all(
        batch.map(async (delivery) => {
          if (!delivery.device_token) {
            sql.exec(
              `UPDATE event_deliveries SET status = 'permanent', updated_at = ?
               WHERE idempotency_key = ? AND installation_id = ?`,
              Date.now(),
              input.idempotencyKey,
              delivery.installation_id,
            );
            return undefined;
          }
          sql.exec(
            `UPDATE event_deliveries SET status = 'attempting', updated_at = ?
             WHERE idempotency_key = ? AND installation_id = ?`,
            Date.now(),
            input.idempotencyKey,
            delivery.installation_id,
          );
          const result = await sendNotification(
            this.env,
            input.app,
            delivery.device_token,
            input.payload,
            input.idempotencyKey,
          );
          const status = result.accepted
            ? "accepted"
            : result.retryable
              ? "transient"
              : "permanent";
          sql.exec(
            `UPDATE event_deliveries SET status = ?, updated_at = ?
             WHERE idempotency_key = ? AND installation_id = ?`,
            status,
            Date.now(),
            input.idempotencyKey,
            delivery.installation_id,
          );
          if (result.invalidToken) {
            sql.exec(
              "DELETE FROM devices WHERE installation_id = ? AND device_token = ?",
              delivery.installation_id,
              delivery.device_token,
            );
            invalidRemovedThisAttempt += 1;
          }
          return result;
        }),
      );
      for (const result of results) {
        if (!result) continue;
        apnsLatencyTotalMs += result.latencyMs;
        apnsLatencyMaxMs = Math.max(apnsLatencyMaxMs, result.latencyMs);
        if (!result.accepted) {
          apnsReason = result.reason;
          apnsStatus = result.status;
          apnsReasonCounts[result.reason] =
            (apnsReasonCounts[result.reason] ?? 0) + 1;
        }
        if (result.requestID) apnsRequestID = result.requestID;
      }
    }

    const aggregates = sql
      .exec<{
        accepted: number;
        failed: number;
        invalid_removed: number;
        transient: number;
      }>(
        `SELECT
          SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN status IN ('permanent', 'unknown') THEN 1 ELSE 0 END) AS failed,
          0 AS invalid_removed,
          SUM(CASE WHEN status = 'transient' THEN 1 ELSE 0 END) AS transient
        FROM event_deliveries WHERE idempotency_key = ?`,
        input.idempotencyKey,
      )
      .one();
    const invalidRemoved =
      (event?.invalid_removed ?? 0) + invalidRemovedThisAttempt;
    const accepted = aggregates?.accepted ?? 0;
    const failed = aggregates?.failed ?? 0;
    const transient = aggregates?.transient ?? 0;
    const completedAt = transient === 0 ? Date.now() : null;
    sql.exec(
      `UPDATE events SET accepted = ?, failed = ?, invalid_removed = ?,
        completed_at = ? WHERE idempotency_key = ?`,
      accepted,
      failed,
      invalidRemoved,
      completedAt,
      input.idempotencyKey,
    );
    event = sql
      .exec<EventRow>(
        `SELECT request_fingerprint, completed_at, device_count, accepted,
          failed, invalid_removed FROM events WHERE idempotency_key = ?`,
        input.idempotencyKey,
      )
      .one();
    if (!event) throw new Error("Event state disappeared");
    return {
      ...this.storedResult(event, idempotency),
      apnsLatencyMaxMs,
      apnsLatencyTotalMs,
      apnsReason,
      apnsReasonCounts,
      apnsStatus,
      ...(apnsRequestID ? { apnsRequestID } : {}),
      retryable: transient > 0,
    };
  }

  private storedResult(
    event: EventRow,
    idempotency: "new" | "duplicate" | "retry",
  ): PublishSuccess {
    return {
      ok: true,
      accepted: event.accepted,
      apnsLatencyMaxMs: 0,
      apnsLatencyTotalMs: 0,
      apnsReason: "none",
      apnsReasonCounts: {},
      apnsStatus: 200,
      deviceCount: event.device_count,
      failed: event.failed,
      idempotency,
      invalidRemoved: event.invalid_removed,
      retryable: false,
    };
  }

  private isClosed(): boolean {
    return Boolean(
      this.ctx.storage.sql
        .exec<{ closed_at: number | null }>(
          "SELECT closed_at FROM channel_state WHERE singleton = 1",
        )
        .one()?.closed_at,
    );
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
        `SELECT window_started_at, request_count FROM rate_limits
         WHERE operation = ?`,
        operation,
      )
      .toArray()[0];
    if (!row || now - row.window_started_at >= windowMs) {
      sql.exec(
        `INSERT INTO rate_limits(operation, window_started_at, request_count)
         VALUES (?, ?, 1)
         ON CONFLICT(operation) DO UPDATE SET
          window_started_at = excluded.window_started_at, request_count = 1`,
        operation,
        now,
      );
      return { allowed: true };
    }
    if (row.request_count >= maximum) {
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((windowMs - (now - row.window_started_at)) / 1_000),
        ),
      };
    }
    sql.exec(
      "UPDATE rate_limits SET request_count = request_count + 1 WHERE operation = ?",
      operation,
    );
    return { allowed: true };
  }

  private pruneEvents(): void {
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    sql.exec(
      `DELETE FROM event_deliveries WHERE idempotency_key IN (
        SELECT idempotency_key FROM events WHERE created_at < ?
      )`,
      cutoff,
    );
    sql.exec("DELETE FROM events WHERE created_at < ?", cutoff);
    sql.exec(
      `DELETE FROM event_deliveries WHERE idempotency_key IN (
        SELECT idempotency_key FROM events
        ORDER BY created_at DESC LIMIT -1 OFFSET 1000
      )`,
    );
    sql.exec(
      `DELETE FROM events WHERE idempotency_key IN (
        SELECT idempotency_key FROM events
        ORDER BY created_at DESC LIMIT -1 OFFSET 1000
      )`,
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
