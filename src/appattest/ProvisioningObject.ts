import { DurableObject } from "cloudflare:workers";
import { getApp, type AppConfig } from "../apps";
import { encodeBase64Url } from "../auth";
import { getProviderToken } from "../apns/jwt";
import type { Env } from "../types";
import {
  verifyAppAttestReceipt,
  type AppAttestReceiptClaims,
} from "./receipt";
import {
  AppAttestVerificationError,
  verifyAssertion,
  verifyAttestation,
} from "./verifier";

const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const MAX_OUTSTANDING_CHALLENGES_PER_SHARD = 512;

export type ProvisioningFailure =
  | { ok: false; code: "invalid_attestation" }
  | { ok: false; code: "rate_limited"; retryAfter: number };

export type ChallengeResult =
  | {
      ok: true;
      challengeID: string;
      challenge: string;
      expiresIn: number;
    }
  | ProvisioningFailure;

export type KeyRegistrationResult =
  | { ok: true; registered: boolean }
  | ProvisioningFailure;

export type ProvisionResult =
  | { ok: true; provisioned: boolean }
  | ProvisioningFailure;

interface ChallengeRow extends Record<string, SqlStorageValue> {
  challenge: string;
  purpose: string;
  key_id: string;
  binding_digest: string | null;
  expires_at: number;
  used_at: number | null;
}

interface KeyRow extends Record<string, SqlStorageValue> {
  app_id: string;
  public_key_spki: string;
  assertion_counter: number;
  fraud_status: FraudStatus;
}

type FraudStatus = "accepted" | "blocked" | "error" | "pending";

interface FraudRow extends Record<string, SqlStorageValue> {
  key_id: string;
  app_id: string;
  public_key_spki: string;
  fraud_receipt: string;
  fraud_status: FraudStatus;
  fraud_attempt_count: number;
}

