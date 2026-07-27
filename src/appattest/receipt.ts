import "reflect-metadata";
import * as asn1js from "asn1js";
import {
  Certificate,
  ContentInfo,
  SignedData,
  id_ContentType_SignedData,
  setEngine,
} from "pkijs";

setEngine("webcrypto", crypto, crypto.subtle);

export interface AppAttestReceiptClaims {
  appID: string;
  attestedPublicKey: Uint8Array;
  creationTime: number;
  expirationTime?: number;
  notBefore?: number;
  receiptType: "ATTEST" | "RECEIPT";
  riskMetric?: number;
}

export async function verifyAppAttestReceipt(input: {
  expectedAppID: string;
  expectedPublicKeySpki: string;
  receipt: Uint8Array;
  requireRiskMetric: boolean;
  rootCertificatePem: string;
}): Promise<AppAttestReceiptClaims> {
  const receiptAsn = asn1js.fromBER(asArrayBuffer(input.receipt));
  if (receiptAsn.offset !== input.receipt.byteLength) {
    throw new Error("Invalid App Attest receipt");
  }
  const contentInfo = new ContentInfo({ schema: receiptAsn.result });
  if (contentInfo.contentType !== id_ContentType_SignedData) {
    throw new Error("Invalid App Attest receipt");
  }
  const signedData = new SignedData({ schema: contentInfo.content });
  const rootAsn = asn1js.fromBER(pemToDer(input.rootCertificatePem));
  if (rootAsn.offset === -1) throw new Error("Invalid App Attest root");
  const root = new Certificate({ schema: rootAsn.result });
  const verified = await signedData.verify({
    signer: 0,
    trustedCerts: [root],
    checkChain: true,
    passedWhenNotRevValues: true,
  });
  if (!verified) throw new Error("Invalid App Attest receipt");
  const content = signedData.encapContentInfo.eContent;
  if (!content) throw new Error("Invalid App Attest receipt");
  const payload = octetStringBytes(content);
  const claims = parseAppAttestReceiptPayload(payload);
  if (
    claims.appID !== input.expectedAppID ||
    !constantTimeBytes(
      claims.attestedPublicKey,
      base64ToBytes(input.expectedPublicKeySpki),
    ) ||
    (input.requireRiskMetric && claims.riskMetric === undefined)
  ) {
    throw new Error("Invalid App Attest receipt");
  }
  const now = Date.now();
  if (
    claims.creationTime > now + 60_000 ||
    claims.creationTime < now - 5 * 60_000 ||
    (claims.expirationTime !== undefined && claims.expirationTime <= now)
  ) {
    throw new Error("Invalid App Attest receipt");
  }
  return claims;
}

export function parseAppAttestReceiptPayload(
  payload: Uint8Array,
): AppAttestReceiptClaims {
  const parsed = asn1js.fromBER(asArrayBuffer(payload));
  if (parsed.offset !== payload.byteLength || !(parsed.result instanceof asn1js.Set)) {
    throw new Error("Invalid App Attest receipt payload");
  }
  const fields = new Map<number, Uint8Array>();
  for (const item of parsed.result.valueBlock.value) {
    if (!(item instanceof asn1js.Sequence) || item.valueBlock.value.length !== 3) {
      throw new Error("Invalid App Attest receipt payload");
    }
    const [type, version, value] = item.valueBlock.value;
    if (
      !(type instanceof asn1js.Integer) ||
      !(version instanceof asn1js.Integer) ||
      !(value instanceof asn1js.OctetString)
    ) {
      throw new Error("Invalid App Attest receipt payload");
    }
    const fieldType = type.valueBlock.valueDec;
    if (fields.has(fieldType)) throw new Error("Duplicate receipt field");
    fields.set(fieldType, octetStringBytes(value));
  }

  const appID = parseReceiptString(requireField(fields, 2));
  const attestedPublicKey = parseReceiptBase64(requireField(fields, 3));
  const receiptType = parseReceiptString(requireField(fields, 6));
  const creationTime = parseReceiptDate(requireField(fields, 12));
  if (receiptType !== "ATTEST" && receiptType !== "RECEIPT") {
    throw new Error("Invalid App Attest receipt payload");
  }
  const riskValue = fields.get(17);
  const riskMetric = riskValue
    ? Number.parseInt(parseReceiptString(riskValue), 10)
    : undefined;
  if (
    riskMetric !== undefined &&
    (!Number.isSafeInteger(riskMetric) || riskMetric < 0)
  ) {
    throw new Error("Invalid App Attest receipt payload");
  }
  const notBeforeValue = fields.get(19);
  const expirationValue = fields.get(21);
  return {
    appID,
    attestedPublicKey,
    creationTime,
    receiptType,
    ...(riskMetric !== undefined ? { riskMetric } : {}),
    ...(notBeforeValue
      ? { notBefore: parseReceiptDate(notBeforeValue) }
      : {}),
    ...(expirationValue
      ? { expirationTime: parseReceiptDate(expirationValue) }
      : {}),
  };
}

function parseReceiptString(bytes: Uint8Array): string {
  const parsed = asn1js.fromBER(asArrayBuffer(bytes));
  if (
    parsed.offset !== bytes.byteLength ||
    !(
      parsed.result instanceof asn1js.Utf8String ||
      parsed.result instanceof asn1js.IA5String
    )
  ) {
    throw new Error("Invalid App Attest receipt field");
  }
  return parsed.result.valueBlock.value;
}

function parseReceiptBase64(bytes: Uint8Array): Uint8Array {
  const value = parseReceiptString(bytes);
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Invalid App Attest receipt field");
  }
  try {
    return Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new Error("Invalid App Attest receipt field");
  }
}

function parseReceiptDate(bytes: Uint8Array): number {
  const value = parseReceiptString(bytes);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid App Attest receipt date");
  }
  return timestamp;
}

function octetStringBytes(value: asn1js.OctetString): Uint8Array {
  if (value.valueBlock.isConstructed) {
    const parts = value.valueBlock.value.map((part) => {
      if (!(part instanceof asn1js.OctetString)) {
        throw new Error("Invalid App Attest receipt");
      }
      return octetStringBytes(part);
    });
    const result = new Uint8Array(
      parts.reduce((length, part) => length + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }
  return new Uint8Array(value.valueBlock.valueHexView);
}

function requireField(
  fields: ReadonlyMap<number, Uint8Array>,
  type: number,
): Uint8Array {
  const value = fields.get(type);
  if (!value) throw new Error("Missing App Attest receipt field");
  return value;
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\s/g, "");
  return asArrayBuffer(
    Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
  );
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
}

function constantTimeBytes(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
