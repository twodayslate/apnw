import "reflect-metadata";
import {
  AsnEcSignatureFormatter,
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509Certificate,
  cryptoProvider,
} from "@peculiar/x509";
import { decode } from "cbor-x";
import type { AppConfig } from "../apps";
import {
  constantTimeEqual,
  decodeBase64Url,
  encodeBase64Url,
  toHex,
} from "../auth";
import type { AppAttestEnvironment } from "../types";

const APPLE_NONCE_OID = "1.2.840.113635.100.8.2";
const APPLE_PRODUCTION_AAGUID = new Uint8Array([
  0x61, 0x70, 0x70, 0x61, 0x74, 0x74, 0x65, 0x73,
  0x74, 0, 0, 0, 0, 0, 0, 0,
]);
const APPLE_DEVELOPMENT_AAGUID = new TextEncoder().encode("appattestdevelop");
const encoder = new TextEncoder();
cryptoProvider.set(crypto);

export class AppAttestVerificationError extends Error {
  constructor() {
    super("App Attest evidence was rejected");
    this.name = "AppAttestVerificationError";
  }
}

export interface VerifiedAttestation {
  publicKeySpki: string;
  receipt: Uint8Array;
  validationCategory?: number;
  bundleVersion?: string;
}

export interface VerifiedAssertion {
  counter: number;
  validationCategory?: number;
  bundleVersion?: string;
}

export function normalizeAppAttestKeyID(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new AppAttestVerificationError();
  }
  decodeAppleKeyID(value);
  return value;
}

export async function verifyAttestation(input: {
  app: AppConfig;
  appAttestEnvironment: AppAttestEnvironment;
  attestation: Uint8Array;
  clientDataHash: Uint8Array;
  keyID: string;
  rootCertificatePem: string;
  teamID: string;
}): Promise<VerifiedAttestation> {
  try {
    const envelope = decodeOne(input.attestation);
    assertAllowedMapKeys(envelope, ["fmt", "authData", "attStmt"]);
    const fmt = getMapValue(envelope, "fmt");
    const authData = requireBytes(getMapValue(envelope, "authData"));
    const statement = requireMap(getMapValue(envelope, "attStmt"));
    assertAllowedMapKeys(statement, ["x5c", "receipt"]);
    const x5c = getMapValue(statement, "x5c");
    const receipt = requireBytes(getMapValue(statement, "receipt"));
    if (fmt !== "apple-appattest" || !Array.isArray(x5c) || x5c.length !== 2) {
      throw new Error("envelope");
    }

    const certificates = x5c.map(
      (value) => new X509Certificate(asArrayBuffer(requireBytes(value))),
    );
    const root = new X509Certificate(input.rootCertificatePem);
    await verifyCertificateChain(certificates, root);
    const leaf = certificates[0];
    if (!leaf) throw new Error("leaf");
    const leafConstraints = leaf.getExtension(BasicConstraintsExtension);
    const leafUsages = leaf.getExtension(KeyUsagesExtension);
    if (
      leafConstraints?.ca ||
      (leafUsages &&
        (leafUsages.usages & KeyUsageFlags.digitalSignature) === 0)
    ) {
      throw new Error("leaf constraints");
    }

    const clientDataHash = requireLength(input.clientDataHash, 32);
    const nonce = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        asArrayBuffer(concatBytes(authData, clientDataHash)),
      ),
    );
    const nonceExtension = leaf.getExtension(APPLE_NONCE_OID);
    if (
      !nonceExtension ||
      !constantTimeBytes(extractAppleNonce(nonceExtension.value), nonce)
    ) {
      throw new Error("nonce");
    }

    const parsed = await parseAttestationAuthenticatorData(
      authData,
      input.teamID,
      input.app.bundleID,
      input.appAttestEnvironment,
      leaf,
      input.keyID,
    );
    const signals = validateExtensions(parsed.extensions, input.app, input.appAttestEnvironment);
    const publicKey = await leaf.publicKey.export(
      { name: "ECDSA", namedCurve: "P-256" },
      ["verify"],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
    return {
      publicKeySpki: bytesToBase64(spki),
      receipt,
      ...signals,
    };
  } catch (error) {
    if (error instanceof AppAttestVerificationError) throw error;
    throw new AppAttestVerificationError();
  }
}

