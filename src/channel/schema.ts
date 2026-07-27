export const CHANNEL_SCHEMA_VERSION = 1;

export const CHANNEL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO schema_metadata(singleton, version)
    VALUES (1, ${CHANNEL_SCHEMA_VERSION});

  CREATE TABLE IF NOT EXISTS devices (
    installation_id TEXT PRIMARY KEY,
    device_token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    idempotency_key TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    event_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    device_count INTEGER NOT NULL DEFAULT 0,
    accepted INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    invalid_removed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS event_deliveries (
    idempotency_key TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'attempting', 'accepted', 'permanent', 'transient', 'unknown')
    ),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (idempotency_key, installation_id)
  );

  CREATE INDEX IF NOT EXISTS event_deliveries_status
    ON event_deliveries(idempotency_key, status);

  CREATE TABLE IF NOT EXISTS channel_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    closed_at INTEGER
  );

  INSERT OR IGNORE INTO channel_state(singleton, closed_at) VALUES (1, NULL);

  CREATE TABLE IF NOT EXISTS rate_limits (
    operation TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL,
    request_count INTEGER NOT NULL
  );
`;
