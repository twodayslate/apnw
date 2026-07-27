# Observability runbook

APNW emits one privacy-reviewed completion log per HTTP request and one
best-effort Analytics Engine point. Cloudflare Queue and Durable Object built-in
metrics cover asynchronous delivery. Telemetry is operational, not user
analytics, and there is no public analytics API.

## Privacy boundary

Custom logs may contain:

- registered app ID and bounded operation/outcome enums;
- random request ID and service version;
- aggregate delivery counts for operator-only direct-delivery diagnostics;
- allowlisted APNs category/status/request UUID;
- a 16-hex-character channel reference keyed by
  `LOG_CORRELATION_KEY` and the current UTC date.

The daily reference cannot be used to follow one channel across days. Analytics
Engine contains bounded service dimensions and aggregate measures only; it does
not contain the channel reference or request ID.

Neither sink may contain capabilities, authorization headers, App Attest key
IDs/public keys/assertions/attestations/receipts/challenges, APNs tokens,
installation IDs, request bodies, notification copy, payloads, CloudKit or
pairing identifiers, routes, or source IPs added by APNW.

All free-form-looking dimensions pass runtime character/length allowlists.
Unexpected APNs response strings map to `upstream_unknown`; unexpected
telemetry dimensions map to `invalid_dimension`.

Treat changes under `src/observability` as privacy-sensitive.

## Initial thresholds

- Alert immediately on `environment_mismatch`, `invalid_provider_token`,
  `expired_provider_token`, or `topic_error`.
- Alert whenever the delivery or cleanup circuit activates.
- Investigate repeated App Attest receipt exchange, verification, or
  DeviceCheck authorization failures; never include the receipt or key in the
  alert.
- Investigate APNs nonrecipient failures above 5% over five minutes after at
  least 10 attempts.
- Investigate Worker `5xx` above 1% over 15 minutes after 50 requests.
- Investigate p95 HTTP latency above 2 seconds over 15 minutes.
- Alert when the delivery queue's oldest message exceeds five minutes.
- Alert on any delivery DLQ message. A DLQ is a data-loss precursor, not routine
  retry storage.
- A Channel Durable Object redrives a batch that remains `enqueued` for one hour.
  Investigate and drain the corresponding DLQ copy after the incident; replaying
  it later is safe because completed batches acknowledge without redelivery.
- Investigate Durable Object overload or queue backlog growth even when HTTP
  acceptance remains healthy.
- Investigate unexpected zero publish traffic only when the app normally
  publishes in that period.

Tune thresholds after establishing a baseline; do not raise provider or DLQ
alerts merely to suppress noise.

## Triage

1. Check `/health` on the affected custom domain.
2. Confirm the deployed version and all three environment declarations.
3. Check Worker `5xx`, Durable Object errors, queue depth/age/retries, and DLQ.
4. Use `analytics/versions.sql` for a deployment-correlated regression.
5. Filter custom logs by operation, bounded outcome, request ID, or same-day
   channel reference.
6. Use `analytics/apns-errors.sql` to separate provider configuration, APNs
   availability, throttling, and recipient-token failures.
7. For cleanup circuit events, verify APNs host, topic, key environment, and the
   affected app version before allowing the five-minute suspension to expire.
8. Confirm stale batches are being redriven by their Channel Durable Objects,
   then drain or replay DLQ copies only after identifying the cause. Delivery
   batches are idempotent, but blind replay can preserve an outage.
9. Roll back when the issue correlates with a release.
10. Rotate an Apple key only for compromise, revocation, or confirmed
    credential/environment failure.

## Sampling and failure behavior

Production samples successful custom completion logs at 10% and retains all
`4xx`/`5xx` completion logs. Analytics Engine remains best effort and may sample
internally. Production automatic invocation logs are disabled.

Telemetry write failures never alter an API, queue, or APNs outcome. The fallback
warning contains only schema, operation, bounded outcome, and random request ID.
An invalid or unavailable log-correlation key omits the daily channel reference
and emits the same kind of bounded warning; it does not block channel routing or
delivery.

Retention is controlled by the Cloudflare plan. APNW does not copy logs or
analytics into Durable Objects, KV, D1, R2, or another history store.
