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
- Allow only App Attest-verified instances of a registered app to provision new
  notification channels.
- Collect privacy-bounded operational logs and aggregate delivery analytics from
  the first production release.
- Serve thousands of concurrent users by distributing independent channels and
  provisioning traffic across Durable Objects, without a fixed service-wide
  limit on users, channels, or legitimate request volume.

## Non-goals for v1

- Marketing analytics, user profiling, segmentation, or A/B testing.
- A public or end-user-facing analytics API or dashboard.
- Email, SMS, Android, or web push.
- A public topic directory, message-history API, or end-user dashboard.
- Arbitrary client-provided notification titles, bodies, deep links, or routes.
- Rich-media attachments or notification action buttons.
- Treating possession of a channel capability as proof of a real-world identity.
- Unbounded single-event broadcasts. Large fan-out must use queued, chunked
  delivery rather than one monolithic Worker invocation.

## Deployment shape

Use one repository and deploy the same code twice:

| Deployment | APNs endpoint | Intended builds |
| --- | --- | --- |
| `apnw-dev` | `api.sandbox.push.apple.com` | Xcode development builds |
| `apnw-prod` | `api.push.apple.com` | TestFlight and App Store builds |

Development and production must use separate Durable Object namespaces. Device
tokens are scoped to an app and APNs environment and must never be copied between
the deployments.

Production assumes Workers Paid. Free-plan request and subrequest allowances are
not capacity targets. The stateless Worker scales globally, Channel Durable
Objects scale independently per channel, and provisioning state is spread over a
fixed set of shards. APNW has no configured global user or channel ceiling.

Suggested public endpoints:

```text
https://push-dev.example.com
https://push.example.com
```

The initial deployment assumes all registered apps belong to one Apple Developer
team. Development and production use different environment-scoped APNs signing
keys. Each key may authenticate pushes for multiple bundle IDs in its environment.
APNW selects the destination app by setting the request's `apns-topic` header to
that app's bundle ID.

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
  | Validate app, provisioned capability, request, and event template
  v
Channel Durable Object
  |
  |-- Bounded direct delivery ---------------------------\
  |
  `-- Transactional outbox for larger fan-out
        |
        v
      Cloudflare Queue consumers -----------------------+
                                                         |
                                                         v
                                                   APNs HTTP/2 API
                                                         |
                                                         v
                                               Recipient Apple devices
```

Channel creation has a separate trust boundary:

```text
iOS main app
  |
  | App Attest challenge, key attestation, and provisioning assertion
  v
Cloudflare Worker
  |
  | Verify app, App Attest environment, assertion, counter, and abuse policy
  v
Per-app Provisioning Durable Object shard
  |
  | Authorize initialization of one derived channel identifier
  v
Channel Durable Object
```

There is a fixed, versioned set of Provisioning Durable Object shards per
registered app and deployment. Start with 256 virtual shards. A canonical App
Attest key ID selects its shard using the high bits of SHA-256:

```text
shard = SHA-256(appID + "\0" + appAttestKeyIDBytes) mod 256
```

Each shard keeps a bounded set of App Attest challenges, verified public keys,
assertion counters, fraud-assessment receipts, and per-key abuse-control state.
Shard names come only from the checked-in app registry, shard version, and
bounded shard index, so attacker-controlled key IDs or capabilities cannot create
additional provisioning objects. All operations for one App Attest key reach the
same shard and remain serialized, while unrelated clients spread across the
shards. Increasing the shard count later requires a versioned migration with
dual-read routing; silently changing the modulus is prohibited.

There is one Channel Durable Object per app and private notification channel.
Capabilities use one canonical v1 representation: exactly 32 random bytes encoded
as unpadded base64url. After decoding and canonicalization, the Worker derives a
stable internal object name from:

```text
SHA-256("apnw-channel-v1\0" + appID + "\0" + capabilityBytes)
```

The 256-bit random capability already provides preimage resistance. A
domain-separated, unkeyed digest keeps routing stable across secret rotation,
deployment rollback, and disaster recovery. Closed-channel tombstones therefore
remain reachable for the lifetime of the capability and cannot be bypassed by
changing a server routing key.

The shared channel capability is sent only in the `Authorization` header and is
never placed in a URL, Durable Object name, database row, response, or log.
Channel administration and installation ownership use separate 256-bit
capabilities. Their raw values likewise appear only in dedicated authorization
headers and protected client storage; the server stores only SHA-256 digests.

Possession of a capability does not create a channel. Before the first device
registration, the main app must provision the capability with a fresh App Attest
assertion that binds the operation, app ID, deployment, and capability digest.
The Worker verifies the assertion and enforces per-key provisioning abuse
controls before it accesses the derived Channel Durable Object. Every later
channel operation checks that the object contains a `provisioned_at` marker; an
otherwise valid random
capability returns the same opaque `404` as an unknown or closed channel and must
not initialize storage.

After provisioning, this remains a capability-based security model with
least-privilege capability classes:

- The shared channel capability permits fixed-template publishing and first-time
  device registration.
- A per-installation capability is additionally required to update, unregister,
  or exclude that installation.
- A channel-administrator capability is additionally required to close and
  rotate the channel.

For Chain of Custody, only the shared channel capability is distributed inside
the pairing's encrypted shared CloudKit payload. Installation capabilities remain
in the local Keychain. The administrator capability remains in the pairing
creator's private protected state and is never distributed to participants.

## Multi-app configuration

