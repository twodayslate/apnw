# APNW implementation plan

APNW (Apple Push Notification Worker) is a lightweight, multi-app APNs provider
implemented with Cloudflare Workers and SQLite-backed Durable Objects.

## Goals

- Support multiple iOS apps from one Worker codebase.
- Send visible APNs notifications without adding a third-party SDK to an app.
- Keep deployment and ongoing operations small enough for one developer.
- Keep notification payloads generic and controlled by the server.
- Store only the device and delivery metadata required to operate the service.
- Isolate apps, APNs environments, and notification channels from one another.
- Collect privacy-bounded operational logs and aggregate delivery analytics from
  the first production release.
- Fit small private collaboration apps first, while leaving a path to queues and
  higher-volume delivery later.

## Non-goals for v1

- Marketing analytics, user profiling, segmentation, or A/B testing.
- A public or end-user-facing analytics API or dashboard.
- Email, SMS, Android, or web push.
- A public topic directory, message-history API, or end-user dashboard.
- Arbitrary client-provided notification titles or bodies.
- Rich-media attachments or notification action buttons.
- Treating possession of a channel capability as proof of a real-world identity.
- Large broadcast topics. A channel is expected to contain a small number of
  devices.

## Deployment shape

Use one repository and deploy the same code twice:

| Deployment | APNs endpoint | Intended builds |
| --- | --- | --- |
| `apnw-dev` | `api.sandbox.push.apple.com` | Xcode development builds |
| `apnw-prod` | `api.push.apple.com` | TestFlight and App Store builds |

Development and production must use separate Durable Object namespaces. Device
tokens are scoped to an app and APNs environment and must never be copied between
the deployments.

Suggested public endpoints:

```text
https://push-dev.example.com
https://push.example.com
```

The initial deployment assumes all registered apps belong to one Apple Developer
team. One team-scoped APNs signing key can authenticate pushes for multiple bundle
IDs. APNW selects the destination app by setting the request's `apns-topic` header
to that app's bundle ID.

Supporting apps owned by another Apple Developer team is a later extension. It
requires a separate Team ID, Key ID, private key secret, and JWT cache entry for
each team.

## Architecture

```text
iOS app
  |
  | HTTPS: register, unregister, publish
  v
Cloudflare Worker
  |
  | Validate app, capability, request, and event template
  v
Channel Durable Object
  |
  | Read subscribed device tokens and enforce idempotency
  v
APNs HTTP/2 API
  |
  v
Recipient Apple devices
```

There is one Durable Object per app and private notification channel. The Worker
derives its internal object name from:

```text
HMAC-SHA256(serverChannelKey, appID + ":" + channelCapability)
```

The raw channel capability is sent only in the `Authorization` header and is
never placed in a URL, Durable Object name, database row, response, or log.

This is a capability-based security model: anyone possessing a channel capability
may register a device, remove their device, or request one of that app's allowed
notification events. For Chain of Custody, the capability will be distributed
inside the pairing's encrypted CloudKit payload.

## Multi-app configuration

Use a checked-in registry for nonsecret configuration:

```ts
export const apps = {
  chain_of_custody: {
    bundleID: "com.twodayslate.coc",
    routeSchemes: ["coc"],
    templates: {
      check_requested: {
        title: "CoC update",
        body: "A new response is requested."
      },
      assignment_available: {
        title: "CoC update",
        body: "A new assignment is available."
      },
      submission_ready: {
        title: "CoC update",
        body: "A response is ready for review."
      },
      decision_available: {
        title: "CoC update",
        body: "A response decision is available."
      },
      release_requested: {
        title: "CoC update",
        body: "A release request is ready for review."
      },
      pause_requested: {
        title: "CoC update",
        body: "A pause request is ready for review."
      }
    }
  }
} as const;
```

Adding an app should require:

1. Enabling Push Notifications for its App ID.
2. Adding its bundle ID and allowed templates to the registry.
3. Adding app-specific request and payload tests.
4. Deploying the existing Worker code.

Unknown app IDs and event names return `404` so the API does not reveal which
part of a request was valid.

## Cloudflare secrets

Store these as Worker secrets, never repository variables:

