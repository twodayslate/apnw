# iOS integration

App Attest provisioning belongs in the main app. Notification Service, Share,
Messages, and other extensions must not attempt App Attest setup.

## Local secrets

Generate independent 32-byte random values using `SecRandomCopyBytes` for:

- channel capability;
- channel administrator capability;
- installation ID;
- installation capability.

Encode them as unpadded base64url. Store installation values and the App Attest
key ID with a ThisDeviceOnly Keychain accessibility class such as
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Store channel values only
for active collaborations.

Never put an APNW capability in `UserDefaults`, a URL, logs, analytics,
notifications, or plaintext CloudKit fields.

## App Attest lifecycle

1. Call `DCAppAttestService.shared.generateKey()` once and immediately persist
   the returned key ID. The private key cannot be rediscovered.
2. Obtain an `attest_key` challenge and call
   `attestKey(_:clientDataHash:)` using `SHA256(challengeBytes)`.
3. Register the attestation with APNW.
4. For each new channel, obtain a `provision_channel` challenge while presenting
   the channel and administrator capabilities.
5. Calculate the exact binding in [api.md](api.md), serialize assertion
   generation per key, and call `generateAssertion(_:clientDataHash:)`.
6. Submit the assertion and retain the channel only after APNW confirms
   provisioning.

Keep development and production key IDs separate. Development App Attest
evidence is rejected by production. A missing/unsupported App Attest service has
no anonymous fallback in v1; show a recoverable setup error instead of creating
an unprotected channel.

If the server rejects a stored key because it was lost during restore,
reinstallation, or device transfer, generate and attest a new key. Do not loop
key generation on ordinary network failures.

## Capability distribution

Place the channel capability in the collaboration's end-to-end encrypted
CloudKit pairing payload. Distribute the administrator capability only to the
role that may close/rotate the channel. Never distribute an installation
capability.

App Attest does not decide who belongs to a collaboration. Confirm CloudKit
membership changes before distributing a replacement channel capability.

## APNs registration

After notification authorization, call
`registerForRemoteNotifications()`. In the application delegate token callback:

1. Convert the APNs token bytes to lowercase hexadecimal.
2. Register it for each active APNW channel with the stable installation ID and
   installation capability.
3. Repeat after every app launch/token callback; APNs tokens can change.

On logout, leave, block, iCloud-account change, or collaboration removal,
unregister the installation from affected channels. Treat an already-absent
response as success.

## Durable client outbox

Create an outbox row in the same local transaction that records the
CloudKit-bound app event:

- one random lowercase UUIDv4;
- one RFC3339 creation timestamp;
- fixed APNW event name;
- channel reference;
- optional sender installation ID;
- retry state.

Every retry must reuse the exact UUID, timestamp, event, and exclusion. Delete
the outbox row only after APNW accepts it. Retry transport failures and `429`,
`5xx`, or queued acceptance with exponential backoff and jitter. Expire the row
at 72 hours; never mint a new UUID for the same logical event.

The Messages extension may write the local/CloudKit mutation and outbox row.
The main app or an existing background synchronization path performs APNW
network delivery.

## Notification handling

APNW alerts contain generic copy only. A tap opens the app's generic activity
screen. The app then fetches authoritative CloudKit state and applies its normal
authorization checks.

Do not expect a route, record name, pairing ID, role, decrypted text, or other
domain data in the notification payload.
