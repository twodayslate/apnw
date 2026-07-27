export const CHANNEL_SCHEMA_VERSION = 2;

export const CHANNEL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO schema_metadata(singleton, version)
    VALUES (1, ${CHANNEL_SCHEMA_VERSION});

  CREATE TABLE IF NOT EXISTS devices (
    installation_id TEXT PRIMARY KEY,
    installation_capability_digest TEXT NOT NULL,
    device_token TEXT NOT NULL UNIQUE,
    token_version INTEGER NOT NULL,
    token_registered_at INTEGER NOT NULL,
    suspect_count INTEGER NOT NULL DEFAULT 0,
    quarantined_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    idempotency_key TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    event_name TEXT NOT NULL,
    client_created_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    state TEXT NOT NULL CHECK (
      state IN ('accepted', 'delivering', 'completed')
    ),
    delivery_mode TEXT NOT NULL CHECK (
      delivery_mode IN ('direct', 'queued')
    ),
    device_count INTEGER NOT NULL DEFAULT 0,
    accepted INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    invalid_removed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS event_deliveries (
    idempotency_key TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    token_version INTEGER NOT NULL,
    batch_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'attempting', 'accepted', 'permanent', 'transient', 'unknown')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (idempotency_key, installation_id)
  );

  CREATE INDEX IF NOT EXISTS event_deliveries_status
    ON event_deliveries(idempotency_key, batch_id, status);

  CREATE TABLE IF NOT EXISTS delivery_batches (
    idempotency_key TEXT NOT NULL,
    batch_id INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'enqueued', 'processing', 'completed')
    ),
    retry_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (idempotency_key, batch_id)
  );

  CREATE TABLE IF NOT EXISTS channel_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    provisioned_at INTEGER,
    admin_capability_digest TEXT,
    closed_at INTEGER
  );

  INSERT OR IGNORE INTO channel_state(
    singleton, provisioned_at, admin_capability_digest, closed_at
  ) VALUES (1, NULL, NULL, NULL);

  CREATE TABLE IF NOT EXISTS rate_limits (
    operation TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL,
    request_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS apns_health (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    window_started_at INTEGER NOT NULL,
    request_count INTEGER NOT NULL,
    failure_count INTEGER NOT NULL,
    circuit_open_until INTEGER,
    cleanup_candidate_count INTEGER NOT NULL,
    cleanup_suspended_until INTEGER
  );

  INSERT OR IGNORE INTO apns_health(
    singleton, window_started_at, request_count, failure_count,
    circuit_open_until, cleanup_candidate_count, cleanup_suspended_until
  ) VALUES (1, 0, 0, 0, NULL, 0, NULL);
`;

export const MIGRATE_CHANNEL_V1_TO_V2 = `
  ALTER TABLE devices ADD COLUMN installation_capability_digest TEXT NOT NULL DEFAULT '';
  ALTER TABLE devices ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE devices ADD COLUMN token_registered_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE devices ADD COLUMN suspect_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE devices ADD COLUMN quarantined_at INTEGER;

  ALTER TABLE events ADD COLUMN client_created_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE events ADD COLUMN app_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE events ADD COLUMN state TEXT NOT NULL DEFAULT 'completed';
  ALTER TABLE events ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct';

  ALTER TABLE event_deliveries ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE event_deliveries ADD COLUMN batch_id INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE event_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

  ALTER TABLE channel_state ADD COLUMN provisioned_at INTEGER;
  ALTER TABLE channel_state ADD COLUMN admin_capability_digest TEXT;

  DROP INDEX IF EXISTS event_deliveries_status;
  UPDATE schema_metadata SET version = 2 WHERE singleton = 1;
`;
