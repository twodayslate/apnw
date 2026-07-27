import type { SchemaMigration } from "../storage/schema";

// This is the first deployable schema. Future changes must increment the
// version and add one sequential migration for every deployed version.
export const PROVISIONING_SCHEMA_VERSION = 1;

export const PROVISIONING_SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [];

export const PROVISIONING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO schema_metadata(singleton, version)
    VALUES (1, ${PROVISIONING_SCHEMA_VERSION});
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
`;