export async function verifyAssertion(input: {
  app: AppConfig;
  appAttestEnvironment: AppAttestEnvironment;
  assertion: Uint8Array;
  clientDataHash: Uint8Array;
  previousCounter: number;
  publicKeySpki: string;
  teamID: string;
}): Promise<VerifiedAssertion> {
  try {
    const envelope = requireMap(decodeOne(input.assertion));
    assertAllowedMapKeys(envelope, ["signature", "authenticatorData"]);
    const signature = requireBytes(getMapValue(envelope, "signature"));
    const authData = requireBytes(getMapValue(envelope, "authenticatorData"));
    const parsed = await parseAssertionAuthenticatorData(
      authData,
      input.teamID,
      input.app.bundleID,
    );
    if (parsed.counter <= input.previousCounter || parsed.counter === 0) {
      throw new Error("counter");
    }

    const key = await crypto.subtle.importKey(
      "spki",
      asArrayBuffer(base64ToBytes(input.publicKeySpki)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const formatter = new AsnEcSignatureFormatter();
    const webSignature = formatter.toWebSignature(
      { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as EcdsaParams,
      asArrayBuffer(signature),
    );
    if (
      !webSignature ||
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        webSignature,
        asArrayBuffer(
          concatBytes(authData, requireLength(input.clientDataHash, 32)),
        ),
      ))
    ) {
      throw new Error("signature");
    }
    const signals = validateExtensions(
      parsed.extensions,
      input.app,
      input.appAttestEnvironment,
    );
    return { counter: parsed.counter, ...signals };
  } catch (error) {
    if (error instanceof AppAttestVerificationError) throw error;
    throw new AppAttestVerificationError();
  }
}

async function parseAttestationAuthenticatorData(
  authData: Uint8Array,
  teamID: string,
  bundleID: string,
  environment: AppAttestEnvironment,
  leaf: X509Certificate,
  keyID: string,
): Promise<{ extensions?: MapLike }> {
  if (authData.byteLength < 55) throw new Error("auth data");
  await verifyRpID(authData.subarray(0, 32), teamID, bundleID);
  const flags = authData[32] ?? 0;
  if ((flags & 0x40) === 0) throw new Error("AT");
  if (readUint32(authData, 33) !== 0) throw new Error("counter");
  const expectedAaguid =
    environment === "production"
      ? APPLE_PRODUCTION_AAGUID
      : APPLE_DEVELOPMENT_AAGUID;
  if (!constantTimeBytes(authData.subarray(37, 53), expectedAaguid)) {
    throw new Error("aaguid");
  }
  const credentialLength = readUint16(authData, 53);
  const credentialStart = 55;
  const credentialEnd = credentialStart + credentialLength;
  if (credentialEnd > authData.byteLength) throw new Error("credential");
  const credentialID = authData.subarray(credentialStart, credentialEnd);
  const keyIDBytes = decodeAppleKeyID(keyID);
  if (!constantTimeBytes(credentialID, keyIDBytes)) throw new Error("key id");

  const coseEnd = cborItemEnd(authData, credentialEnd);
  const cose = requireMap(decodeOne(authData.subarray(credentialEnd, coseEnd)));
  assertAllowedMapKeys(cose, [1, 3, -1, -2, -3]);
  const x = requireLength(requireBytes(getMapValue(cose, -2)), 32);
  const y = requireLength(requireBytes(getMapValue(cose, -3)), 32);
  if (
    getMapValue(cose, 1) !== 2 ||
    getMapValue(cose, 3) !== -7 ||
    getMapValue(cose, -1) !== 1
  ) {
    throw new Error("COSE");
  }
  const certificateKey = await leaf.publicKey.export(
    { name: "ECDSA", namedCurve: "P-256" },
    ["verify"],
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", certificateKey));
  if (!constantTimeBytes(rawKey, concatBytes(new Uint8Array([4]), x, y))) {
    throw new Error("key coordinates");
  }
  const keyDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", asArrayBuffer(rawKey)),
  );
  if (!constantTimeBytes(keyDigest, credentialID)) throw new Error("key digest");

  return {
    ...(coseEnd < authData.byteLength
      ? { extensions: requireMap(decodeOne(authData.subarray(coseEnd))) }
      : {}),
  };
}

async function parseAssertionAuthenticatorData(
  authData: Uint8Array,
  teamID: string,
  bundleID: string,
): Promise<{ counter: number; extensions?: MapLike }> {
  if (authData.byteLength < 37) throw new Error("auth data");
  await verifyRpID(authData.subarray(0, 32), teamID, bundleID);
  const flags = authData[32] ?? 0;
  if ((flags & 0x40) !== 0) throw new Error("AT");
  return {
    counter: readUint32(authData, 33),
    ...(authData.byteLength > 37
      ? { extensions: requireMap(decodeOne(authData.subarray(37))) }
      : {}),
  };
}

async function verifyRpID(
  actual: Uint8Array,
  teamID: string,
  bundleID: string,
): Promise<void> {
  const expected = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      asArrayBuffer(encoder.encode(`${teamID}.${bundleID}`)),
    ),
  );
  if (!constantTimeBytes(actual, expected)) throw new Error("rp id");
}