Use a checked-in registry for nonsecret configuration:

```ts
export const apps = {
  chain_of_custody: {
    bundleID: "com.twodayslate.coc",
    provisioning: {
      shardVersion: 1,
      shardCount: 256
    },
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
| `APNS_KEY_P8` | Base64-encoded environment-scoped APNs private key |
| `APNS_KEY_ID` | Environment-scoped Apple APNs signing key identifier |
| `APNS_TEAM_ID` | Apple Developer team identifier |
| `DEVICECHECK_KEY_P8` | Base64-encoded DeviceCheck key used for App Attest fraud assessment |
| `DEVICECHECK_KEY_ID` | DeviceCheck signing key identifier |
| `LOG_CORRELATION_KEY` | Derives short, daily rotating operational channel references |

Nonsecret deployment configuration:

| Variable | Values |
| --- | --- |
| `APNS_ENVIRONMENT` | `development` or `production` |
| `APP_ATTEST_ENVIRONMENT` | `development` or `production` |
| `SERVICE_VERSION` | Release identifier exposed by health checks |

`APNS_ENVIRONMENT`, the environment restriction of the configured APNs key, and
`APP_ATTEST_ENVIRONMENT` must agree with the deployment. Production rejects
development APNs credentials and App Attest objects; development rejects
production credentials and objects. App Attest certificate-chain and
authenticator-data verification uses Apple's published App Attest root
certificate.

Bind a Workers Analytics Engine dataset named `APNW_ANALYTICS` in both
deployments. Development and production use separate datasets.

## HTTP API

All capability-addressed channel endpoints require:

```http
Authorization: Bearer <channel-capability>
```

Endpoints with JSON bodies additionally require
`Content-Type: application/json`.

Capabilities must decode to exactly 32 bytes from canonical, unpadded base64url.
Reject noncanonical, malformed, empty, or oversized credentials before accessing
a Durable Object.

### App Attest challenge

```http
POST /v1/apps/{appID}/app-attest/challenge
Content-Type: application/json

{
  "purpose": "attest_key" | "provision_channel",
  "keyID": "<base64-app-attest-key-id>"
}
```

The selected Provisioning Durable Object shard returns a random, single-use
challenge identifier and challenge value with a maximum five-minute lifetime. It
retains only a bounded number of outstanding challenges and prunes expired
entries before issuing new ones. This endpoint uses edge and per-key abuse
controls and never accesses a Channel Durable Object. Source IP is only a
defense-in-depth signal because mobile carrier NAT and privacy relays can place
many legitimate users behind one address.

Validate that `keyID` canonically decodes to Apple's expected 32-byte credential
identifier before computing the shard. Invalid or oversized values fail before
Durable Object access.

### Register an App Attest key

```http
POST /v1/apps/{appID}/app-attest/keys
Content-Type: application/json

{
  "keyID": "<base64-app-attest-key-id>",
  "challengeID": "<opaque-challenge-id>",
  "attestationObject": "<base64-cbor-attestation>"
}
```

The selected Provisioning Durable Object shard performs Apple's complete server-side
verification procedure, including the Apple certificate chain, challenge nonce,
credential ID, RP ID for the selected app, App Attest environment, initial
counter, validation category, and bundle version. On success, it stores the
public key, a digest of the key ID, the fraud-assessment receipt, the current
assertion counter, and bounded quota metadata. It never stores the raw
attestation object.

Duplicate registration of the same verified key is idempotent. A key ID already
associated with different verified key material is rejected. Invalid
attestations do not create state outside the fixed provisioning shard set.

### Provision a channel

```http
PUT /v1/apps/{appID}/channel
Authorization: Bearer <channel-capability>
X-Channel-Admin-Authorization: Bearer <channel-admin-capability>
Content-Type: application/json

{
  "keyID": "<base64-app-attest-key-id>",
  "challengeID": "<opaque-challenge-id>",
  "assertion": "<base64-cbor-assertion>"
}
```

The App Attest assertion signs canonical client data containing:

- The `provision_channel` operation and HTTP method.
- The registered app ID and deployment environment.
- The SHA-256 digest of the decoded channel capability.
- The SHA-256 digest of the decoded channel-administrator capability.
- The single-use server challenge.
- A short expiration time.

The selected Provisioning Durable Object shard verifies the stored public key,
RP ID, strictly increasing assertion counter, challenge, environment, validation
category, and bundle version. It atomically consumes the challenge and updates
per-key abuse state before authorizing Channel Durable Object initialization.

Provisioning controls are rate-based abuse protections, not product or capacity
limits. Use a generous token bucket per attested key, App Attest fraud metrics,
and adaptive edge mitigation for suspicious traffic. There is no fixed lifetime
channel allowance per key and no service-wide or app-wide channel-count quota.
Independent legitimate clients must not compete for one shared allowance.
Temporary throttling returns `429` with `Retry-After` and does not consume a
challenge or assertion counter.

Initializing an open channel is idempotent. A closed tombstone permanently
rejects reprovisioning with the same capability. App Attest is unavailable to
most app extensions, so only the main iOS app performs key attestation and
channel provisioning. Unsupported devices require a separately designed,
server-authorized provisioning grant; there is no anonymous fallback in v1.

### Health

```http
GET /health
```

Returns only service status, deployment environment, and version. It must not
return app names, bundle IDs, channel counts, device counts, or APNs credentials.

### Register a device

```http
PUT /v1/apps/{appID}/device
Authorization: Bearer <channel-capability>
X-Installation-Authorization: Bearer <installation-capability>
Content-Type: application/json

