const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export class AuthenticationError extends Error {
  constructor() {
    super("Not found");
    this.name = "AuthenticationError";
  }
}

export function readCapability(request: Request): string {
  return readBearerHeader(request.headers, "authorization");
}

export async function deriveChannelName(
  appID: string,
  capability: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asArrayBuffer(concatBytes(
      encoder.encode("apnw-channel-v1\0"),
      encoder.encode(appID),
      new Uint8Array([0]),
      requireSecretBytes(capability),
    )),
  );
  return toHex(new Uint8Array(digest));
}

export async function channelReference(
  hmacSecret: string,
  channelName: string,
  now = new Date(),
): Promise<string> {
  const keyBytes = requireSecretBytes(hmacSecret, "LOG_CORRELATION_KEY");
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const day = now.toISOString().slice(0, 10);
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    asArrayBuffer(encoder.encode(`apnw-log-ref-v1\0${day}\0${channelName}`)),
  );
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

export function readAdminCapability(request: Request): string {
  return readBearerHeader(
    request.headers,
    "x-channel-admin-authorization",
  );
}

export function readInstallationCapability(request: Request): string {
  return readBearerHeader(request.headers, "x-installation-authorization");
}

export async function capabilityDigest(
  purpose: "admin" | "installation",
  appID: string,
  capability: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asArrayBuffer(concatBytes(
      encoder.encode(`apnw-${purpose}-cap-v1\0`),
      encoder.encode(appID),
      new Uint8Array([0]),
      requireSecretBytes(capability),
    )),
  );
  return toHex(new Uint8Array(digest));
}

export async function capabilityValueDigest(
  capability: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asArrayBuffer(requireSecretBytes(capability)),
  );
  return toHex(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.byteLength ^ b.byteLength;
  const length = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return new Uint8Array();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return new Uint8Array();
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function readBearerHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (
    value === null ||
    value.includes(",") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthenticationError();
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw new AuthenticationError();
  const capability = match[1] ?? "";
  requireSecretBytes(capability);
  return capability;
}

function requireSecretBytes(
  value: string,
  variableName?: string,
): Uint8Array {
  if (!CAPABILITY_PATTERN.test(value)) {
    if (variableName) {
      throw new Error(`${variableName} must be canonical base64url for 32 bytes`);
    }
    throw new AuthenticationError();
  }
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== value) {
    if (variableName) {
      throw new Error(`${variableName} must be canonical base64url for 32 bytes`);
    }
    throw new AuthenticationError();
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
