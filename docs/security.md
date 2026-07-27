# Security model and review notes

## Protected properties

- A random or merely well-formed channel capability cannot create live state.
- App Attest registration checks Apple's chain, nonce, public-key binding, app
  RP ID, environment, initial counter, validation category, and bundle version.
- Provisioning challenges expire in five minutes, are single-use, and bind the
  exact app/channel/administrator transaction.
- Assertion counters advance with a guarded atomic update. Concurrent uses of
  one counter cannot both succeed.
- Shared capability possession alone cannot update or remove an installation,
  claim sender exclusion, or close the channel.
- Durable Object routing depends only on a versioned public hash construction,
  so rotating telemetry or Apple secrets does not orphan channels.
- Idempotency claims include the event, exclusion, and exact client timestamp
  and remain for seven days without count-based eviction.
- A stale APNs response can mutate only the snapshotted installation, token, and
  token version.
- Notification content is selected from source control and contains no
  user-authored content or application identifiers.

## Threat model

Assume an attacker can send arbitrary HTTP headers and bodies, replay and race
requests, obtain capabilities intentionally shared with them, control their own
real app installation, and induce malformed APNs responses in tests.

Assume the attacker cannot forge Apple's App Attest chain/signatures, extract a
Secure Enclave private key under Apple's stated model, compromise Cloudflare or
Apple, or obtain Worker secrets.

App Attest is a provisioning gate and abuse signal, not identity or
authorization for collaboration membership. A genuine but malicious app
instance can still misuse capabilities it legitimately receives. The app must
enforce membership in its authoritative CloudKit model and distribute
capabilities only through end-to-end encrypted records.

Jailbroken devices and single compromised devices acting as assertion relays
remain residual risks. APNW exchanges the untrusted attestation receipt with
Apple, validates the returned PKCS#7 chain/signature, App ID, DER public key,
creation time, expiry, receipt type, and risk metric, and refreshes it using
Durable Object alarms. A known metric above the per-app threshold blocks
provisioning and remains blocked through refresh failures. Receipt bytes are
never logged or joined to channel state.

Fraud assessment is deliberately fail-open only when Apple or the network is
unavailable before any metric has been accepted. This preserves independent
client availability but leaves a temporary relay-abuse window; retries use
bounded exponential backoff. Tune `maxFraudRiskMetric` from observed legitimate
reinstall, restore, and device-transfer behavior rather than treating the metric
as identity.

## Capability handling

Channel, administrator, installation, and installation-ID values are generated
independently. Never derive one from another. Raw values belong in
ThisDeviceOnly Keychain items and encrypted CloudKit pairing material only.

The server stores SHA-256 role digests for administrator and installation
capabilities. It stores no shared channel capability. Comparisons use a
constant-work byte loop after strict length validation.

The daily log correlation value is an HMAC of date plus channel object name.
Changing `LOG_CORRELATION_KEY` affects only future diagnostic correlation.

## Parsing boundary

- Authorization headers reject lists, controls, padding, and ambiguous
  whitespace.
- Body length is enforced both from `Content-Length` and while streaming.
- JSON rejects invalid UTF-8, nonobjects, unknown fields, and duplicate keys.
- CBOR rejects indefinite lengths, excessive depth/collection size, trailing
  data, duplicate semantic map keys, and unexpected types.
- DER nonce parsing accepts only Apple's exact nested structure.
- App Attest certificate trust terminates only at the configured Apple root;
  roots supplied in the attestation object are not trusted.

Each provisioning shard retains at most 512 outstanding challenges. Consumed
challenges are deleted immediately, and expired challenges are pruned before
capacity is evaluated, so attacker-selected key IDs cannot grow challenge
storage without bound.

## APNs cleanup

- A `410` deletes only the matching token version when its registration time is
  not newer than Apple's millisecond invalidation timestamp.
- A timestamp-free `410` does not delete.
- One `BadDeviceToken` quarantines the version; a second matching failure is
  required for deletion.
- `DeviceTokenNotForTopic`, topic, provider-token, and environment errors never
  delete registrations.
- Ten cleanup/configuration candidates exceeding 5% in five minutes suspend
  cleanup. Provider/environment errors and sustained upstream failures open the
  delivery circuit and defer remaining work.

## Scale versus abuse controls

There is no global or app-wide quota. Per-channel controls are generous
short-window isolation controls (10,000 registration mutations and 1,200
publishes per minute), so unrelated channels do not compete. Provisioning uses
256 shards per app and per-shard controls. Edge source-IP rules are emergency
signals only because carrier NAT and Private Relay aggregate legitimate users.

The repository's 205-recipient test proves removal of the former 40-device
ceiling and correct multi-batch partitioning. Production capacity acceptance
still requires the distributed 10,000-operation load test described in
`Plan.md`; a unit test is not evidence of Cloudflare account-level capacity.

## Secret response

If an APNs or DeviceCheck key is exposed, revoke it in Apple Developer, deploy a
replacement to the affected environment, verify `/health`, and watch
provider-token and queue metrics. Channel capabilities are unaffected.

If a channel capability is exposed, remove the unauthorized member in the
authoritative app workflow, close the old APNW channel with the administrator
capability, create a new channel and capabilities, and distribute them only
after membership revocation is confirmed.
