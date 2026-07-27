# Observability runbook

APNW emits one privacy-reviewed completion log for every request and one
best-effort Analytics Engine point. Telemetry is operational, not user
analytics. There is no public analytics API.

## Privacy boundary

Completion logs may contain an app ID, operation, result, service version,
request ID, aggregate delivery counts, allowlisted APNs category, APNs request
ID, and a short pseudonymous channel reference. Analytics contains only bounded
service dimensions and aggregate counts.

Neither sink may contain capabilities, authorization headers, device tokens,
installation IDs, routes, request bodies, notification copy, payloads, source
IP addresses added by APNW, or application-domain identifiers. Treat changes to
`src/observability` as privacy-sensitive changes.

## Initial manual thresholds

These are deliberately conservative starting points. Revisit them after there
is enough normal traffic to establish a baseline.

- Investigate APNs failure rates above 5% over 15 minutes when there are at
  least 20 targeted notifications.
- Investigate Worker `5xx` rates above 1% over 15 minutes when there are at
  least 50 requests.
- Investigate p95 API latency above 2 seconds over 15 minutes.
- Investigate a drop to zero publish events for 24 hours only when the
  application would normally publish during that period.
- Investigate repeated `invalid_provider_token`, `expired_provider_token`, or
  `topic_error` immediately; they usually indicate configuration rather than a
  recipient-device problem.

## Triage order

1. Check `/health` on the affected environment.
2. Check the `versions.sql` query for a deployment-correlated regression.
3. Tail reviewed custom logs and filter by operation, outcome, request ID, or
   pseudonymous channel reference.
4. Use `apns-errors.sql` to separate provider configuration, APNs availability,
   throttling, and stale-device failures.
5. Roll back if the problem correlates with a new Worker version.
6. Rotate the APNs key only for a suspected credential problem or compromise.

Workers Logs and Analytics Engine retention are controlled by the Cloudflare
plan. APNW does not copy telemetry into Durable Objects, KV, D1, or R2.