async function verifyCertificateChain(
  certificates: X509Certificate[],
  root: X509Certificate,
): Promise<void> {
  const now = Date.now();
  for (const certificate of [...certificates, root]) {
    if (
      certificate.notBefore.getTime() >= now ||
      certificate.notAfter.getTime() <= now
    ) {
      throw new Error("certificate validity");
    }
  }
  for (let index = 0; index < certificates.length; index += 1) {
    const certificate = certificates[index];
    const issuer = certificates[index + 1] ?? root;
    if (!certificate || !issuer || certificate.issuer !== issuer.subject) {
      throw new Error("certificate chain");
    }
    if (!(await certificate.verify({ publicKey: issuer }))) {
      throw new Error("certificate signature");
    }
    if (index > 0) {
      const constraints = certificate.getExtension(BasicConstraintsExtension);
      const usages = certificate.getExtension(KeyUsagesExtension);
      if (
        !constraints?.ca ||
        (usages && (usages.usages & KeyUsageFlags.keyCertSign) === 0)
      ) {
        throw new Error("intermediate constraints");
      }
    }
  }
}

type MapLike = Map<unknown, unknown> | Record<string, unknown>;

function validateExtensions(
  extensions: MapLike | undefined,
  app: AppConfig,
  environment: AppAttestEnvironment,
): { validationCategory?: number; bundleVersion?: string } {
  if (!extensions) {
    if (app.appAttest.extensionPolicy === "required") throw new Error("extensions");
    return {};
  }
  const categoryValue = getMapValue(extensions, "apple_validation_category_01");
  const bundleVersion = getMapValue(extensions, "apple_bundle_version_01");
  let validationCategory: number;
  if (categoryValue instanceof Uint8Array && categoryValue.byteLength === 4) {
    validationCategory = new DataView(
      categoryValue.buffer,
      categoryValue.byteOffset,
      categoryValue.byteLength,
    ).getUint32(0, true);
  } else if (
    typeof categoryValue === "number" &&
    Number.isSafeInteger(categoryValue) &&
    categoryValue >= 0
  ) {
    validationCategory = categoryValue;
  } else {
    throw new Error("validation category");
  }
  if (
    typeof bundleVersion !== "string" ||
    !app.appAttest.allowedValidationCategories[environment].includes(
      validationCategory,
    )
  ) {
    throw new Error("distribution policy");
  }
  return { validationCategory, bundleVersion };
}

function extractAppleNonce(value: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(value);
  // Apple encodes: SEQUENCE { [1] { OCTET STRING nonce } }.
  let offset = 0;
  const sequence = readDer(bytes, offset, 0x30);
  offset = sequence.contentStart;
  const tagged = readDer(bytes, offset, 0xa1);
  const octet = readDer(bytes, tagged.contentStart, 0x04);
  if (
    octet.contentEnd !== tagged.contentEnd ||
    tagged.contentEnd !== sequence.contentEnd ||
    sequence.contentEnd !== bytes.byteLength
  ) {
    throw new Error("nonce DER");
  }
  return requireLength(bytes.subarray(octet.contentStart, octet.contentEnd), 32);
}

function readDer(
  bytes: Uint8Array,
  offset: number,
  expectedTag: number,
): { contentStart: number; contentEnd: number } {
  if (bytes[offset] !== expectedTag) throw new Error("DER tag");
  const firstLength = bytes[offset + 1];
  if (firstLength === undefined) throw new Error("DER length");
  let contentStart = offset + 2;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const count = firstLength & 0x7f;
    if (count === 0 || count > 4 || contentStart + count > bytes.byteLength) {
      throw new Error("DER length");
    }
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = (length << 8) | (bytes[contentStart + index] ?? 0);
    }
    contentStart += count;
  }
  const contentEnd = contentStart + length;
  if (contentEnd > bytes.byteLength) throw new Error("DER bounds");
  return { contentStart, contentEnd };
}