{
  "installationID": "<installation-id>",
  "deviceToken": "<APNs token>"
}
```

- `installationID` and the installation capability are independent random
  256-bit values generated once per app installation.
- Require the installation capability for first registration and every later
  update. Store only its SHA-256 digest and compare it in constant time.
- Do not assume APNs tokens have a permanently fixed byte length.
- Require hexadecimal encoding, a reasonable maximum length, and a nonempty
  decoded value.
- Registration is idempotent.
- If an installation receives a new APNs token, replace its previous token.
- A token may be registered to more than one private channel when the app
  participates in more than one collaboration.

### Unregister a device

```http
DELETE /v1/apps/{appID}/device
Authorization: Bearer <channel-capability>
X-Installation-Authorization: Bearer <installation-capability>
Content-Type: application/json

{
  "installationID": "<installation-id>"
}
```

The response is successful whether or not the installation was registered, but a
wrong installation capability returns the same opaque authentication failure as
an unknown installation.

Installation IDs are request-body fields rather than URL path or query values so
edge access logs cannot capture them as part of the request target.

### Publish an event

```http
POST /v1/apps/{appID}/events
Authorization: Bearer <channel-capability>
Idempotency-Key: <stable-event-id>
Event-Created-At: <RFC3339-client-event-time>
X-Installation-Authorization: Bearer <installation-capability>
Content-Type: application/json

