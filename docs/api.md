# APNW HTTP API

All responses set `Cache-Control: no-store`, HSTS, `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a
random request ID. There is no CORS policy.

Unknown apps, malformed capabilities, unauthorized installations, closed
channels, unprovisioned channels, and rejected App Attest evidence use the same
opaque `404` response where practical.

All JSON endpoints require `Content-Type: application/json`. Bodies are limited
to 8 KiB while streaming, must be UTF-8 JSON objects, and reject unknown or
duplicate member names.

## Credentials

The channel capability is sent as:

```http
Authorization: Bearer <43-character canonical base64url>
```

The independent role capabilities are sent as:

```http
X-Channel-Admin-Authorization: Bearer <admin capability>
X-Installation-Authorization: Bearer <installation capability>
```

Header parsing permits exactly `Bearer`, one ASCII space, and one canonical
32-byte secret. Lists, padding, extra whitespace, control characters, and
alternate schemes are rejected.

## App Attest

Apple's `keyID` is accepted in its canonical standard-base64 form or canonical
unpadded base64url form and must decode to 32 bytes. App Attest is available only
to the main app, not ordinary app extensions.

### Register a key

1. Generate and persist an App Attest key ID.
2. Request:

```http
POST /v1/apps/{appID}/app-attest/challenge
Content-Type: application/json

{"purpose":"attest_key","keyID":"<Apple key ID>"}
```

3. Decode the returned unpadded-base64url `challenge` and calculate
   `SHA256(challengeBytes)`.
4. Pass that digest to `attestKey(_:clientDataHash:)`.
5. Submit:

```http
POST /v1/apps/{appID}/app-attest/keys
Content-Type: application/json

{
  "keyID":"<Apple key ID>",
  "challengeID":"<UUID from APNW>",
  "attestationObject":"<standard-base64 CBOR>"
}
```

The server consumes the five-minute challenge before expensive validation. It
verifies exactly one bounded CBOR object, the two-certificate chain to the
configured Apple root, certificate validity and constraints, Apple nonce,
credential/public-key match, RP ID, AAGUID environment, zero counter, and
distribution extensions. It stores a second-order key reference, SPKI public
key, counter, and policy signals—not the raw attestation. It immediately sends
the untrusted fraud receipt to Apple's matching App Attest environment, verifies
the returned PKCS#7 signature and chain, then binds the fresh receipt's App ID,
DER public key, and risk metric to the registered key. The latest signed receipt
is refreshed after its `notBefore` time.

The checked-in app policy in `src/apps.ts` rejects channel provisioning while a
verified risk metric exceeds `maxFraudRiskMetric`. Temporary Apple,
authentication-key, or network failures leave a never-accepted receipt pending
and schedule bounded retries; they do not impose a global channel or throughput
limit. Once a key is blocked, refresh failures cannot make it usable again.

### Provision a channel

Request a challenge while presenting both channel and administrator
capabilities:

```http
POST /v1/apps/{appID}/app-attest/challenge
Authorization: Bearer <channel capability>
X-Channel-Admin-Authorization: Bearer <admin capability>
Content-Type: application/json

{"purpose":"provision_channel","keyID":"<Apple key ID>"}
```

The assertion's `clientDataHash` is reproducible by the app:

```text
channelDigest = hex(SHA256(channelCapabilityBytes))
adminDigest = hex(SHA256(adminCapabilityBytes))

bindingDigest = SHA256(UTF8([
  "apnw-provision-binding-v1",
  "PUT",
  "provision_channel",
  environment,
  appID,
  channelDigest,
  adminDigest
].joined(separator: "\n")))

clientDataHash = SHA256(challengeBytes || bindingDigest)
```

Generate the App Attest assertion with that hash, then submit:

```http
PUT /v1/apps/{appID}/channel
Authorization: Bearer <channel capability>
X-Channel-Admin-Authorization: Bearer <admin capability>
Content-Type: application/json

{
  "keyID":"<Apple key ID>",
  "challengeID":"<UUID from APNW>",
  "assertion":"<standard-base64 CBOR>"
}
```

APNW validates the signature, RP ID, policy extensions, and a strictly
increasing unsigned counter, then atomically advances the counter. Provisioning
is idempotent only with the same administrator digest.

## Device registration

`installationID` and the installation capability are independent random
32-byte values created once per app installation and persisted using
ThisDeviceOnly Keychain protection.

```http
PUT /v1/apps/{appID}/device
Authorization: Bearer <channel capability>
X-Installation-Authorization: Bearer <installation capability>
Content-Type: application/json

{"installationID":"<base64url>","deviceToken":"<hex APNs token>"}
```

The first call creates the registration. Later calls require the same
installation capability and replace a changed APNs token with a new token
version. A token owned by another installation is rejected instead of silently
moving it.

```http
DELETE /v1/apps/{appID}/device
Authorization: Bearer <channel capability>
X-Installation-Authorization: Bearer <installation capability>
Content-Type: application/json

{"installationID":"<base64url>"}
```

A correctly authorized deletion is successful when already absent. The
installation ID is in the body so it does not enter edge request-target logs.

## Publish

```http
POST /v1/apps/{appID}/events
Authorization: Bearer <channel capability>
Idempotency-Key: <lowercase UUIDv4>
Event-Created-At: <RFC3339 timestamp>
X-Installation-Authorization: Bearer <required only for exclusion>
Content-Type: application/json

{
  "event":"submission_ready",
  "excludeInstallationID":"<optional base64url>"
}
```

The timestamp must be no more than five minutes in the future or 72 hours in
the past. The same idempotency key, exact timestamp, event, and exclusion must
be reused for retries; any mismatch returns `409`.

Small snapshots deliver directly. Larger snapshots are partitioned into
100-target batches and accepted into the Durable Object outbox and Cloudflare
Queue. Responses disclose no target or delivery counts:

```json
{
  "eventID": "7fb31c36-6d8f-4cc8-9722-66a188e667c2",
  "deliveryMode": "queued",
  "state": "accepted"
}
```

Direct responses use `200`; queued or transiently deferred responses use `202`.
The server retains the canonical request digest and terminal state for seven
days. Clients must stop retrying after 72 hours.

## Close

```http
DELETE /v1/apps/{appID}/channel
Authorization: Bearer <channel capability>
X-Channel-Admin-Authorization: Bearer <admin capability>
```

The request has no body. Closure removes device and delivery state and leaves a
permanent tombstone. The old channel capability can never be reprovisioned.

## Health and absent surfaces

`GET /health` returns only status, deployment environment, and service version.

There are no list, history, statistics, arbitrary payload, route, deep-link,
dashboard, or token-introspection endpoints.