function decodeOne(bytes: Uint8Array): unknown {
  const end = cborItemEnd(bytes, 0);
  if (end !== bytes.byteLength) throw new Error("trailing CBOR");
  return decode(bytes);
}

function cborItemEnd(bytes: Uint8Array, offset: number, depth = 0): number {
  if (depth > 16 || offset >= bytes.byteLength) throw new Error("CBOR bounds");
  const initial = bytes[offset] ?? 0;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  const { value, next } = readCborLength(bytes, offset + 1, additional);
  if (major === 0 || major === 1 || major === 7) return next;
  if (major === 2 || major === 3) {
    const end = next + value;
    if (end > bytes.byteLength) throw new Error("CBOR bounds");
    return end;
  }
  if (major === 4) {
    if (value > 256) throw new Error("CBOR collection");
    let cursor = next;
    for (let index = 0; index < value; index += 1) {
      cursor = cborItemEnd(bytes, cursor, depth + 1);
    }
    return cursor;
  }
  if (major === 5) {
    if (value > 256) throw new Error("CBOR collection");
    let cursor = next;
    const keys = new Set<string>();
    for (let index = 0; index < value; index += 1) {
      const keyEnd = cborItemEnd(bytes, cursor, depth + 1);
      const key = decode(bytes.subarray(cursor, keyEnd));
      if (typeof key !== "string" && typeof key !== "number") {
        throw new Error("CBOR map key");
      }
      const identity = `${typeof key}:${String(key)}`;
      if (keys.has(identity)) throw new Error("duplicate CBOR key");
      keys.add(identity);
      cursor = cborItemEnd(bytes, keyEnd, depth + 1);
    }
    return cursor;
  }
  if (major === 6) return cborItemEnd(bytes, next, depth + 1);
  throw new Error("CBOR type");
}

function readCborLength(
  bytes: Uint8Array,
  offset: number,
  additional: number,
): { value: number; next: number } {
  if (additional < 24) return { value: additional, next: offset };
  const length = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0;
  if (length === 0 || offset + length > bytes.byteLength) {
    throw new Error("CBOR length");
  }
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  if (!Number.isSafeInteger(value)) throw new Error("CBOR length");
  return { value, next: offset + length };
}

function getMapValue(map: unknown, key: string | number): unknown {
  if (map instanceof Map) return map.get(key);
  if (typeof map === "object" && map !== null && !Array.isArray(map)) {
    return Object.prototype.hasOwnProperty.call(map, String(key))
      ? (map as Record<string, unknown>)[String(key)]
      : undefined;
  }
  return undefined;
}

function requireMap(value: unknown): MapLike {
  if (
    value instanceof Map ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  ) {
    return value as MapLike;
  }
  throw new Error("map");
}

function assertAllowedMapKeys(
  value: unknown,
  allowedKeys: readonly (string | number)[],
): void {
  const map = requireMap(value);
  const keys =
    map instanceof Map
      ? [...map.keys()]
      : Object.keys(map);
  if (
    keys.some(
      (key) =>
        (typeof key !== "string" && typeof key !== "number") ||
        !allowedKeys.some(
          (allowed) =>
            typeof allowed === typeof key && String(allowed) === String(key),
        ),
    )
  ) {
    throw new Error("unknown map key");
  }
}

function requireBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("bytes");
}

function requireLength(value: Uint8Array, length: number): Uint8Array {
  if (value.byteLength !== length) throw new Error("length");
  return value;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.byteLength) throw new Error("uint16");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) throw new Error("uint32");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function constantTimeBytes(left: Uint8Array, right: Uint8Array): boolean {
  return constantTimeEqual(toHex(left), toHex(right));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function decodeAppleKeyID(value: string): Uint8Array {
  const bytes = value.includes("=")
    ? base64ToBytes(value)
    : decodeBase64Url(value);
  if (bytes.byteLength !== 32) throw new Error("key id");
  const canonicalUrl = encodeBase64Url(bytes);
  const canonicalBase64 = bytesToBase64(bytes);
  if (value !== canonicalUrl && value !== canonicalBase64) throw new Error("key id");
  return bytes;
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
