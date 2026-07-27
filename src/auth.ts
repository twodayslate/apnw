const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export class AuthenticationError extends Error {
  constructor() {
    super("Not found");
    this.name = "AuthenticationError";
  }
}

export function readCapability(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new AuthenticationError();
  }

  const capability = authorization.slice(7);
  if (
    !CAPABILITY_PATTERN.test(capability) ||
    decodeBase64Url(capability).byteLength < 32
  ) {
    throw new AuthenticationError();
  }
  return capability;
}

export async function deriveChannelName(
  hmacSecret: string,
  appID: string,
  capability: string,
): Promise<string> {
  const rawKey = decodeBase64Url(hmacSecret);
  if (rawKey.byteLength < 32) {
    throw new Error("CHANNEL_HMAC_KEY must contain at least 32 random bytes");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(rawKey).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${appID}:${capability}`),
  );
  return toHex(new Uint8Array(digest));
}

export function channelReference(channelName: string): string {
  return channelName.slice(0, 12);
}

export function decodeBase64Url(value: string): Uint8Array {
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
