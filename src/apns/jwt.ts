interface CachedToken {
  token: string;
  createdAt: number;
}

const TOKEN_LIFETIME_SECONDS = 50 * 60;
const cache = new Map<string, CachedToken>();

export async function getProviderToken(
  teamID: string,
  keyID: string,
  encodedP8: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<string> {
  const cacheKey = `${teamID}:${keyID}`;
  const cached = cache.get(cacheKey);
  if (cached && nowSeconds - cached.createdAt < TOKEN_LIFETIME_SECONDS) {
    return cached.token;
  }

  const header = base64UrlJson({ alg: "ES256", kid: keyID });
  const claims = base64UrlJson({ iss: teamID, iat: nowSeconds });
  const unsignedToken = `${header}.${claims}`;
  const key = await importPrivateKey(encodedP8);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(unsignedToken),
    ),
  );
  const joseSignature =
    signature.byteLength === 64 ? signature : derToJose(signature);
  const token = `${unsignedToken}.${base64Url(joseSignature)}`;
  cache.set(cacheKey, { token, createdAt: nowSeconds });
  return token;
}

export function clearProviderTokenCache(): void {
  cache.clear();
}

async function importPrivateKey(encodedP8: string): Promise<CryptoKey> {
  let pem: string;
  try {
    pem = atob(encodedP8.replace(/\s/g, ""));
  } catch {
    throw new Error("APNS_KEY_P8 is not valid base64");
  }
  const der = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  if (!der) throw new Error("APNS_KEY_P8 does not contain a PKCS#8 private key");
  const bytes = Uint8Array.from(atob(der), (character) =>
    character.charCodeAt(0),
  );
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function base64UrlJson(value: object): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function derToJose(signature: Uint8Array): Uint8Array {
  if (signature[0] !== 0x30) throw new Error("Unexpected ECDSA signature");
  let offset = signature[1] === 0x81 ? 3 : 2;
  if (signature[offset] !== 0x02) throw new Error("Unexpected ECDSA signature");
  const rLength = signature[offset + 1] ?? 0;
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (signature[offset] !== 0x02) throw new Error("Unexpected ECDSA signature");
  const sLength = signature[offset + 1] ?? 0;
  const s = signature.slice(offset + 2, offset + 2 + sLength);
  const output = new Uint8Array(64);
  output.set(trimInteger(r).slice(-32), 32 - Math.min(32, trimInteger(r).length));
  output.set(trimInteger(s).slice(-32), 64 - Math.min(32, trimInteger(s).length));
  return output;
}

function trimInteger(value: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) offset++;
  return value.slice(offset);
}