export class ProvisioningObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_metadata(singleton, version)
        VALUES (1, 2);
      CREATE TABLE IF NOT EXISTS challenges (
        challenge_id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        purpose TEXT NOT NULL,
        key_id TEXT NOT NULL,
        binding_digest TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS app_attest_keys (
        key_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        public_key_spki TEXT NOT NULL,
        assertion_counter INTEGER NOT NULL,
        validation_category INTEGER,
        bundle_version TEXT,
        fraud_receipt TEXT NOT NULL,
        fraud_status TEXT NOT NULL,
        fraud_assessed_at INTEGER,
        fraud_attempt_count INTEGER NOT NULL DEFAULT 0,
        fraud_next_attempt_at INTEGER,
        fraud_risk_metric INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        rate_key TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL
      );
    `);
    const schemaVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT version FROM schema_metadata WHERE singleton = 1",
      )
      .toArray()[0]?.version;
    if (schemaVersion === 1) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE app_attest_keys ADD COLUMN fraud_attempt_count INTEGER NOT NULL DEFAULT 0",
      );
      this.ctx.storage.sql.exec(
        "ALTER TABLE app_attest_keys ADD COLUMN fraud_next_attempt_at INTEGER",
      );
      this.ctx.storage.sql.exec(
        "ALTER TABLE app_attest_keys ADD COLUMN fraud_risk_metric INTEGER",
      );
      this.ctx.storage.sql.exec(
        "UPDATE schema_metadata SET version = 2 WHERE singleton = 1",
      );
    }
  }

  async issueChallenge(input: {
    appID: string;
    bindingDigest?: string;
    keyID: string;
    purpose: "key-attestation" | "channel-provision";
  }): Promise<ChallengeResult> {
    const keyReference = await appAttestKeyReference(input.keyID);
    this.pruneChallenges();
    const shardLimit = this.takeRateLimit(
      "shard:challenge",
      10_000,
      60_000,
    );
    if (!shardLimit.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: shardLimit.retryAfter,
      };
    }
    const now = Date.now();
    const challengeCapacity = this.ctx.storage.sql
      .exec<{ count: number; next_expiry: number | null }>(
        `SELECT COUNT(*) AS count, MIN(expires_at) AS next_expiry
         FROM challenges WHERE used_at IS NULL AND expires_at >= ?`,
        now,
      )
      .one();
    if (
      (challengeCapacity?.count ?? 0) >=
      MAX_OUTSTANDING_CHALLENGES_PER_SHARD
    ) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: Math.max(
          1,
          Math.ceil(((challengeCapacity?.next_expiry ?? now) - now) / 1_000),
        ),
      };
    }
    const limit = this.takeRateLimit(
      `challenge:${keyReference}`,
      120,
      60_000,
    );
    if (!limit.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: limit.retryAfter,
      };
    }
    const challengeID = crypto.randomUUID();
    const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = encodeBase64Url(challengeBytes);
    this.ctx.storage.sql.exec(
      `DELETE FROM challenges WHERE key_id = ? AND used_at IS NULL
       AND challenge_id NOT IN (
         SELECT challenge_id FROM challenges WHERE key_id = ?
           AND used_at IS NULL ORDER BY expires_at DESC LIMIT 7
       )`,
      keyReference,
      keyReference,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO challenges(
        challenge_id, challenge, purpose, key_id, binding_digest, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      challengeID,
      challenge,
      input.purpose,
      keyReference,
      input.bindingDigest ?? null,
      Date.now() + CHALLENGE_TTL_MS,
    );
    return {
      ok: true,
      challengeID,
      challenge,
      expiresIn: CHALLENGE_TTL_MS / 1_000,
    };
  }

  async registerKey(input: {
    app: AppConfig;
    appID: string;
    attestation: Uint8Array;
    challengeID: string;
    keyID: string;
  }): Promise<KeyRegistrationResult> {
    const keyReference = await appAttestKeyReference(input.keyID);
    const shardLimit = this.takeRateLimit(
      "shard:attestation",
      2_000,
      60_000,
    );
    if (!shardLimit.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: shardLimit.retryAfter,
      };
    }
    const limit = this.takeRateLimit(
      `attestation:${keyReference}`,
      30,
      60_000,
    );
    if (!limit.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: limit.retryAfter,
      };
    }
    const challenge = this.consumeChallenge(
      input.challengeID,
      "key-attestation",
      keyReference,
    );
    if (!challenge) return { ok: false, code: "invalid_attestation" };
    try {
      const clientDataHash = await sha256(decodeCanonicalBase64Url(challenge.challenge));
      const verified = await verifyAttestation({
        app: input.app,
        appAttestEnvironment: this.env.APP_ATTEST_ENVIRONMENT,
        attestation: input.attestation,
        clientDataHash,
        keyID: input.keyID,
        rootCertificatePem: this.env.APP_ATTEST_ROOT_CERT_PEM,
        teamID: this.env.APNS_TEAM_ID,
      });
      const existing = this.ctx.storage.sql
        .exec<KeyRow>(
          "SELECT app_id, public_key_spki, assertion_counter FROM app_attest_keys WHERE key_id = ?",
          keyReference,
        )
        .toArray()[0];
      if (
        existing &&
        (existing.app_id !== input.appID ||
          existing.public_key_spki !== verified.publicKeySpki)
      ) {
        return { ok: false, code: "invalid_attestation" };
      }
      const initialReceipt = await verifyInitialReceipt({
        app: input.app,
        publicKeySpki: verified.publicKeySpki,
        receipt: verified.receipt,
        rootCertificatePem: this.env.APP_ATTEST_ROOT_CERT_PEM,
        teamID: this.env.APNS_TEAM_ID,
      });
      if (initialReceipt.receiptType !== "ATTEST") {
        return { ok: false, code: "invalid_attestation" };
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO app_attest_keys(
          key_id, app_id, public_key_spki, assertion_counter,
          validation_category, bundle_version, fraud_receipt, fraud_status,
          fraud_assessed_at, fraud_attempt_count, fraud_next_attempt_at,
          fraud_risk_metric, created_at, last_used_at
        ) VALUES (?, ?, ?, 0, ?, ?, ?, 'pending', NULL, 0, ?, NULL, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET
          last_used_at = excluded.last_used_at,
          validation_category = excluded.validation_category,
          bundle_version = excluded.bundle_version`,
        keyReference,
        input.appID,
        verified.publicKeySpki,
        verified.validationCategory ?? null,
        verified.bundleVersion ?? null,
        bytesToBase64(verified.receipt),
        now,
        now,
        now,
      );
      // Exchange and verify the untrusted receipt immediately when Apple is
      // available. Transient failures remain pending and are retried by alarm.
      await this.assessFraud(keyReference);
      const fraudStatus = this.ctx.storage.sql
        .exec<{ fraud_status: FraudStatus }>(
          "SELECT fraud_status FROM app_attest_keys WHERE key_id = ?",
          keyReference,
        )
        .one()?.fraud_status;
      if (!fraudStatus || !isProvisioningEligibleFraudStatus(fraudStatus)) {
        return { ok: false, code: "invalid_attestation" };
      }
      return { ok: true, registered: !existing };
    } catch (error) {
      if (error instanceof AppAttestVerificationError) {
        return { ok: false, code: "invalid_attestation" };
      }
      throw error;
    }
  }

  async verifyProvision(input: {
    app: AppConfig;
    appID: string;
    assertion: Uint8Array;
    bindingDigest: string;
    challengeID: string;
    keyID: string;
  }): Promise<ProvisionResult> {
    const keyReference = await appAttestKeyReference(input.keyID);
    const shardLimit = this.takeRateLimit(
      "shard:assertion",
      10_000,
      60_000,
    );
    if (!shardLimit.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: shardLimit.retryAfter,
      };
    }
    const limit = this.takeRateLimit(
      `assertion:${keyReference}`,
      60,
      60_000,
    );
    if (!limit.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfter: limit.retryAfter,
      };
    }
    const challenge = this.consumeChallenge(
      input.challengeID,
      "channel-provision",
      keyReference,
      input.bindingDigest,
    );
    if (!challenge) return { ok: false, code: "invalid_attestation" };
    const key = this.ctx.storage.sql
      .exec<KeyRow>(
        `SELECT app_id, public_key_spki, assertion_counter, fraud_status
         FROM app_attest_keys WHERE key_id = ?`,
        keyReference,
      )
      .toArray()[0];
    if (
      !key ||
      key.app_id !== input.appID ||
      !isProvisioningEligibleFraudStatus(key.fraud_status)
    ) {
      return { ok: false, code: "invalid_attestation" };
    }
    try {
      const clientDataHash = await sha256(
        concatBytes(
          decodeCanonicalBase64Url(challenge.challenge),
          hexToBytes(input.bindingDigest),
        ),
      );
      const verified = await verifyAssertion({
        app: input.app,
        appAttestEnvironment: this.env.APP_ATTEST_ENVIRONMENT,
        assertion: input.assertion,
        clientDataHash,
        previousCounter: key.assertion_counter,
        publicKeySpki: key.public_key_spki,
        teamID: this.env.APNS_TEAM_ID,
      });
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE app_attest_keys SET assertion_counter = ?,
          validation_category = ?, bundle_version = ?, last_used_at = ?
         WHERE key_id = ? AND assertion_counter = ?`,
        verified.counter,
        verified.validationCategory ?? null,
        verified.bundleVersion ?? null,
        Date.now(),
        keyReference,
        key.assertion_counter,
      );
      if (cursor.rowsWritten !== 1) {
        return { ok: false, code: "invalid_attestation" };
      }
      return { ok: true, provisioned: true };
    } catch (error) {
      if (error instanceof AppAttestVerificationError) {
        return { ok: false, code: "invalid_attestation" };
      }
      throw error;
    }
  }

  private consumeChallenge(
    challengeID: string,
    purpose: string,
    keyID: string,
    bindingDigest?: string,
  ): ChallengeRow | undefined {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<ChallengeRow>(
        `SELECT challenge, purpose, key_id, binding_digest, expires_at, used_at
         FROM challenges WHERE challenge_id = ?`,
        challengeID,
      )
      .toArray()[0];
    if (
      !row ||
      row.used_at !== null ||
      row.expires_at <= Date.now() ||
      row.purpose !== purpose ||
      row.key_id !== keyID ||
      (row.binding_digest ?? undefined) !== bindingDigest
    ) {
      return undefined;
    }
    const update = sql.exec(
      "DELETE FROM challenges WHERE challenge_id = ? AND used_at IS NULL",
      challengeID,
    );
    return update.rowsWritten === 1 ? row : undefined;
  }

  private takeRateLimit(
    rateKey: string,
    maximum: number,
    windowMs: number,
  ): { allowed: true } | { allowed: false; retryAfter: number } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const row = sql
      .exec<{ window_started_at: number; request_count: number }>(
        "SELECT window_started_at, request_count FROM rate_limits WHERE rate_key = ?",
        rateKey,
      )
      .toArray()[0];
    if (!row || now - row.window_started_at >= windowMs) {
      sql.exec(
        `INSERT INTO rate_limits(rate_key, window_started_at, request_count)
         VALUES (?, ?, 1) ON CONFLICT(rate_key) DO UPDATE SET
           window_started_at = excluded.window_started_at, request_count = 1`,
        rateKey,
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
      "UPDATE rate_limits SET request_count = request_count + 1 WHERE rate_key = ?",
      rateKey,
    );
    return { allowed: true };
  }

  private pruneChallenges(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM challenges WHERE expires_at < ?",
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM rate_limits WHERE window_started_at < ?",
      Date.now() - 10 * 60 * 1_000,
    );
  }

  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql
      .exec<{ key_id: string }>(
        `SELECT key_id FROM app_attest_keys
         WHERE fraud_status IN ('pending', 'accepted', 'blocked', 'error')
           AND fraud_next_attempt_at IS NOT NULL
           AND fraud_next_attempt_at <= ?
         ORDER BY fraud_next_attempt_at ASC LIMIT 20`,
        Date.now(),
      )
      .toArray();
    for (const row of due) {
      await this.assessFraud(row.key_id);
    }
    await this.scheduleFraudAlarm();
  }

  private async assessFraud(keyReference: string): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<FraudRow>(
        `SELECT key_id, app_id, public_key_spki, fraud_receipt, fraud_status,
          fraud_attempt_count
         FROM app_attest_keys WHERE key_id = ?`,
        keyReference,
      )
      .toArray()[0];
    if (!row) return;
    const app = getApp(row.app_id);
    if (!app) {
      logFraudAssessment("configuration_error", row.app_id);
      this.markFraudRetry(
        keyReference,
        row.fraud_attempt_count,
        row.fraud_status === "blocked" ? "blocked" : "error",
      );
      return;
    }

    try {
      const token = await getProviderToken(
        this.env.APNS_TEAM_ID,
        this.env.DEVICECHECK_KEY_ID,
        this.env.DEVICECHECK_KEY_P8,
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        const baseURL =
          this.env.APP_ATTEST_ENVIRONMENT === "development"
            ? "https://data-development.appattest.apple.com"
            : "https://data.appattest.apple.com";
        response = await fetch(`${baseURL}/v1/attestationData`, {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/octet-stream",
          },
          body: row.fraud_receipt,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 304) {
        this.markFraudRetry(
          keyReference,
          row.fraud_attempt_count,
          row.fraud_status,
          15 * 60 * 1_000,
        );
        return;
      }
      if (response.status !== 200) {
        logFraudAssessment(
          response.status === 400 || response.status === 404
            ? "receipt_rejected"
            : response.status === 401
              ? "authorization_failed"
              : response.status === 429
                ? "throttled"
                : response.status >= 500
                  ? "upstream_unavailable"
                  : "unexpected_status",
          row.app_id,
        );
        this.markFraudRetry(
          keyReference,
          row.fraud_attempt_count,
          row.fraud_status === "blocked"
            ? "blocked"
            : fraudStatusForHttpFailure(response.status),
        );
        return;
      }

      const updatedReceiptText = (await response.text()).trim();
      const updatedReceipt = decodeCanonicalBase64(updatedReceiptText);
      const claims = await verifyAppAttestReceipt({
        expectedAppID: `${this.env.APNS_TEAM_ID}.${app.bundleID}`,
        expectedPublicKeySpki: row.public_key_spki,
        receipt: updatedReceipt,
        requireRiskMetric: true,
        rootCertificatePem: this.env.APP_ATTEST_ROOT_CERT_PEM,
      });
      if (claims.receiptType !== "RECEIPT") {
        throw new Error("Invalid refreshed App Attest receipt");
      }
      const status =
        claims.riskMetric! > app.appAttest.maxFraudRiskMetric
          ? "blocked"
          : "accepted";
      if (status === "blocked") {
        logFraudAssessment("risk_blocked", row.app_id);
      }
      const refreshAt = Math.max(
        Date.now() + 60_000,
        claims.notBefore ?? Date.now() + 24 * 60 * 60 * 1_000,
      );
      this.ctx.storage.sql.exec(
        `UPDATE app_attest_keys SET fraud_receipt = ?, fraud_status = ?,
          fraud_assessed_at = ?, fraud_attempt_count = 0,
          fraud_next_attempt_at = ?, fraud_risk_metric = ?
         WHERE key_id = ?`,
        updatedReceiptText,
        status,
        Date.now(),
        refreshAt,
        claims.riskMetric!,
        keyReference,
      );
      await this.scheduleFraudAlarm();
    } catch {
      logFraudAssessment("exchange_or_verification_failed", row.app_id);
      this.markFraudRetry(
        keyReference,
        row.fraud_attempt_count,
        row.fraud_status === "blocked" ? "blocked" : "pending",
      );
    }
  }

  private markFraudRetry(
    keyReference: string,
    previousAttempts: number,
    status: FraudStatus,
    fixedDelay?: number,
  ): void {
    const attempts = previousAttempts + 1;
    const delay =
      fixedDelay ??
      Math.min(
        24 * 60 * 60 * 1_000,
        60_000 * 2 ** Math.min(attempts - 1, 10),
      );
    this.ctx.storage.sql.exec(
      `UPDATE app_attest_keys SET fraud_status = ?,
        fraud_attempt_count = ?, fraud_next_attempt_at = ?
       WHERE key_id = ?`,
      status,
      attempts,
      Date.now() + delay,
      keyReference,
    );
    this.ctx.waitUntil(this.scheduleFraudAlarm());
  }

  private async scheduleFraudAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ fraud_next_attempt_at: number }>(
        `SELECT fraud_next_attempt_at FROM app_attest_keys
         WHERE fraud_status IN ('pending', 'accepted', 'blocked', 'error')
           AND fraud_next_attempt_at IS NOT NULL
         ORDER BY fraud_next_attempt_at ASC LIMIT 1`,
      )
      .toArray()[0]?.fraud_next_attempt_at;
    if (next !== undefined) {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next));
    }
  }
}

export function isProvisioningEligibleFraudStatus(
  status: string,
): boolean {
  return status === "accepted" || status === "pending";
}

export function fraudStatusForHttpFailure(status: number): FraudStatus {
  return status === 429 || status >= 500 ? "pending" : "error";
}

async function verifyInitialReceipt(input: {
  app: AppConfig;
  publicKeySpki: string;
  receipt: Uint8Array;
  rootCertificatePem: string;
  teamID: string;
}): Promise<AppAttestReceiptClaims> {
  try {
    return await verifyAppAttestReceipt({
      expectedAppID: `${input.teamID}.${input.app.bundleID}`,
      expectedPublicKeySpki: input.publicKeySpki,
      receipt: input.receipt,
      requireRiskMetric: false,
      rootCertificatePem: input.rootCertificatePem,
    });
  } catch {
    throw new AppAttestVerificationError();
  }
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", value.slice().buffer as ArrayBuffer),
  );
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2}){32}$/.test(value)) throw new Error("digest");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Invalid App Attest receipt");
  }
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  if (bytesToBase64(bytes) !== value) {
    throw new Error("Invalid App Attest receipt");
  }
  return bytes;
}

function logFraudAssessment(
  outcome:
    | "authorization_failed"
    | "configuration_error"
    | "exchange_or_verification_failed"
    | "receipt_rejected"
    | "risk_blocked"
    | "throttled"
    | "unexpected_status"
    | "upstream_unavailable",
  appID: string,
): void {
  console.warn(
    JSON.stringify({
      schema: "apnw.app_attest_fraud.v1",
      operation: "fraud_assessment",
      outcome,
      ...(getApp(appID) ? { appID } : {}),
    }),
  );
}

async function appAttestKeyReference(keyID: string): Promise<string> {
  const normalized = keyID
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(keyID.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(normalized), (character) =>
    character.charCodeAt(0),
  );
  if (bytes.byteLength !== 32) throw new AppAttestVerificationError();
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      bytes.slice().buffer as ArrayBuffer,
    ),
  );
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