| Secret | Purpose |
| --- | --- |
| `APNS_KEY_P8` | Base64-encoded APNs private key |
| `APNS_KEY_ID` | Apple APNs signing key identifier |
| `APNS_TEAM_ID` | Apple Developer team identifier |
| `CHANNEL_HMAC_KEY` | Derives opaque Durable Object identifiers |

Nonsecret deployment configuration:

| Variable | Values |
| --- | --- |
| `APNS_ENVIRONMENT` | `development` or `production` |
| `SERVICE_VERSION` | Release identifier exposed by health checks |

Use different `CHANNEL_HMAC_KEY` values for development and production.

Bind a Workers Analytics Engine dataset named `APNW_ANALYTICS` in both
deployments. Development and production use separate datasets.

## HTTP API

All mutation endpoints require:

```http
Authorization: Bearer <channel-capability>
Content-Type: application/json
```

Capabilities must contain at least 256 bits of cryptographically random data.
Reject malformed or oversized credentials before accessing a Durable Object.

### Health

```http
GET /health
```

Returns only service status, deployment environment, and version. It must not
return app names, bundle IDs, channel counts, device counts, or APNs credentials.

### Register a device

```http
PUT /v1/apps/{appID}/devices/{installationID}
Authorization: Bearer <channel-capability>
Content-Type: application/json

{
  "deviceToken": "<APNs token>"
}
```

- `installationID` is a random identifier generated once per app installation.
- Do not assume APNs tokens have a permanently fixed byte length.
- Require hexadecimal encoding, a reasonable maximum length, and a nonempty
  decoded value.
- Registration is idempotent.
- If an installation receives a new APNs token, replace its previous token.
- A token may be registered to more than one private channel when the app
  participates in more than one collaboration.

### Unregister a device

```http
DELETE /v1/apps/{appID}/devices/{installationID}
Authorization: Bearer <channel-capability>
```

The response is successful whether or not the installation was registered.

### Publish an event

```http
POST /v1/apps/{appID}/events
Authorization: Bearer <channel-capability>
Idempotency-Key: <stable-event-id>
Content-Type: application/json

{
  "event": "submission_ready",
  "excludeInstallationID": "<sender-installation-id>",
  "route": "coc://submission/..."
}
```

- The Worker maps `event` to a checked-in title and body.
- Clients cannot submit notification copy, APNs headers, images, or actions.
- Validate the route scheme against the selected app's allowlist.
- Limit route length and omit it entirely when invalid.
- Exclude only the current sending installation. Other devices owned by the
  sender may still receive the update.
- Require an idempotency key and bound its size.
- Return aggregate delivery counts, never device tokens.

Example response:

```json
{
  "eventID": "7fb31c36-...",
  "deviceCount": 2,
  "accepted": 2,
  "failed": 0
}
```

### Close a channel

```http
DELETE /v1/apps/{appID}/channel
Authorization: Bearer <channel-capability>
```

Closing removes registered devices and leaves a tombstone that permanently
rejects the old capability. A replacement channel uses a newly generated
capability.

In the v1 cooperative capability model, any participant holding the capability
can close the channel. Strong owner-only revocation would require a separate
identity or administrator-capability design and is intentionally deferred.

## Durable Object data model

Use one SQLite-backed Durable Object class for every app/channel pair.

```sql
CREATE TABLE devices (
  installation_id TEXT PRIMARY KEY,
  device_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX devices_token
ON devices(device_token);

CREATE TABLE events (
  idempotency_key TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  device_count INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  failed INTEGER NOT NULL
);

CREATE TABLE channel_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  closed_at INTEGER
);
```

Do not store:

- Notification title, body, or route.
- CloudKit record identifiers.
- Pairing identifiers, labels, roles, or participant identities.
- APNs request payloads.
- Raw channel capabilities.

Retain bounded idempotency metadata only. Start with a maximum of 1,000 event
rows or 30 days, whichever is smaller, and prune after successful publishes.

## APNs provider behavior