{
  "event": "submission_ready",
  "excludeInstallationID": "<sender-installation-id>"
}
```

- The Worker maps `event` to a checked-in title and body.
- Clients cannot submit notification copy, APNs headers, images, actions, routes,
  deep links, or application-domain identifiers.
- APNW notifications always open the app's generic activity screen. The app then
  fetches authoritative CloudKit state.
- Exclude an installation only after verifying its per-installation capability.
  If exclusion is omitted, the installation header is optional. Other devices
  owned by the sender may still receive the update.
- Require a canonical UUIDv4 idempotency key and a client event time no more than
  five minutes in the future or 72 hours in the past.
- Return only event acceptance state. Device and delivery counts remain internal
  operational telemetry because they disclose channel size.

Example direct-delivery response:

```json
{
  "eventID": "7fb31c36-...",
  "deliveryMode": "direct",
  "state": "accepted"
}
```

When APNW selects queued delivery, it returns `202` after the Channel Durable
Object transaction has durably recorded the event, target state, and outbox
entry:

```json
{
  "eventID": "7fb31c36-...",
  "deliveryMode": "queued",
  "state": "accepted"
}
```

### Close a channel

```http
DELETE /v1/apps/{appID}/channel
Authorization: Bearer <channel-capability>
X-Channel-Admin-Authorization: Bearer <channel-admin-capability>
```

Closing removes registered devices and leaves a tombstone that permanently
rejects the old capability. A replacement channel uses a newly generated
capability.

Only possession of both the shared channel capability and administrator
capability authorizes closure. A participant with only the shared capability
cannot close or rotate the channel.

## Durable Object data model

Use one SQLite-backed Durable Object class for every app/channel pair.

```sql
CREATE TABLE devices (
  installation_id TEXT PRIMARY KEY,
  installation_capability_digest TEXT NOT NULL,
  device_token TEXT NOT NULL,
  token_status TEXT NOT NULL,
  bad_token_count INTEGER NOT NULL,
  last_bad_token_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX devices_token
ON devices(device_token);

CREATE TABLE events (
  idempotency_key TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  event_name TEXT NOT NULL,
  client_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivery_mode TEXT NOT NULL,
  state TEXT NOT NULL,
  device_count INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  failed INTEGER NOT NULL
);

CREATE TABLE event_deliveries (
  idempotency_key TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  token_updated_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (idempotency_key, installation_id)
);

CREATE TABLE delivery_outbox (
  idempotency_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE channel_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  admin_capability_digest TEXT NOT NULL,
  provisioned_at INTEGER NOT NULL,
  closed_at INTEGER
);
```

Do not store or retain:

- Notification title or body.
- CloudKit record identifiers.
- Pairing identifiers, labels, roles, or participant identities.
- APNs request payloads.
- Raw shared-channel, administrator, or installation capabilities.
- App Attest assertions, attestation objects, challenges, key IDs, or receipts
  inside Channel Durable Objects.

APNW accepts no route, deep link, record identifier, or notification payload
metadata, so direct and queued delivery persist none of those values.

Retain terminal idempotency and per-installation delivery metadata for seven days
after acceptance. Never prune an unexpired idempotency record because of a row
count. Client outbox entries expire after 72 hours, so a conforming client cannot
retry after the server's retention window. Prune raw per-installation attempt
details after the seven-day window and retain no permanent delivery history.

The fixed provisioning shard set stores only the App Attest public key and
security metadata needed to verify assertions, prevent replay, assess fraud, and
enforce per-key abuse controls. App Attest key IDs are stored and looked up by
digest. Challenges expire within five minutes. Raw assertions and attestation
objects are discarded after verification. These records are pseudonymous
device-level security data and must not be joined to channel, pairing, CloudKit,
participant, or notification-delivery data.

## APNs provider behavior

- Generate an ES256 provider JWT using the configured Team ID and Key ID.
- Cache a JWT for no more than 50 minutes.
- Use different environment-restricted APNs signing keys for development and
  production; never install the production key in the development Worker.
- Select the APNs host exclusively from deployment configuration.
- Set `apns-topic` from the selected app registry entry.
- Set `apns-push-type: alert`.
- Use `apns-priority: 10` for normal visible events.
- Use a conservative expiration appropriate for a synchronization nudge.
- Include only the server-controlled alert; do not include routes, record IDs, or
  other client metadata.
- Generate and log an internal request ID, not a device token.
- On `410 Unregistered`, remove a registration only when its installation ID,
  token, and `updated_at` still match the publish snapshot and the registration
  predates or equals APNs' invalidation timestamp.
- Treat `BadDeviceToken` and `DeviceTokenNotForTopic` as suspect-registration or
  configuration signals, not unconditional deletion instructions. Quarantine the
  matching token version, request client re-registration, and delete it only
  after repeated confirmation with no environment-wide error spike.
- Trip an invalid-token cleanup circuit breaker when error rates cross the
  documented threshold. Stop cleanup, alert, and verify APNs host, topic, and key
  environment before resuming.
- Initial circuit thresholds are any APNs provider/environment authentication
  error, or at least 10 `BadDeviceToken`/`DeviceTokenNotForTopic` responses within
  five minutes when they also exceed 5% of attempts for that app and environment.
  Keep thresholds configurable without code changes.
- Treat `429` and APNs `5xx` responses as transient.
- All cleanup uses compare-and-delete against the snapshotted installation ID,
  token, and version so a stale APNs response cannot remove a newly registered
  token.

Normal private-channel publishes send directly from the Channel Durable Object.
Use a pool of at most six APNs requests waiting for response headers per Worker
invocation, while allowing completed connections to make room for additional
targets. Do not impose the former 40-device registration or publish cap.

Workers Paid currently allows 10,000 subrequests per invocation by default and
has no daily request ceiling. Thousands of concurrent users on different
channels execute in different Worker and Durable Object instances; they do not
share one per-invocation APNs budget.

When a publish exceeds the measured direct-delivery target-count or latency
budget, transparently route it through the production transactional delivery
outbox and Cloudflare Queue consumer; do not reject it because of target count.
The HTTP request records and accepts the event once, then queue consumers drain
target chunks with per-installation retry state. Queue messages contain only an
opaque channel reference and event ID; device tokens remain in the Channel
Durable Object. Queue consumers autoscale horizontally and must not use a fixed
`max_concurrency` unless APNs behavior requires temporary backpressure.

## Scale and capacity requirements

- Do not configure a global maximum for users, channels, installations, or
  ordinary request throughput.
- Use one Channel Durable Object per app/channel so unrelated channels never
  serialize on shared state.
- Use the fixed provisioning shard set so App Attest verification and challenge
  traffic do not bottleneck on one object.
- Keep external APNs I/O outside storage transactions and
  `blockConcurrencyWhile()` sections.
- Apply rate controls per attested key and channel capability. These isolate
  abusive actors and must not reduce aggregate capacity across independent
  clients.
- Treat source-IP limits as an emergency abuse signal, not a user identity or
  primary capacity control.
- Use overload responses with jittered `Retry-After` rather than silently
  dropping accepted work.
- Monitor request rate, Durable Object overloads, queue depth, APNs latency,
  error rates, and cost per accepted event.
- Load-test at least 10,000 concurrent mixed operations distributed across at
  least 5,000 channels with mocked APNs latency. The conforming workload must
  produce no rate-limit responses, no cross-channel blocking, and no Durable
  Object overload errors.

## Logging and analytics requirements

Observability is a v1 feature, even though APNW does not expose an analytics API
or dashboard. Use two complementary sinks:

1. **Workers Logs** for short-retention, structured operational events used to
   diagnose individual requests and failures.
2. **Workers Analytics Engine** for three months of aggregate, queryable service
   and delivery metrics.

Enable custom Workers Logs in both deployments. Log authentication failures,
authorization failures, validation failures, rate limiting, cleanup circuit
changes, queue dead letters, and internal errors at 100%. Sample successful
high-volume operations through a configurable `LOG_SAMPLE_RATE`, starting at 10%
in production, while Analytics Engine retains aggregate coverage. Disable
automatic invocation logs in production and emit only intentional,
privacy-reviewed custom logs.

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
- An optional short, pseudonymous channel reference derived as
  `HMAC-SHA256(LOG_CORRELATION_KEY, UTC-date || channel-object-id)` and truncated
  for display. It rotates daily, is retained only in operational logs, and is
  never written to aggregate analytics.

Registration, unregistration, channel closure, authentication rejection,
validation rejection, App Attest key registration, channel provisioning, rate
limiting, and unhandled exceptions must also produce structured events.

Every telemetry dimension comes from a server-owned allowlist. Log a canonical
registry `appID` only after successful lookup. For an unknown or malformed app,
event, operation, APNs reason, or other enum, emit a fixed sentinel such as
`unknown_app` or `validation_rejected`; never copy the attacker-supplied string
into logs or analytics.

Logs must never contain:

- Authorization headers or shared-channel, administrator, or installation
  capabilities.
- APNs device tokens or installation IDs.
- Notification routes, request bodies, or APNs payloads.
- CloudKit, pairing, record, participant, or user identifiers.
- Notification titles or bodies, even though templates are generic.
- App Attest key IDs, public keys, assertions, attestation objects, receipts, or
  challenge values.
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
- App Attest verification and channel-provisioning outcomes using bounded enums.
- Authentication, validation, rate-limit, and internal-error counts.
- Publish event count by app and event-template name.
- Target, accepted, failed, and stale-token-removal counts.
- APNs latency and error counts grouped by allowlisted reason category.
- Idempotency duplicate and retry counts.

Use `appID` as the Analytics Engine index. Use bounded enums in blob fields and
numeric counters or timings in double fields. Do not write a channel reference,
device identifier, request ID, route, capability, token, or other per-user value
to Analytics Engine.

Only successfully resolved registry app IDs may be Analytics Engine indexes.
Rejected or unknown app IDs use the single bounded `unknown_app` index value.

Analytics writes must be best-effort and must never change the API response or
push-delivery result. A telemetry failure may emit one sanitized operational
warning, but must not recursively attempt additional analytics writes.

### Retention and access

- Workers Logs use Cloudflare's plan-defined short retention: currently three
  days on Workers Free and up to seven days on Workers Paid.
- Analytics Engine retains data for three months.
- APNW itself does not copy logs or analytics to Durable Objects, KV, D1, or R2.
- Access remains limited to authorized maintainers in the Cloudflare account.
- Require phishing-resistant MFA for maintainers, least-privilege Cloudflare
  roles, and separate scoped CI deployment tokens for development and
  production. Deployment tokens must not grant account-wide administration.
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

Define operational thresholds in the runbook for elevated APNs failure rate,
invalid-token cleanup circuit activation, authentication anomalies, Worker `5xx`
rate, Queue backlog/dead letters, provisioning-shard overload, and an unexpected
drop to zero publish events. Production launch requires automated notification
for cleanup-circuit activation, sustained Worker `5xx`, production APNs
authentication failure, and Queue dead letters. Other thresholds may begin as
manually reviewed alerts until traffic establishes stable baselines.

## Error and retry semantics

- Invalid input or credentials: do not retry automatically.
- Duplicate idempotency key with the same request digest: return the stored state
  without creating deliveries again.
- Duplicate idempotency key with a different request digest: return
  `409 Conflict`; never treat it as the original event.
- Partial APNs failure during direct delivery: return a retryable response and
  let a same-key client retry resume only transient targets.
- Queued delivery: the client removes its outbox item after APNW durably accepts
  the event. APNW owns target retries from that point and never asks the client
  to republish an accepted queued event.
- Queue enqueue failure after the event transaction: retain the delivery outbox
  entry and retry enqueue with a Durable Object alarm; do not lose accepted work.
- Worker/APNs unavailable: return `503` with `Retry-After`.
- Apply exponential backoff with jitter in client integrations.
- Preserve notification requests in a durable client outbox until APNW accepts
  them or they expire.

The Channel Durable Object computes a versioned SHA-256 digest over canonical
request data: app ID, event-template name, verified excluded installation or
`null`, idempotency key, and client event time. In one SQLite transaction it:

1. Inserts the event in `preparing` state if the key is new.
2. Rejects a stored key whose request digest differs.
3. Snapshots target installation IDs and token versions into
   `event_deliveries`.
4. Creates the delivery-outbox entry when queued delivery is selected.
5. Commits before any APNs or Queue I/O begins.

Concurrent requests for the same key therefore observe one stored event. Delivery
states are `pending`, `in_flight`, `accepted`, `transient_failure`,
`permanent_failure`, or `ambiguous`. A target must transition transactionally to
`in_flight` before APNs I/O. Successful and permanent targets are never retried;
only explicit transient failures are eligible. If execution stops after sending
but before recording APNs' response, mark the expired lease `ambiguous` and do
not resend it, preferring duplicate prevention over guaranteed notification
delivery in that narrow crash window. Use the stable event UUID as the APNs
collapse identifier as additional duplicate mitigation.

## Security and privacy requirements

- Authenticate every endpoint that accesses channel or device state.
- Separate shared publishing, channel administration, and installation ownership
  into independent capabilities and store only their digests server-side.
- Require the per-installation capability for token updates, unregister, and
  sender exclusion; require the administrator capability for close and rotation.
- Require a verified App Attest assertion before initializing any channel.
- Reject unprovisioned capabilities without creating channel state.
- Keep App Attest challenges single-use, short-lived, and bounded.
- Enforce per-attested-key provisioning abuse controls without a global or
  app-wide legitimate-traffic quota.
- Treat unsupported App Attest devices as denied unless they present a separate
  server-authorized provisioning grant; never fall back to anonymous creation.
- Do not implement a public topic list, registry, statistics API, WebSocket, or
  message-history endpoint.
- Do not embed a global publishing secret in any client app.
- Never accept arbitrary notification copy from a client.
- Keep capabilities in authorization headers, not URL paths or query strings.
- Parse authorization headers strictly: exactly one supported scheme and one
  canonical credential, with no comma-joined values, control characters, or
  ambiguous whitespace.
- Enforce small request-body and header-size limits.
- Enforce body limits while reading the request rather than trusting
  `Content-Length`, and reject duplicate or unknown JSON fields.
- Use constant-time comparisons anywhere secret values are compared.
- Rate-limit abusive behavior by attested key and channel capability. Use app and
  source-IP signals only for adaptive incident mitigation, not as fixed shared
  quotas for normal clients.
- Ensure CORS is absent by default; native clients do not need wildcard CORS.
- Return `Cache-Control: no-store` on every API response, enable HSTS on custom
  domains, and configure Worker routes fail closed with no origin bypass.
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
- Use separate environment-scoped APNs keys and separately scoped Cloudflare
  deployment credentials so development compromise does not grant production
  push authority.

### Known v1 trust boundary

The Worker cannot independently read or validate membership in a private/shared
CloudKit database. App Attest proves that channel provisioning was requested by
a verified instance of the registered app; it does not prove a real-world
identity, CloudKit membership, or honest user intent. Once a channel is
provisioned, possession of its high-entropy shared capability authorizes fixed
event publishing and first-time registrations, but not installation mutation or
channel administration.

This is appropriate for a cooperative application using generic payloads, but a
participant holding the shared capability can still:

- Register an additional device under a new installation ID and secret.
- Request allowed notification event types.
- Generate nuisance traffic up to the per-capability abuse controls.

They cannot update or delete another installation without its installation
capability and cannot close the channel without the administrator capability. If
participant-specific publishing revocation becomes necessary without rotating
the shared channel, add user-specific server-issued publishing capabilities or a
separate identity service. App Attest alone does not prove membership.

## Chain of Custody integration

The server remains generic; these changes occur in the Chain of Custody app:

1. Generate and retain one App Attest key in the main app, complete key
   attestation with APNW, and recover by generating a new key when the original
   key identifier is unavailable.
2. When creating a pairing, generate independent 256-bit shared-channel and
   channel-administrator capabilities and encode both as canonical, unpadded
   base64url.
3. Obtain a fresh provisioning challenge and sign an assertion that binds the
   shared and administrator capability digests, app, environment, operation, and
   expiration.
4. Provision the channel before attempting device registration or publishing.
5. Put only the shared-channel capability in the pairing's encrypted shared
   CloudKit payload. Keep the administrator capability in the creator's private
   encrypted CloudKit state so participants never receive it.
6. Store local shared-channel and installation capabilities in a narrowly scoped
   app/extension Keychain access group using
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for required background
   delivery. Store the administrator capability in a main-app-only Keychain item
   with the same accessibility class. Do not store bearer values in
   `UserDefaults`, plaintext App Group files, analytics, crash reports, or
   notification payloads.
7. Let the App Group outbox contain only a local opaque Keychain reference,
   canonical event UUID, client creation time, and fixed event enum. Resolve
   capabilities from Keychain immediately before transport.
8. Add a schema-compatible migration for existing pairings without capabilities.
   Only the pairing creator generates and privately retains the administrator
   capability; provisioning an existing migrated shared capability is
   idempotent.
9. Generate independent random 256-bit installation ID and installation
   capability values. Store the capability in Keychain and only the
   non-authorizing installation ID in the shared App Group.
10. Capture APNs device-token callbacks in the main application delegate.
11. Register and update each installation using both the shared-channel and
    installation capabilities.
12. Re-register when APNs rotates the token, the iCloud account changes, or active
    pairings change.
13. Unregister using the installation capability when leaving or blocking a
    pairing.
14. For revocation, first confirm the participant's CloudKit access removal, then
    close the old APNW channel with the administrator capability, generate and
    provision new shared/admin capabilities, distribute the new shared capability
    only to remaining participants, and re-register their installations. Never
    publish the replacement capability before CloudKit confirms removal.
15. On iCloud account change or sign-out, stop transport, discard unresolved
    outbox entries, unregister where possible, and remove Keychain capability
    mappings before adopting the new account's pairings.
16. After a CloudKit mutation succeeds, add the corresponding fixed APNW event,
    UUIDv4 idempotency key, and creation time to the persistent local outbox.
17. Let both the main app and Messages extension enqueue events through the App
    Group. App Attest provisioning remains main-app-only; transport may use the
    shared Keychain access group after provisioning.
18. Include no user-authored content, routes, deep links, record identifiers, or
    decrypted CloudKit data in APNW requests.
19. On notification tap, open the generic activity screen and fetch current
    CloudKit state before presenting anything.
20. Keep the existing CKSyncEngine notification path as a synchronization
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
│   ├── appAttest/
│   │   ├── attestation.ts
│   │   ├── assertion.ts
│   │   ├── appleRoot.ts
│   │   └── clientData.ts
│   ├── observability/
│   │   ├── analytics.ts
│   │   ├── logger.ts
│   │   └── schema.ts
│   ├── apns/
│   │   ├── client.ts
│   │   ├── jwt.ts
│   │   └── payload.ts
│   ├── delivery/
│   │   ├── outbox.ts
│   │   └── queueConsumer.ts
│   └── channel/
│       ├── ChannelObject.ts
│       ├── ProvisioningShardObject.ts
│       └── schema.ts
└── test/
    ├── api.test.ts
    ├── auth.test.ts
    ├── app-attest.test.ts
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

- Add canonical capability validation and stable, domain-separated SHA-256
  Durable Object routing.
- Add the fixed, versioned per-app Provisioning Durable Object shard set and
  bounded challenge stores.
- Implement App Attest certificate-chain, authenticator-data, attestation, and
  assertion verification.
- Require App Attest-authorized provisioning before Channel Durable Object
  initialization.
- Enforce per-key provisioning abuse controls and fraud-metric policy without an
  app-wide capacity ceiling.
- Add the SQLite schema and device registration lifecycle.
- Add administrator and per-installation capability verification with
  constant-time digest comparisons.
- Add server-controlled event publishing.
- Exclude the sender installation.
- Remove invalid APNs tokens.
- Implement closed-channel tombstones.
- Instrument registration, unregistration, publishing, cleanup, idempotency, and
  channel-closure outcomes.

Exit criteria:

- Apps and channels cannot collide even when their human-readable IDs match.
- Random or merely well-formed capabilities cannot create, read, or mutate
  channel state.
- Invalid or replayed App Attest data cannot provision a channel.
- At least 10,000 concurrent operations distributed across at least 5,000
  channels complete without provisioning-shard or cross-channel contention in
  the load-test environment.
- Within one environment's Durable Object namespace, a channel routes to the
  same object across code versions, rollbacks, and unrelated secret rotation.
- Duplicate registration and unregistration are safe.
- A shared capability alone cannot update or delete an existing installation,
  spoof sender exclusion, or close a channel.
- A closed capability cannot recreate its channel.
- Operational logs can correlate a channel failure without revealing a channel
  capability or application-domain identifier.

### Phase 3: Reliability and hardening

- Add canonical request digests, atomic event claims, seven-day idempotency
  retention, and per-installation delivery state.
- Resolve direct, queued, transient, permanent, and ambiguous delivery behavior.
- Add request limits, rate limits, and opaque errors.
- Add the production transactional delivery outbox and autoscaling Queue consumer
  used automatically above the measured safe direct-delivery budget.
- Add APNs key-rotation and incident-response documentation.
- Add conditional invalid-token cleanup and its environment-error circuit
  breaker.
- Add strict authorization parsing, streaming body limits, no-store responses,
  HSTS, fail-closed routes, and bounded telemetry enums.
- Add deployment smoke tests and health checks.
- Check in Analytics Engine SQL queries and the observability runbook.
- Configure the required production security and delivery alerts.
- Document retention, access, sampling, and initial monitoring thresholds.
- Verify behavior, cost, and overload recovery on Workers Paid at the required
  concurrency target.

Exit criteria:

- Repeating an accepted event never produces a second delivery.
- Reusing an idempotency key with different canonical request data returns `409`,
  and concurrent same-key requests create one delivery set.
- Transient APNs failures can be retried without redelivering to successful
  targets.
- Stale or environment-wide APNs errors cannot delete current registrations.
- Publishes above the direct-delivery budget are accepted and drained through
  Queues without a target-count rejection.
- Malformed and oversized requests fail before Durable Object access.
- The production deployment exposes no state-listing or history endpoints.
- Delivery rate, error category, latency, registration activity, rejection
  trends, idempotency behavior, and service-version regressions can be queried
  without per-user analytics.

### Phase 4: Chain of Custody integration

- Add main-app App Attest key creation, attestation, assertion, and recovery.
- Add shared-channel, administrator, and installation capabilities, Keychain
  storage, provisioning, and migration behavior.
- Keep App Attest operations out of the Messages extension.
- Add device-token capture and App Group persistence.
- Add device registration reconciliation.
- Add the persistent notification outbox.
- Map domain changes to APNW's fixed event types.
- Add generic activity-screen notification handling and notification
  deduplication.

Exit criteria:

- Two physical devices using different Apple Accounts receive the correct
  neutral alerts.
- Only a successfully attested main-app instance can provision a new channel.
- Replaying an attestation, assertion, or provisioning challenge cannot create a
  second channel or reset per-key abuse state.
- A participant with only the shared capability cannot mutate another
  installation or close the channel.
- The originating installation does not alert itself.
- Offline CloudKit mutations eventually generate one APNW event after syncing.
- Leaving, blocking, revocation, token rotation, reinstall, and iCloud account
  changes do not leave an unintended active registration.
- Revocation does not distribute the replacement shared capability until
  CloudKit confirms removal of the revoked participant.
- No user-authored or decrypted CloudKit content reaches Cloudflare or APNs.

### Phase 5: Production deployment

- Create separate Cloudflare development and production resources.
- Configure custom domains and secrets.
- Configure App Attest and DeviceCheck credentials and verify that each
  deployment accepts only its matching App Attest environment.
- Create separate development and production delivery queues and dead-letter
  queues.
- Create separate development- and production-restricted APNs signing keys and
  document recovery/rotation.
- Configure phishing-resistant maintainer MFA, least-privilege roles, separate
  scoped CI deployment tokens, HSTS, and fail-closed Worker routes.
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
- Development APNs credentials cannot authenticate to production and production
  APNs credentials are absent from development.
- Development App Attest objects are rejected by production and production App
  Attest objects are rejected by development.
- APNs invalid-token cleanup is observed without exposing token values.
- A production push produces the expected structured log and aggregate data
  point without recording prohibited fields.
- Deployment and rollback can be completed from the repository instructions.

## Required tests

### Unit and Worker integration tests

- App registry lookup and unknown-app behavior.
- Cross-app and cross-channel Durable Object isolation.
- Capability exact length, canonical encoding, stable domain-separated digest,
  and redaction.
- Shared-channel, administrator, and installation capability separation,
  constant-time digest verification, and header parsing.
- Confirmation that a shared capability alone cannot replace/unregister an
  existing installation, claim sender exclusion, or close a channel.
- Confirmation that random valid capabilities cannot initialize Channel Durable
  Objects.
- App Attest certificate chain, nonce, credential ID, RP ID, environment,
  counter, validation-category, and bundle-version verification.
- App Attest challenge expiration, one-time consumption, assertion replay
  rejection, key-material mismatch, provisioning-shard routing, and per-key abuse
  enforcement.
- Provisioning shard determinism, even distribution, fixed cardinality, and
  versioned migration behavior.
- Confirmation that independent attested keys do not share a global allowance or
  throttle one another.
- Load tests covering 10,000 concurrent operations across at least 5,000
  channels and all provisioning shards.
- Confirmation that invalid key IDs or attestation objects cannot create
  attacker-selected provisioning Durable Objects.
- Confirmation that routing remains stable across unrelated secret rotation and
  that closed tombstones cannot be bypassed.
- APNs JWT claims, encoding, signing, cache reuse, and expiration.
- Sandbox and production endpoint selection.
- `apns-topic` selection for every app.
- Payload template allowlisting and confirmation that routes, deep links, record
  identifiers, and unknown JSON fields are rejected.
- Registration, token replacement, unregistration, and sender exclusion.
- Race-safe `410 Unregistered` cleanup using APNs timestamp and token version.
- `BadDeviceToken`/`DeviceTokenNotForTopic` quarantine, repeated-confirmation
  cleanup, and environment-error circuit breaking.
- `429` and `5xx` retry behavior.
- Canonical request digest binding, mismatched-key `409`, concurrent atomic
  claims, seven-day retention, and direct/queued partial-delivery retries.
- Direct-versus-queued delivery selection, transactional outbox recovery, Queue
  retry behavior, and dead-letter handling.
- Channel closure and tombstone enforcement.
- Retention pruning.
- Request-size limits and unknown JSON fields.
- Streaming body-size enforcement, strict authorization syntax, no-store
  responses, HSTS, and fail-closed routing configuration.
- Confirmation that state-listing/history routes do not exist.
- Structured-log schema coverage for every endpoint and important failure path.
- Redaction tests using every capability class, device tokens, installation IDs,
  rejected routes, request bodies, APNs payloads, and malicious upstream error
  strings.
- Confirmation that attacker-controlled app IDs, event names, operations, and
  APNs reasons become fixed telemetry sentinels rather than new dimensions.
- Analytics dimensions and measures for every required metric.
- Confirmation that aggregate data contains no high-cardinality user, channel,
  request, route, or device values.
- Confirmation that log/analytics failures never alter API or delivery results.
- Telemetry schema-version compatibility.

### Manual verification

- Xcode development build against `apnw-dev` on two physical devices.
- TestFlight build against `apnw-prod` on two physical devices.
- App Attest key registration and channel provisioning in both environments,
  including cross-environment rejection.
- Foreground, background, terminated, offline, and notification-disabled states.
- APNs token rotation/reinstallation behavior.
- Generic activity-screen behavior after underlying CloudKit state changes or is
  deleted.
- Keychain accessibility, App Group outbox redaction, iCloud account change, and
  ordered participant-revocation behavior.

Push delivery cannot be fully validated in Simulator. Simulator testing remains
useful for notification permission UI, generic activity-screen handling, and
handling injected notification payloads.

## Implementation decisions

The v1 implementation resolved the original open decisions as follows:

1. The shared capability permits publishing and first registration. Per-
   installation capabilities protect token updates, unregister, and sender
   exclusion. Only the privately held administrator capability permits channel
   close or rotation.
2. Events bind their idempotency key to a canonical request digest and keep
   per-installation delivery state for seven days. Client outbox entries expire
   after 72 hours. Accepted and permanent targets are not retried; explicit
   transient targets are. An interrupted in-flight target becomes ambiguous and
   is not resent, favoring duplicate prevention in that narrow crash window.
3. V1 accepts no client route or deep link. Every notification opens a generic
   activity screen, which reloads authoritative CloudKit state.
4. V1 sends expected private-channel fan-out directly on Workers Paid and has no
   40-device cap. Publishes above the measured safe direct-delivery budget are
   accepted into a transactional outbox and drained by an autoscaling Queue
   consumer rather than rejected.
5. Initial per-capability token buckets allow bursts of 60 registrations, 60
   unregistrations, 30 publishes, and 5 closure attempts per minute. They isolate
   one abusive channel and do not cap aggregate traffic across independent
   channels. App-wide and source-IP signals are adaptive incident controls only.
6. Pairing creators close abandoned or revoked channels with their private
   administrator capability. APNW deliberately has no global channel directory
   or server-side enumerator.
7. V1 supports one Apple Developer team with separate environment-restricted
   development and production APNs keys. Cross-team credential selection is a
   future extension.
8. Security failures, validation failures, rate limits, cleanup-circuit changes,
   dead letters, and internal errors are logged at 100%. Successful high-volume
   operations start at 10% sampling through `LOG_SAMPLE_RATE`; Analytics Engine
   provides aggregate coverage.
9. V1 ships queries and automated alerts for cleanup-circuit activation,
   sustained Worker `5xx`, production APNs authentication failure, and Queue dead
   letters. Lower-severity trend alerts may remain manual until traffic
   establishes meaningful baselines.

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
- [Apple: Establishing an environment-specific token-based APNs connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Apple: Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Apple: Handling notification responses from APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)
- [Apple: Establishing your app's integrity with App Attest](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity)
- [Apple: Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
- [Apple: Assessing App Attest fraud risk](https://developer.apple.com/documentation/devicecheck/assessing-fraud-risk)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Durable Object design and sharding](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Cloudflare Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
