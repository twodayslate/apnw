# Deployment runbook

## Apple preparation

For each app:

1. Enable Push Notifications and App Attest for its explicit App ID.
2. Confirm `src/apps.ts` uses the exact case-sensitive bundle ID.
3. Configure the appropriate App Attest environment entitlement for the build.
4. Obtain separate development and production APNs key material and record the
   environment restriction used by each deployment.
5. Create a DeviceCheck-enabled key for App Attest fraud receipts.
6. Download Apple's App Attest root certificate from Apple's certificate
   authority site and configure it as PEM.

Development physical-device builds use sandbox APNs and development App Attest.
TestFlight and App Store builds use production APNs and production App Attest.

## Cloudflare resources

Create queues before the first deployment:

```bash
npx wrangler queues create apnw-dev-delivery
npx wrangler queues create apnw-dev-delivery-dlq
npx wrangler queues create apnw-prod-delivery
npx wrangler queues create apnw-prod-delivery-dlq
```

`wrangler.jsonc` binds separate Durable Objects, queues, DLQs, and Analytics
Engine datasets by environment. Do not point both deployments at one namespace
or queue.

Production sets `workers_dev: false`. Add the intended custom domain/route in
Cloudflare before deployment and ensure there is no DNS origin or alternate
route that bypasses the Worker. Keep preview URLs and unrelated routes disabled.
HSTS is also returned by the Worker.

Use phishing-resistant maintainer MFA, least-privilege Cloudflare roles, and a
CI token restricted to this Worker and its required resources.

## Secrets

Set each value separately in development:

```bash
npx wrangler secret put APNS_KEY_P8
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APP_ATTEST_ROOT_CERT_PEM
npx wrangler secret put DEVICECHECK_KEY_P8
npx wrangler secret put DEVICECHECK_KEY_ID
npx wrangler secret put LOG_CORRELATION_KEY
```

Repeat with `--env production` using production-only values. Never copy the
production private keys to development.

`APNS_ENVIRONMENT`, `APNS_KEY_ENVIRONMENT`, and `APP_ATTEST_ENVIRONMENT` must all
match. `/health` returns `503` when their declared environments differ. Set
`SERVICE_VERSION` to the immutable release identifier. The checked-in production
value is deliberately `unset`, which fails all runtime work closed. Use
`npm run deploy:production`; it overrides the placeholder with the exact Git
commit being deployed.

`/health` also imports both Apple private keys, validates their identifier
shapes, checks the configured App Attest certificate envelope, and derives a
test correlation reference. It returns `503` without identifying the failed
secret when this local readiness preflight fails. Correlation telemetry remains
best effort for ordinary channel and queue operations.

The four `APNS_CIRCUIT_*` variables in `wrangler.jsonc` tune the documented
minimum-attempt, failure-rate, window, and suspension thresholds without a code
change. Values outside the source-bounded safety range fall back to defaults.

Review each app's `maxFraudRiskMetric` in `src/apps.ts` before release. It is a
rolling device-level abuse signal, not a user limit. Changing it requires a
deployment; do not place the threshold in an unreviewed runtime secret.

## Preflight

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

Review the generated binding list. It must contain `CHANNELS`, `PROVISIONING`,
`DELIVERY_QUEUE`, and `APNW_ANALYTICS`, and no accidental public data store.

## Release order

1. Deploy development.
2. Verify `/health`.
3. On a physical development device, generate/attest a key, provision a fresh
   channel, register, publish direct and queued events, replace a token,
   unregister, and close.
4. Confirm reviewed logs contain no capability, key ID, installation ID, token,
   body, or domain identifier.
5. Confirm queue depth drains and the development DLQ remains empty.
6. Confirm key registration reaches Apple's development fraud-assessment
   endpoint and a normal signed `RECEIPT` metric is accepted.
7. Deploy production.
8. Repeat with a TestFlight build, including the production fraud endpoint.
9. Verify production automatic invocation logs are disabled and custom logs are
   sampled at 10%.

## Edge controls

Keep the application-level 8 KiB stream limit. At the edge, reject unsupported
methods/content types and obviously oversized bodies before Worker execution
where Cloudflare configuration permits. Apply adaptive WAF/rate controls to App
Attest challenge/registration endpoints. Do not use a low global source-IP
limit; carrier NAT and Private Relay can aggregate many real devices.

Application per-channel/per-shard rate controls are abuse isolation, not
capacity ceilings. Queue consumer `max_concurrency` is intentionally unset.

## Monitoring and rollback

Alert on Worker `5xx`, Durable Object overload, APNs configuration categories,
cleanup/delivery circuit activation, repeated DeviceCheck receipt-exchange
errors, queue age/depth, retries, and any DLQ message. See
[observability.md](observability.md).

Rollback by deploying the last known-good version. Channel routing is stable
across code and `LOG_CORRELATION_KEY` rotation. Never roll back to code that
does not support the currently deployed schema version. Queued batches and
Durable Object alarms are idempotent and may be delivered again safely after
rollback.

Rotate an APNs or DeviceCheck key by installing the new key in one environment,
deploying, validating, then revoking the old key. Do not rotate channel
capabilities as part of server-key maintenance.

## Future schema changes

The checked-in Channel and Provisioning schemas are the initial production
version (`v1`); there are no pre-release migrations. For a future schema change:

1. Update the complete create schema for new Durable Objects.
2. Increment that schema's current version by exactly one.
3. Append a sequential migration from the last deployed version to the new
   version. Never edit or remove a migration after it has shipped.
4. Test both fresh creation and migration from every supported deployed version.
5. Deploy to development first and verify existing objects before production.

Existing Channel objects migrate on first use without allowing an unknown
capability to initialize storage. Fixed Provisioning shards migrate when their
Durable Object instance starts. Each schema step and its version update commit
atomically. A Worker fails closed if it encounters a newer schema or a missing
migration step.

## Capacity acceptance

Prepare a secret, ignored JSON fixture containing at least 5,000 already
App-Attest-provisioned test channels. Each entry contains `appID`,
`channelCapability`, `installationCapability`, `installationID`, a unique
hexadecimal `deviceToken`, and an allowlisted `event`. Use a dedicated
nonproduction deployment:

```bash
APNW_LOAD_URL=https://load-apnw.example.com \
APNW_LOAD_FIXTURES=./load-fixtures.local.json \
APNW_LOAD_CONCURRENCY=10000 \
npm run load-test
```

The harness first reconciles one excluded installation per channel outside the
measurement window, then launches two publishes per channel: at least 10,000
concurrent acceptance operations across 5,000 independent Channel Durable
Objects. Exclusion keeps the acceptance test from contacting APNs. It exits
unsuccessfully on any throttle, validation failure, or server error, prints
aggregate latency/throughput only, and never prints fixture secrets. Run
queue/APNs latency saturation separately with an account-owned mock APNs
endpoint in an isolated load deployment; never load-test Apple's production
APNs service.