- Generate an ES256 provider JWT using the configured Team ID and Key ID.
- Cache a JWT for no more than 50 minutes.
- Select the APNs host exclusively from deployment configuration.
- Set `apns-topic` from the selected app registry entry.
- Set `apns-push-type: alert`.
- Use `apns-priority: 10` for normal visible events.
- Use a conservative expiration appropriate for a synchronization nudge.
- Include only the server-controlled alert and validated route metadata.
- Generate and log an internal request ID, not a device token.
- Remove registrations when APNs returns `410`, `BadDeviceToken`, or
  `Unregistered`.
- Treat `429` and APNs `5xx` responses as transient.
- Never delete a device token because it was sent to the wrong APNs environment;
  environment separation should make that state impossible.

For v1, publish synchronously because collaboration channels are expected to
contain far fewer than the Workers Free plan's external-subrequest limit.
Introduce Cloudflare Queues before supporting broadcast channels or more than
40 target devices per publish.

## Logging and analytics requirements

Observability is a v1 feature, even though APNW does not expose an analytics API
or dashboard. Use two complementary sinks:

1. **Workers Logs** for short-retention, structured operational events used to
   diagnose individual requests and failures.
2. **Workers Analytics Engine** for three months of aggregate, queryable service
   and delivery metrics.

Enable custom Workers Logs in both deployments. Start at 100% sampling because
initial volume is expected to be low, but make the sampling rate configurable.
Disable automatic invocation logs in production and emit an intentional,
privacy-reviewed custom log for each completed request instead.

### Structured operational logs

Every request log uses a stable schema:

```json
{
  "schema": 1,
  "timestamp": "2026-07-26T12:00:00.000Z",
  "level": "info",
  "operation": "publish",
  "requestID": "opaque-request-id",
  "serviceVersion": "git-sha-or-release",
  "deployment": "production",
  "appID": "chain_of_custody",
  "outcome": "accepted",
  "httpStatus": 200,
  "durationMs": 83
}
```

Publish logs additionally record:

- Event-template name.
- Target, accepted, failed, and invalid-token-removal counts.
- Idempotency outcome (`new`, `duplicate`, or `retry`).
- APNs response status and allowlisted reason category.
- APNs request ID when Apple provides one.
- Total and maximum APNs request latency.
- An optional short, pseudonymous channel reference derived from the already
  opaque internal Durable Object identifier. It is retained only in operational
  logs and never written to aggregate analytics.

Registration, unregistration, channel closure, authentication rejection,
validation rejection, rate limiting, and unhandled exceptions must also produce
structured events.

Logs must never contain:

- Authorization headers or channel capabilities.
- APNs device tokens or installation IDs.
- Notification routes, request bodies, or APNs payloads.
- CloudKit, pairing, record, participant, or user identifiers.
- Notification titles or bodies, even though templates are generic.
- Source IP addresses added by APNW application code.
- Raw exception objects or upstream response bodies that have not been
  explicitly sanitized.

Log only known APNs error categories. Unknown upstream responses become
`upstream_unknown`; do not serialize arbitrary response content.

### Aggregate analytics

Write Analytics Engine data points for:

- HTTP request count, status class, outcome, and latency by app, deployment,
  operation, service version, and Cloudflare colo.
- Registrations, token replacements, unregistrations, and channel closures.
- Authentication, validation, rate-limit, and internal-error counts.
- Publish event count by app and event-template name.
- Target, accepted, failed, and stale-token-removal counts.
- APNs latency and error counts grouped by allowlisted reason category.
- Idempotency duplicate and retry counts.

Use `appID` as the Analytics Engine index. Use bounded enums in blob fields and
numeric counters or timings in double fields. Do not write a channel reference,
device identifier, request ID, route, capability, token, or other per-user value
to Analytics Engine.

Analytics writes must be best-effort and must never change the API response or
push-delivery result. A telemetry failure may emit one sanitized operational
warning, but must not recursively attempt additional analytics writes.

### Retention and access

- Workers Logs use Cloudflare's plan-defined short retention: currently three
  days on Workers Free and up to seven days on Workers Paid.
- Analytics Engine retains data for three months.
- APNW itself does not copy logs or analytics to Durable Objects, KV, D1, or R2.
- Access remains limited to authorized maintainers in the Cloudflare account.
- Longer retention or third-party export requires a separate privacy and cost
  decision; it is not part of v1.

Check in a small set of documented Analytics Engine SQL queries for:

