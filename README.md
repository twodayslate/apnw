# APNW

APNW (Apple Push Notification Worker) is a small, multi-app APNs provider built
on Cloudflare Workers and SQLite-backed Durable Objects. It lets native Apple
apps send server-controlled notification events without embedding a global
publisher secret or adding a third-party push SDK.

One APNW deployment can support multiple apps owned by the same Apple Developer
team. Each app has its own bundle ID, route allowlist, and fixed notification
templates in `src/apps.ts`. APNW sets the APNs `apns-topic` header from that
registry.

The repository deploys the same code twice:

| Worker | APNs endpoint | Use it for |
| --- | --- | --- |
| `apnw-dev` | `api.sandbox.push.apple.com` | Xcode development builds |
| `apnw-prod` | `api.push.apple.com` | TestFlight and App Store builds |

Do not mix their URLs or device tokens. A TestFlight build uses the production
APNs environment even when it is being tested internally.

## What is implemented

- Capability-authenticated device registration, removal, event publication,
  and channel closure.
- One strongly consistent Durable Object per app and private channel.
- Multi-app APNs topic selection from a checked-in registry.
- ES256 APNs provider JWT creation with a 50-minute cache.
- Fixed, server-controlled notification title/body templates.
- Optional deep-link routes restricted to each app's allowed URL schemes.
- Sender exclusion.
- A maximum of 40 registered devices per channel for synchronous v1 delivery.
- Per-channel request limits.
- Stale APNs token cleanup.
- Per-target idempotency state: successful deliveries are not resent when a
  transient failure is retried.
- A permanent tombstone after a channel is closed.
- Reviewed structured logs and aggregate Analytics Engine metrics.
- Separate development and production Worker scripts, Durable Object
  namespaces, and analytics datasets.

APNW intentionally has no public channel list, device list, message history,
statistics endpoint, dashboard, arbitrary notification-content endpoint, or
wildcard CORS policy.

## Security model

A channel capability is a minimum of 256 random bits encoded as unpadded
base64url. Possession of that capability authorizes registration,
unregistration, allowed event publication, and channel closure for that private
channel.

The capability is sent only as:

```http
Authorization: Bearer <channel-capability>
```

The Worker derives the Durable Object name using:

```text
HMAC-SHA256(CHANNEL_HMAC_KEY, appID + ":" + capability)
```

The raw capability is never stored or logged. Device tokens, installation IDs,
routes, request bodies, notification payloads, and application-domain
identifiers are also excluded from APNW logs and analytics.

This is cooperative capability security, not user identity. Anyone who receives
a channel capability can exercise all channel operations, including closure.
For Chain of Custody, distribute the capability inside the pairing's encrypted
CloudKit payload. If participants must have different privileges, add an
identity service or separate administrator capability before using APNW for
that scenario.

## Architecture

```text
iOS app
  |
  | HTTPS + private channel capability
  v
Cloudflare Worker
  |
  | validate app, credential, body, event, and route
  v
SQLite Durable Object for HMAC(app + channel)
  |
  | device registry + bounded delivery/idempotency ledger
  v
Apple Push Notification service
```

The Durable Object stores only operational state. It does not store
notification title, body, route, or APNs payload. Completed event ledgers are
pruned after 30 days and kept to at most 1,000 rows per channel.

## Prerequisites

Before starting, have:

1. A Mac or other development machine with Node.js 22 or newer, npm, Git,
   OpenSSL, and `curl`.