- Delivery acceptance and failure rate by app and day.
- APNs error categories over time.
- p50/p95 API and APNs latency.
- Registration and unregistration activity.
- Authentication, validation, and rate-limit rejection trends.
- Idempotency duplicate/retry trends.
- Results grouped by deployed service version to detect regressions.

Define initial operational thresholds in the runbook, including elevated APNs
failure rate, elevated Worker `5xx` rate, and an unexpected drop to zero publish
events. Automated paging is not required for v1, but the queries and thresholds
must be ready for manual monitoring.

## Error and retry semantics

- Invalid input or credentials: do not retry automatically.
- Duplicate idempotency key: return the stored aggregate result without
  delivering again.
- Partial APNs failure: return a retryable response and enough aggregate state
  for the client outbox to retry safely.
- Worker/APNs unavailable: return `503` with `Retry-After`.
- Apply exponential backoff with jitter in client integrations.
- Preserve notification requests in a durable client outbox until APNW accepts
  them or they expire.

The event table may need per-installation attempt state if partial retries cause
duplicate delivery during implementation. Resolve this before declaring delivery
idempotency complete; aggregate-only rows are insufficient for retrying only
failed devices.

## Security and privacy requirements

- Authenticate every endpoint that accesses channel or device state.
- Do not implement a public topic list, registry, statistics API, WebSocket, or
  message-history endpoint.
- Do not embed a global publishing secret in any client app.
- Never accept arbitrary notification copy from a client.
- Keep capabilities in authorization headers, not URL paths or query strings.
- Enforce small request-body and header-size limits.
- Reject unknown JSON fields on security-sensitive requests.
- Use constant-time comparisons anywhere secret values are compared.
- Rate-limit by app, channel object, and source IP where practical.
- Ensure CORS is absent by default; native clients do not need wildcard CORS.
- Do not log authorization headers, APNs tokens, routes, request bodies, or APNs
  payloads.
- Disable automatic production invocation logs and use only the reviewed
  structured application-log schema.
- Keep aggregate analytics free of channel-, device-, request-, pairing-, and
  user-level identifiers.
- Treat logging and analytics schema changes as privacy-sensitive API changes.
- Return opaque errors for authentication and unknown-resource failures.
- Pin dependencies and enable automated dependency updates.
- Add a documented APNs key-rotation procedure before production launch.

### Known v1 trust boundary

The Worker cannot independently read or validate membership in a private/shared
CloudKit database. Possession of a high-entropy channel capability is therefore
authorization to interact with that channel.

This is appropriate for a cooperative application using generic payloads, but it
does not prevent an authorized participant from:

- Registering another device to a channel.
- Requesting allowed notification event types.
- Closing the shared channel.

If that threat becomes unacceptable, add App Attest plus user-specific,
server-issued capabilities or introduce a separate identity service.

## Chain of Custody integration

The server remains generic; these changes occur in the Chain of Custody app:

1. Generate a 256-bit notification-channel capability when creating a pairing.
2. Store it only in the pairing's encrypted CloudKit payload.
3. Add a schema-compatible migration for existing pairings without a capability.
4. Generate and retain a random installation ID in the shared App Group.
5. Capture APNs device-token callbacks in the main application delegate.
6. Register the installation with every active pairing channel after permission
   and token acquisition.
7. Re-register when APNs rotates the token, the iCloud account changes, or active
   pairings change.
8. Unregister when leaving or blocking a pairing.
9. Close and replace the channel when access is revoked.
10. After a CloudKit mutation succeeds, add the corresponding APNW event to a
    persistent local outbox.
11. Let both the main app and Messages extension enqueue events through the App
    Group; only shared transport code should deliver the outbox.
12. Include no user-authored content in APNW requests.
13. On notification tap, validate the route and fetch current CloudKit state
    before presenting anything.
14. Keep the existing CKSyncEngine notification path as a synchronization
    fallback and deduplicate local/remote alerts.

APNW is a notification nudge, not the source of truth. CloudKit remains the
authoritative store for every domain event.

## Project structure

```text
apnw/
├── README.md
├── Plan.md
├── package.json
├── tsconfig.json
├── wrangler.jsonc
├── src/
│   ├── index.ts
│   ├── apps.ts
│   ├── auth.ts
│   ├── validation.ts
│   ├── observability/
│   │   ├── analytics.ts
│   │   ├── logger.ts
│   │   └── schema.ts
│   ├── apns/
│   │   ├── client.ts
│   │   ├── jwt.ts
│   │   └── payload.ts
│   └── channel/
│       ├── ChannelObject.ts
│       └── schema.ts
└── test/
    ├── api.test.ts
    ├── auth.test.ts
    ├── multi-app.test.ts
    ├── apns.test.ts
    ├── channel.test.ts
    └── observability.test.ts
```

## Implementation phases

### Phase 1: Scaffold and APNs core

- Create the TypeScript Worker project and local test harness.
- Add typed environment bindings and the multi-app registry.
- Implement ES256 APNs JWT generation and bounded caching.
- Implement payload templates and APNs request construction.
- Add the structured logger and Analytics Engine binding.
- Define versioned telemetry schemas and make analytics writes best-effort.
- Mock APNs in tests; do not require a real Apple key for the test suite.

Exit criteria:

- Tests prove that two apps select different `apns-topic` headers.
- Tests prove that development and production deployments select the correct
  APNs hosts.
- No secret or device token appears in structured logs or thrown errors.
- Every request path produces one schema-valid completion log.
- Telemetry failures do not affect APNs or API outcomes.

### Phase 2: Private channels

- Add capability validation and HMAC-derived Durable Object routing.
- Add the SQLite schema and device registration lifecycle.
- Add server-controlled event publishing.
- Exclude the sender installation.
- Remove invalid APNs tokens.
- Implement closed-channel tombstones.
- Instrument registration, unregistration, publishing, cleanup, idempotency, and
  channel-closure outcomes.

Exit criteria:

- Apps and channels cannot collide even when their human-readable IDs match.
- Invalid capabilities cannot read or mutate channel state.
- Duplicate registration and unregistration are safe.
- A closed capability cannot recreate its channel.
- Operational logs can correlate a channel failure without revealing a channel
  capability or application-domain identifier.

### Phase 3: Reliability and hardening

- Add idempotency and bounded retention.
- Resolve partial-delivery retry behavior.
- Add request limits, rate limits, and opaque errors.
- Add APNs key-rotation and incident-response documentation.
- Add deployment smoke tests and health checks.
- Check in Analytics Engine SQL queries and the observability runbook.
- Document retention, access, sampling, and initial monitoring thresholds.
- Verify behavior at Cloudflare Free plan limits.

Exit criteria:

- Repeating an accepted event never produces a second delivery.
- Transient APNs failures can be retried without redelivering to successful
  targets.
- Malformed and oversized requests fail before Durable Object access.
- The production deployment exposes no state-listing or history endpoints.
- Delivery rate, error category, latency, registration activity, rejection
  trends, idempotency behavior, and service-version regressions can be queried
  without per-user analytics.

### Phase 4: Chain of Custody integration

- Add device-token capture and App Group persistence.
- Add pairing capabilities and migration behavior.
- Add device registration reconciliation.
- Add the persistent notification outbox.
- Map domain changes to APNW's fixed event types.
- Add route handling and notification deduplication.

Exit criteria:

- Two physical devices using different Apple Accounts receive the correct
  neutral alerts.
- The originating installation does not alert itself.
- Offline CloudKit mutations eventually generate one APNW event after syncing.
- Leaving, blocking, revocation, token rotation, reinstall, and iCloud account
  changes do not leave an unintended active registration.
- No user-authored or decrypted CloudKit content reaches Cloudflare or APNs.

### Phase 5: Production deployment

- Create separate Cloudflare development and production resources.
- Configure custom domains and secrets.
- Create or select a team-scoped APNs key and document recovery/rotation.
- Deploy development and verify with an Xcode-signed physical-device build.
- Deploy production and verify with TestFlight.
- Add basic uptime monitoring for `/health`.
- Verify Workers Logs and Analytics Engine data in both environments.
- Confirm production invocation logs are disabled and custom structured logs are
  enabled.
- Execute every checked-in analytics query against production smoke-test data.
- Record rollback and channel-cleanup procedures.