2. A Cloudflare account that can run Workers, SQLite Durable Objects, and
   Analytics Engine. Analytics Engine plan availability is documented in the
   [Cloudflare Analytics Engine docs](https://developers.cloudflare.com/analytics/analytics-engine/).
3. Access to the Apple Developer team that owns every bundle ID being added.
4. An iOS app with a real, explicit bundle ID. Wildcard App IDs cannot use push
   notifications.
5. At least one physical Apple device for end-to-end development testing and a
   TestFlight build for production-environment verification.

Useful primary references:

- [Apple: establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Apple: create a private key](https://developer.apple.com/help/account/keys/create-a-private-key)
- [Apple: register with APNs](https://developer.apple.com/documentation/uikit/registering-your-app-with-apns)
- [Cloudflare: Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare: Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Cloudflare: Workers observability](https://developers.cloudflare.com/workers/observability/)

## 1. Prepare every app in Apple Developer

Repeat this section for each iOS app APNW will support.

1. Sign in to the Apple Developer portal.
2. Open Certificates, Identifiers & Profiles.
3. Open Identifiers and select the app's explicit App ID.
4. Enable the Push Notifications capability and save the change.
5. In Xcode, select the application target, open Signing & Capabilities, and add
   Push Notifications.
6. Add Background Modes only if the app genuinely needs background remote
   notification handling. APNW v1 sends visible `alert` pushes and does not
   require the `content-available` background mode merely to display them.
7. Confirm the Xcode bundle identifier exactly matches the value that will be
   entered in `src/apps.ts`. Bundle IDs are case-sensitive APNs topics.
8. Refresh signing assets if Xcode does not immediately pick up the entitlement.

The app must ask the user for notification authorization and call
`UIApplication.shared.registerForRemoteNotifications()`. Apple then returns a
device token to the application delegate. That token belongs to one bundle ID,
one app installation, and one APNs environment.

## 2. Create the APNs signing key

The initial implementation assumes every configured app belongs to one Apple
Developer team.

1. In Certificates, Identifiers & Profiles, open Keys.
2. Create a key with Apple Push Notifications service enabled.
3. Choose a team-scoped key if Apple presents a scope choice and the key should
   serve all of the team's configured apps.
4. Record the 10-character Key ID.
5. Record the Apple Developer Team ID from Membership details.
6. Download the `.p8` private key immediately and store it in a password
   manager or another restricted secret store. Apple normally permits a private
   key download only once.
7. Never commit the `.p8` file. This repository ignores `*.p8` and `*.pem`, but
   ignore rules are a backstop rather than a secret-management system.

One team-scoped signing key can authenticate both sandbox and production APNs
requests and can serve multiple bundle IDs on that team. APNW chooses the
environment by deployment and the bundle ID by app registry entry.

## 3. Install and inspect APNW

```bash
git clone <your-apnw-repository-url>
cd apnw
npm install
npm run check
```

`npm run check` runs strict TypeScript checking and the Worker-runtime test
suite. Tests use Miniflare/workerd and a test-only APNs signing key; they do not
contact Apple.

The important files are:

```text
src/apps.ts                         app, bundle, route, and template registry
src/index.ts                        HTTP router and response policy
src/channel/ChannelObject.ts        device and delivery state
src/apns/                           APNs JWT, payload, and request code
src/observability/                  reviewed log and analytics schemas
wrangler.jsonc                      dev/prod Cloudflare configuration
analytics/                          checked-in Analytics Engine queries
docs/observability.md               monitoring and triage runbook
```

## 4. Configure the app registry

Edit `src/apps.ts`. An entry looks like:

```ts
export const apps = {
  chain_of_custody: {
    bundleID: "com.twodayslate.coc",
    routeSchemes: ["coc"],
    templates: {
      submission_ready: {
        title: "CoC update",
        body: "A response is ready for review.",
      },
    },
  },
} as const;
```

Rules:

- `appID` is the stable API identifier. Use lowercase letters, numbers, and
  underscores.
- `bundleID` must exactly match the App ID and signed app.
- Every event template is fixed in source control. A client can select an event
  name but cannot supply a title or body.
- `routeSchemes` contains URL schemes the app has registered and is prepared to
  validate. APNW rejects routes with any other scheme.
- Keep notification copy generic. Do not place user-authored, decrypted
  CloudKit, health, financial, or other sensitive content in templates.
- Add tests when adding an app, topic, route scheme, or template.

Run this after editing:

```bash
npm run check
```

### Adding a second app

Add another top-level registry entry:

```ts
export const apps = {
  chain_of_custody: {
    // ...
  },
  another_app: {
    bundleID: "com.example.another",
    routeSchemes: ["another"],
    templates: {
      activity_available: {
        title: "App update",
        body: "New activity is available.",
      },
    },
  },
} as const;
```

No second Worker is required when the app belongs to the same Apple Developer
team. APNW includes the app ID in the channel-object derivation, so identical
capabilities used by two apps still address different Durable Objects.

Apps owned by another Apple Developer team need another Team ID, Key ID, private
key, and provider-token cache entry. That is not implemented in v1; do not add a
cross-team app by reusing the existing credentials.

## 5. Generate channel-derivation secrets

Generate a different secret for each Cloudflare deployment:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Run it twice. Label the outputs `development` and `production` in your password
manager. Each output represents 32 random bytes as unpadded base64url.

`CHANNEL_HMAC_KEY` is not a routine rotation key. Changing it makes every
existing capability derive a different Durable Object, so existing channel
registrations become unreachable. See “Incident response and rotation” before
changing it on a deployed environment.

## 6. Configure local development secrets

Create the ignored local secret file:

```bash
cp .dev.vars.example .dev.vars
```

Base64-encode the complete `.p8` file as one line:

```bash
base64 < /secure/path/AuthKey_XXXXXXXXXX.p8 | tr -d '\n'
```

Populate `.dev.vars`:

```dotenv
APNS_KEY_P8=<the complete base64 output>
APNS_KEY_ID=<Apple Key ID>
APNS_TEAM_ID=<Apple Team ID>
CHANNEL_HMAC_KEY=<development HMAC secret>
```

Do not quote values in `.dev.vars`, do not add spaces around `=`, and do not
commit the file.

Start the local Worker:

```bash
npm run dev
```

In another terminal:

```bash
curl --fail-with-body http://localhost:8787/health
```

Expected shape:

```json
{"status":"ok","environment":"development","version":"local"}
```

Local Durable Object state is under `.wrangler/` and is ignored by Git.
Publishing to a locally registered real token contacts sandbox APNs. Use test
credentials and development tokens only.

## 7. Authenticate Wrangler

Use Cloudflare's browser login for local administration:

```bash
npx wrangler login
npx wrangler whoami
```

Confirm the displayed account is the intended account before setting secrets or
deploying. For CI, use a narrowly scoped `CLOUDFLARE_API_TOKEN` rather than an
interactive login. Follow Cloudflare's
[Wrangler authentication guide](https://developers.cloudflare.com/workers/wrangler/commands/#login).

If the login belongs to multiple accounts and Wrangler chooses the wrong one,
add the intended `account_id` to `wrangler.jsonc`.

## 8. Review Cloudflare environments

`wrangler.jsonc` defines:

- Top-level `apnw-dev`, with `APNS_ENVIRONMENT=development`.
- Named environment `production`, deployed as `apnw-prod`, with
  `APNS_ENVIRONMENT=production`.
- A local `CHANNELS` binding in each script. Because these are different Worker
  scripts, their Durable Object namespaces and tokens are isolated.
- `apnw_dev` and `apnw_prod` Analytics Engine datasets.
- A `v1` SQLite Durable Object migration.
- 100% custom log sampling.
- Automatic invocation logs enabled for development and disabled for
  production. Production still emits APNW's reviewed completion log.

Before a release, replace the `SERVICE_VERSION` value in both environment
sections with a release tag or Git commit SHA. This makes regressions queryable
by version.

To use custom domains, add a development route at top level and a production
route inside `env.production`:

```jsonc
{
  "routes": [
    { "pattern": "push-dev.example.com", "custom_domain": true }
  ],
  "env": {
    "production": {
      "routes": [
        { "pattern": "push.example.com", "custom_domain": true }
      ]
    }
  }
}
```

The hostname must be in a zone available to the Cloudflare account. Keep
`workers_dev: true` during initial verification if you want the generated
`workers.dev` fallback; set it to `false` after the custom domains are proven if
you want to remove that alternate public hostname.

Bindings are non-inheritable between Wrangler environments. If you add a
binding later, add it to both top-level development and `env.production`.

## 9. Set development Worker secrets

Wrangler secrets are per Worker environment. Set all four for development:

```bash
base64 < /secure/path/AuthKey_XXXXXXXXXX.p8 \
  | tr -d '\n' \
  | npx wrangler secret put APNS_KEY_P8 --env=""

printf '%s' '<Apple Key ID>' \
  | npx wrangler secret put APNS_KEY_ID --env=""
printf '%s' '<Apple Team ID>' \
  | npx wrangler secret put APNS_TEAM_ID --env=""
printf '%s' '<development HMAC secret>' \
  | npx wrangler secret put CHANNEL_HMAC_KEY --env=""
```

Then verify only the secret names:

```bash
npx wrangler secret list --env=""
```

Do not paste a secret into a command if your shell records it in history. The
examples above show placeholders; a password-manager CLI or protected
environment variable can feed `stdin` instead.

## 10. Validate and deploy development

Run all local gates:

```bash
npm run check
npx wrangler deploy --dry-run --env=""
```

Deploy:

```bash
npm run deploy:dev
```

The first real deployment creates the Worker, applies the SQLite Durable Object
migration, and binds the development analytics dataset. Save the exact URL
Wrangler reports.

Smoke-test the deployed URL:

```bash
export APNW_DEV_URL="https://apnw-dev.<your-subdomain>.workers.dev"
curl --fail-with-body "$APNW_DEV_URL/health"
```

Check reviewed custom logs:

```bash
npx wrangler tail --env=""
```

At this point, perform a sandbox APNs test with an Xcode development build on
physical devices. Do not proceed directly to production merely because
`/health` works; health does not validate Apple credentials or a device token.

## 11. Set production secrets

Use the same APNs `.p8`, Key ID, and Team ID if all apps are on the same team.
Use the separately generated production HMAC secret:

```bash
base64 < /secure/path/AuthKey_XXXXXXXXXX.p8 \
  | tr -d '\n' \
  | npx wrangler secret put APNS_KEY_P8 --env production

printf '%s' '<Apple Key ID>' \
  | npx wrangler secret put APNS_KEY_ID --env production
printf '%s' '<Apple Team ID>' \
  | npx wrangler secret put APNS_TEAM_ID --env production
printf '%s' '<production HMAC secret>' \
  | npx wrangler secret put CHANNEL_HMAC_KEY --env production
```

Verify names in the production environment:

```bash
npx wrangler secret list --env production
```

Never copy the development HMAC secret into production. Separate HMAC secrets
are part of the boundary that prevents a capability from addressing the same
channel state in both environments.

## 12. Deploy production

Validate both configurations:

```bash
npm run check
npx wrangler deploy --dry-run --env production
```

Deploy:

```bash
npm run deploy:production
```

Smoke-test and tail:

```bash
export APNW_PROD_URL="https://apnw-prod.<your-subdomain>.workers.dev"
curl --fail-with-body "$APNW_PROD_URL/health"
npx wrangler tail --env production
```

Verify a real push using a TestFlight build on physical devices. A development
build's token will not work against production APNs, and a TestFlight token will
not work against sandbox APNs.

## API usage

All state-changing calls require a channel capability. Generate client
capabilities with a platform cryptographic random-number generator. For a
one-off command-line test:

```bash
export APNW_URL="http://localhost:8787"
export APNW_APP_ID="chain_of_custody"
export APNW_CAPABILITY="$(
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
)"
export APNW_INSTALLATION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
```

These exported values are for a disposable test channel. In an app, persist the
installation ID for the life of the installation and put the capability only
in the app's protected collaboration data.

### Health

```bash
curl --fail-with-body "$APNW_URL/health"
```

### Register or replace a device token

```bash
export APNS_DEVICE_TOKEN="<lowercase hexadecimal token from iOS>"

curl --fail-with-body \
  -X PUT \
  -H "Authorization: Bearer $APNW_CAPABILITY" \
  -H "Content-Type: application/json" \
  --data "{\"deviceToken\":\"$APNS_DEVICE_TOKEN\"}" \
  "$APNW_URL/v1/apps/$APNW_APP_ID/devices/$APNW_INSTALLATION_ID"
```

Registration is idempotent. Sending a new token for the same installation ID
replaces the old token.

### Publish a fixed event

```bash
export APNW_EVENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $APNW_CAPABILITY" \
  -H "Idempotency-Key: $APNW_EVENT_ID" \
  -H "Content-Type: application/json" \
  --data "{
    \"event\":\"submission_ready\",
    \"excludeInstallationID\":\"$APNW_INSTALLATION_ID\",
    \"route\":\"coc://submission/example\"
  }" \
  "$APNW_URL/v1/apps/$APNW_APP_ID/events"
```

Response:

```json
{
  "eventID": "the-idempotency-key",
  "deviceCount": 2,
  "accepted": 2,
  "failed": 0,
  "retryable": false
}
```

If APNs returns a transient error, APNW responds with `503`, includes
`Retry-After`, and returns `retryable: true`. Retry the exact same request with
the same idempotency key. APNW sends only to targets whose previous attempt was
transient; accepted and permanent-failure targets are not replayed.

If an execution stops after a target is marked “attempting” but before its APNs
result is recorded, APNW does not resend that target. This narrow crash policy
chooses duplicate prevention over guaranteed delivery. Notifications should be
generic synchronization nudges; the app's durable data remains the source of
truth.

Reusing an idempotency key with a different event, route, or excluded
installation returns `409`.

### Unregister an installation

```bash
curl --fail-with-body \
  -X DELETE \
  -H "Authorization: Bearer $APNW_CAPABILITY" \
  "$APNW_URL/v1/apps/$APNW_APP_ID/devices/$APNW_INSTALLATION_ID"
```

This succeeds even when the installation is already absent.

### Close a channel

```bash
curl --fail-with-body \
  -X DELETE \
  -H "Authorization: Bearer $APNW_CAPABILITY" \
  "$APNW_URL/v1/apps/$APNW_APP_ID/channel"
```

Closing deletes the channel's devices and event ledger and leaves a permanent
tombstone. The old capability cannot recreate the channel. Create a new random
capability to replace it.

## iOS integration checklist

APNW does not ship an iOS SDK. A small `URLSession` client is sufficient.

1. Request notification authorization using `UNUserNotificationCenter`.
2. On approval, call
   `UIApplication.shared.registerForRemoteNotifications()`.
3. Convert the `Data` returned by
   `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` to
   lowercase hexadecimal:

   ```swift
   let token = deviceToken.map { String(format: "%02x", $0) }.joined()
   ```

4. Generate one random installation UUID on first launch. Store it somewhere
   appropriate for the desired reinstall behavior. Chain of Custody should use
   its shared App Group so the main app and Messages extension agree.
5. Generate each channel capability with 32 random bytes and base64url encoding
   without padding. Never derive it from a pairing name, CloudKit ID, user ID,
   password, or UUID.
6. Store a channel capability only in the collaboration's protected/encrypted
   data. Do not put it in a URL, notification payload, analytics event, or
   ordinary application log.
7. Register the installation with every active private channel after receiving
   the token.
8. Reconcile registrations when APNs rotates the token, iCloud identity
   changes, collaboration membership changes, or protected state is restored.
9. Unregister when leaving a collaboration. Close and replace the channel when
   continued access by a former capability holder must be revoked.
10. After the app's durable CloudKit mutation succeeds, add the corresponding
    APNW request to a persistent local outbox.
11. Give every outbox item a stable idempotency key and retry `429`/`503` with
    exponential backoff, jitter, and the server's `Retry-After`.
12. Remove an outbox item only after a non-retryable response or successful
    result.
13. Validate notification routes again in the app before navigating. A route
    is a hint, and its referenced record may have changed or been deleted.
14. Fetch current data from CloudKit after receipt. Never treat a notification
    payload as the authoritative application state.

The client request should set `Authorization`, `Content-Type`, and, for
publication, `Idempotency-Key`. Use ephemeral `URLSession` configuration if the
app should avoid URL cache/cookie persistence. Do not print the request,
headers, or body during debugging.

## Logs and analytics

APNW emits exactly one custom completion log per request. Production automatic
invocation logs are disabled in `wrangler.jsonc`; the reviewed custom schema
remains enabled. Successful logs follow `LOG_SAMPLE_RATE`, which defaults to
`1`. Errors are always logged.

Tail logs:

```bash
npx wrangler tail --env=""
npx wrangler tail --env production
```

The analytics schema is documented in `analytics/README.md`. Queries cover
delivery rate, APNs categories, p50/p95 latency, registration activity,
rejections, idempotency behavior, and service-version regressions.

To run a production query through Cloudflare's SQL API:

1. Create a Cloudflare API token with Account Analytics Read access.
2. Find the account ID in `npx wrangler whoami` or the dashboard.
3. Export both values in a protected shell:

   ```bash
   export CLOUDFLARE_ACCOUNT_ID="<account id>"
   export CLOUDFLARE_ANALYTICS_TOKEN="<read-only API token>"
   ```

4. Execute a checked-in query:

   ```bash
   curl --fail-with-body \
     -X POST \
     -H "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
     --data-binary @analytics/delivery-rate.sql \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql"
   ```

Replace `apnw_prod` with `apnw_dev` in a query to inspect development. Do not
add request IDs, channels, routes, device identifiers, capabilities, or other
high-cardinality user values to Analytics Engine.

Initial thresholds and triage steps are in `docs/observability.md`.

## Rate limiting and abuse controls

Each channel object currently permits:

| Operation | Limit |
| --- | --- |
| Register | 60/minute/channel |
| Unregister | 60/minute/channel |
| Publish | 30/minute/channel |
| Close | 5/minute/channel |

The Worker caps request bodies at 8 KiB, routes at 1,024 characters,
idempotency keys at 128 characters, device tokens at 256 decoded bytes, and
channels at 40 devices.

For a public production hostname, add a Cloudflare WAF/rate-limiting rule for
obvious source-IP abuse. Do not log source IPs in APNW application logs. Choose
an IP threshold high enough to allow multiple legitimate devices behind one
NAT, and apply stricter channel-level limits in code when usage data justifies
it.

## APNs key rotation

Rotate the APNs signing key without changing channel state:

1. Create a replacement APNs key in Apple Developer and securely download it.
2. Record the new Key ID.
3. Update `APNS_KEY_P8` and `APNS_KEY_ID` on `apnw-dev`.
4. Send a real development push and verify both APNs acceptance and receipt.
5. Update the two production secrets with `--env production`.
6. Send a TestFlight production push and verify it.
7. Monitor logs for `invalid_provider_token` and `topic_error`.
8. Revoke the old Apple key only after both environments have successfully used
   the replacement and rollback no longer depends on the old credential.
9. Update the restricted recovery record with the new key location and date.

Changing a Wrangler secret creates new deployed secret state. Coordinate the
two secret updates closely so the key ID and private key do not remain
mismatched.

## HMAC-key incident response

Do not rotate `CHANNEL_HMAC_KEY` as routine maintenance. A new value points all
existing capabilities at empty Durable Objects while old registrations remain
in the old namespace and cannot be enumerated through APNW.

If the HMAC key is compromised:

1. Preserve the current value in a restricted incident record long enough to
   close known old channels through their capabilities.
2. Stop publication if the threat requires it.
3. Generate and deploy a new environment-specific HMAC key.
4. Issue new channel capabilities through the app's protected data flow.
5. Re-register devices on replacement channels.
6. Close old channels using their old capability while the old HMAC key can
   still be used in a controlled maintenance deployment.
7. Remove the old key after the migration window.

This procedure is intentionally manual in v1 because APNW has no channel
directory and cannot enumerate or migrate private channels.

## Rollback

List deployed versions:

```bash
npx wrangler versions list --env=""
npx wrangler versions list --env production
```

Roll back the affected environment:

```bash
npx wrangler rollback <version-id> --env=""
npx wrangler rollback <version-id> --env production
```

After rollback, verify `/health`, the reported service version, one registration,
one real APNs delivery in the matching environment, custom logs, and Analytics
Engine points. A code rollback does not make sandbox and production tokens
interchangeable.

SQLite schema changes require extra care. Add new Durable Object migration tags
instead of editing or reusing `v1`, make runtime schema upgrades forward
compatible, and test rollback behavior before production.

## Troubleshooting

### `/health` works but pushes return `503`

- Tail the correct environment.
- Confirm all APNs secret names exist in that environment.
- Re-encode the entire `.p8`; a missing PEM line or wrapped/truncated base64
  value prevents signing.
- Confirm the Key ID belongs to that `.p8` and the Team ID is correct.
- Look at the allowlisted APNs category in logs. Raw Apple bodies are
  intentionally not logged.

### `bad_device_token` or `unregistered`

- Confirm the app sent lowercase hexadecimal token data rather than the
  description of `Data` with angle brackets/spaces.
- Confirm the token came from the same bundle ID as `apns-topic`.
- Confirm a development token is going to `apnw-dev`, or a TestFlight/App Store
  token is going to `apnw-prod`.
- `BadDeviceToken` and `Unregistered` registrations are removed automatically.

### `topic_error`

- Compare the signed bundle ID with `src/apps.ts`.
- Confirm Push Notifications is enabled for the App ID.
- Confirm the APNs key is authorized for that topic/team.
- Check for accidental whitespace or case differences.

### `invalid_provider_token` or `expired_provider_token`

- Verify Team ID, Key ID, and `.p8` pairing.
- Confirm the key has not been revoked.
- Re-deploy or update secrets after correcting them. APNW caches a provider JWT
  for no more than 50 minutes per Worker isolate.

### Registration or publish returns `404`

APNW deliberately uses opaque `404` responses for unknown apps, malformed
capabilities, and closed channels. Check the app ID, capability encoding, and
whether the channel was closed. Do not add diagnostic responses that reveal
which portion was valid.

### Publish returns `409`

- `channel_full`: the channel already has 40 installations. Use a queue/broadcast
  design before increasing the limit.
- `idempotency_conflict`: the same key was reused with different request
  semantics. Fix the client outbox to keep one immutable request per key.

### Publish returns `429`

The per-channel rate limit was exceeded. Honor `Retry-After`, use exponential
backoff with jitter, and investigate a stuck client outbox.

### Local behavior differs from deployed behavior

Run:

```bash
npx wrangler dev --remote
```

Remote development uses Cloudflare infrastructure and can be more
production-like, but it also uses remote resources. Use only the development
environment and development credentials.

## Testing and release checklist

Before every deployment:

```bash
npm ci
npm run check
npx wrangler deploy --dry-run --env=""
npx wrangler deploy --dry-run --env production
git status --short
```

The automated suite covers:

- Capability validation and app/channel isolation.
- Worker request validation and opaque failures.
- Registration, replacement, unregistration, and closure tombstones.
- Sender exclusion and idempotent repeats.
- Partial APNs retries without redelivery to accepted targets.
- APNs JWT structure/cache, environment hosts, topic headers, and safe error
  categories.
- Reviewed log redaction and aggregate analytics privacy.
- Absence of public state/history routes.

Before declaring a release production-ready, manually verify:

- Two physical devices with a development build through `apnw-dev`.
- Two physical devices with TestFlight through `apnw-prod`.
- Foreground, background, terminated, offline, and notifications-disabled
  behavior.
- Token change after reinstall.
- Leaving, blocking, channel replacement, and channel closure.
- Route handling when the underlying CloudKit record changed or disappeared.
- A custom log and analytics point in each environment without prohibited data.
- Every checked-in production analytics query against smoke-test data.

## Inspiration and prior art

APNW's implementation and design were informed by:

- [AndrewBarba/apns2](https://github.com/AndrewBarba/apns2) for APNs provider
  modeling and response behavior.
- [jonesphillip/paje](https://github.com/jonesphillip/paje) for a compact push
  service design and the importance of clearly separating convenience from
  access control.
- [FiveSheepCo/cloudflare-apns2](https://github.com/FiveSheepCo/cloudflare-apns2)
  for Workers-compatible APNs token signing and request construction.
- [Pushy design article](https://codakuma.com/pushy/) for the deliberately small
  Cloudflare-hosted service shape.

APNW does not copy their public dashboard/history model. Its state routes are
capability-authenticated, notification content is fixed in source, and
observability is private and aggregate.

The full design rationale and deferred decisions remain in `Plan.md`.