Exit criteria:

- Development tokens work only through the development deployment.
- TestFlight tokens work only through the production deployment.
- APNs invalid-token cleanup is observed without exposing token values.
- A production push produces the expected structured log and aggregate data
  point without recording prohibited fields.
- Deployment and rollback can be completed from the repository instructions.

## Required tests

### Unit and Worker integration tests

- App registry lookup and unknown-app behavior.
- Cross-app and cross-channel Durable Object isolation.
- Capability length, encoding, HMAC derivation, and redaction.
- APNs JWT claims, encoding, signing, cache reuse, and expiration.
- Sandbox and production endpoint selection.
- `apns-topic` selection for every app.
- Payload template allowlisting and route validation.
- Registration, token replacement, unregistration, and sender exclusion.
- `410`, `BadDeviceToken`, and `Unregistered` cleanup.
- `429` and `5xx` retry behavior.
- Idempotency and partial-delivery retries.
- Channel closure and tombstone enforcement.
- Retention pruning.
- Request-size limits and unknown JSON fields.
- Confirmation that state-listing/history routes do not exist.
- Structured-log schema coverage for every endpoint and important failure path.
- Redaction tests using capabilities, device tokens, installation IDs, routes,
  request bodies, APNs payloads, and malicious upstream error strings.
- Analytics dimensions and measures for every required metric.
- Confirmation that aggregate data contains no high-cardinality user, channel,
  request, route, or device values.
- Confirmation that log/analytics failures never alter API or delivery results.
- Telemetry schema-version compatibility.

### Manual verification

- Xcode development build against `apnw-dev` on two physical devices.
- TestFlight build against `apnw-prod` on two physical devices.
- Foreground, background, terminated, offline, and notification-disabled states.
- APNs token rotation/reinstallation behavior.
- Notification tap routing after the underlying CloudKit record changes or is
  deleted.

Push delivery cannot be fully validated in Simulator. Simulator testing remains
useful for notification permission UI, route parsing, and handling injected
notification payloads.

## Open decisions

Resolve these during implementation:

1. Whether channel closure by any capability holder is acceptable for v1.
2. Exact idempotency retention and partial-delivery retry schema.
3. Whether routes should be included in APNs payloads or notifications should
   always open a generic activity screen.
4. Whether the first production version needs Cloudflare Queues.
5. Per-app and per-channel rate-limit values.
6. Channel cleanup policy for abandoned pairings.
7. Whether future apps require different Apple Developer teams.
8. Whether 100% operational-log sampling remains appropriate after initial
   production traffic.
9. Whether monitoring should become automated paging after v1 usage establishes
   meaningful baselines.

## Inspiration and prior art

These projects should be reviewed during implementation. They are design
references, not automatically approved dependencies; copying or adapting code
requires preserving the applicable license and attribution.

- [AndrewBarba/apns2](https://github.com/AndrewBarba/apns2) — the original
  TypeScript/Node APNs HTTP/2 client. Use it as a reference for client shape,
  notification modeling, APNs environments, response parsing, and error
  semantics.
- [FiveSheepCo/cloudflare-apns2](https://github.com/FiveSheepCo/cloudflare-apns2)
  — a Cloudflare Workers-compatible fork of AndrewBarba's `apns2` using native
  Worker APIs. Evaluate it as the APNs transport dependency before writing a
  custom transport, with particular attention to multi-app topics, timeouts,
  JWT caching, error redaction, testability, and current maintenance.
- [jonesphillip/paje](https://github.com/jonesphillip/paje) — an end-to-end
  Cloudflare Worker, Durable Object, dashboard, and iOS topic client. Reuse its
  useful APNs and Durable Object ideas, but do not carry forward its global
  client token, unauthenticated administrative routes, public message history,
  or unrestricted client-provided notification content.
- [Pushy design article](https://codakuma.com/pushy/) — a deliberately small
  Worker-based APNs provider demonstrating device-token registration, direct
  APNs delivery, environment separation, and invalid-token cleanup.

## References

- [Apple: Setting up a remote notification server](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server)
- [Apple: Communicate with APNs using authentication tokens](https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens/)
- [Apple: Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Cloudflare Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
