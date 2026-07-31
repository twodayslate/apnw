import "reflect-metadata";
import {
  AsnEcSignatureFormatter,
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import * as asn1js from "asn1js";
import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/apps";
import {
  fraudReceiptRequestBody,
  fraudStatusForHttpFailure,
  isProvisioningEligibleFraudStatus,
} from "../src/appattest/ProvisioningObject";
import { parseAppAttestReceiptPayload } from "../src/appattest/receipt";
import {
  verifyAssertion,
  verifyAttestation,
} from "../src/appattest/verifier";

const app: AppConfig = {
  bundleID: "com.example.app",
  appAttest: {
    extensionPolicy: "if-present",
    maxFraudRiskMetric: 10,
    allowedValidationCategories: {
      development: [3],
      production: [2, 4],
    },
  },
  provisioning: { shardCount: 256, shardVersion: 1 },
  notificationFallback: {
    title: "Update",
    body: "Activity is available.",
  },
};
const teamID = "TESTTEAM12";

describe("App Attest verifier", () => {
  it("validates a complete synthetic chain, nonce, app, environment, and key binding", async () => {
    const fixture = await makeAttestationFixture();
    const verified = await verifyAttestation({
      app,
      appAttestEnvironment: "development",
      attestation: fixture.attestation,
      clientDataHash: fixture.clientDataHash,
      keyID: fixture.keyID,
      rootCertificatePem: fixture.rootPem,
      teamID,
    });
    expect(verified.publicKeySpki).toBe(fixture.publicKeySpki);

    await expect(
      verifyAttestation({
        app,
        appAttestEnvironment: "production",
        attestation: fixture.attestation,
        clientDataHash: fixture.clientDataHash,
        keyID: fixture.keyID,
        rootCertificatePem: fixture.rootPem,
        teamID,
      }),
    ).rejects.toThrow("rejected");

    const tamperedHash = fixture.clientDataHash.slice();
    tamperedHash[0] = (tamperedHash[0] ?? 0) ^ 1;
    await expect(
      verifyAttestation({
        app,
        appAttestEnvironment: "development",
        attestation: fixture.attestation,
        clientDataHash: tamperedHash,
        keyID: fixture.keyID,
        rootCertificatePem: fixture.rootPem,
        teamID,
      }),
    ).rejects.toThrow("rejected");
  });

  it("validates assertions and rejects replayed counters or wrong app bindings", async () => {
    const pair = await ecKeyPair();
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
    const publicKeySpki = base64(spki);
    const clientDataHash = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await makeAssertion(pair.privateKey, 7, clientDataHash);
    const verified = await verifyAssertion({
      app,
      appAttestEnvironment: "development",
      assertion,
      clientDataHash,
      previousCounter: 6,
      publicKeySpki,
      teamID,
    });
    expect(verified.counter).toBe(7);

    await expect(
      verifyAssertion({
        app,
        appAttestEnvironment: "development",
        assertion,
        clientDataHash,
        previousCounter: 7,
        publicKeySpki,
        teamID,
      }),
    ).rejects.toThrow("rejected");
    await expect(
      verifyAssertion({
        app: { ...app, bundleID: "com.example.other" },
        appAttestEnvironment: "development",
        assertion,
        clientDataHash,
        previousCounter: 0,
        publicKeySpki,
        teamID,
      }),
    ).rejects.toThrow("rejected");
  });

  it("enforces distribution categories and accepts every bundle version", async () => {
    const pair = await ecKeyPair();
    const publicKeySpki = base64(
      new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    );
    const clientDataHash = crypto.getRandomValues(new Uint8Array(32));
    const allowed = await makeAssertion(
      pair.privateKey,
      1,
      clientDataHash,
      new Map<string, unknown>([
        ["apple_validation_category_01", new Uint8Array([3, 0, 0, 0])],
        ["apple_bundle_version_01", "1"],
      ]),
    );
    await expect(
      verifyAssertion({
        app,
        appAttestEnvironment: "development",
        assertion: allowed,
        clientDataHash,
        previousCounter: 0,
        publicKeySpki,
        teamID,
      }),
    ).resolves.toMatchObject({
      counter: 1,
      validationCategory: 3,
      bundleVersion: "1",
    });

    const anyBundleVersion = await makeAssertion(
      pair.privateKey,
      2,
      clientDataHash,
      new Map<string, unknown>([
        ["apple_validation_category_01", new Uint8Array([3, 0, 0, 0])],
        ["apple_bundle_version_01", "unrestricted-build"],
      ]),
    );
    await expect(
      verifyAssertion({
        app,
        appAttestEnvironment: "development",
        assertion: anyBundleVersion,
        clientDataHash,
        previousCounter: 1,
        publicKeySpki,
        teamID,
      }),
    ).resolves.toMatchObject({
      counter: 2,
      validationCategory: 3,
      bundleVersion: "unrestricted-build",
    });

    const rejected = await makeAssertion(
      pair.privateKey,
      2,
      clientDataHash,
      new Map<string, unknown>([
        ["apple_validation_category_01", new Uint8Array([4, 0, 0, 0])],
        ["apple_bundle_version_01", "1"],
      ]),
    );
    await expect(
      verifyAssertion({
        app,
        appAttestEnvironment: "development",
        assertion: rejected,
        clientDataHash,
        previousCounter: 1,
        publicKeySpki,
        teamID,
      }),
    ).rejects.toThrow("rejected");
  });

  it("rejects duplicate CBOR map keys before semantic parsing", async () => {
    const key = new Uint8Array(encode("signature"));
    const value = new Uint8Array(encode(new Uint8Array([1])));
    const duplicateEnvelope = concat(
      new Uint8Array([0xa2]),
      key,
      value,
      key,
      value,
    );
    await expect(
      verifyAssertion({
        app,
        appAttestEnvironment: "development",
        assertion: duplicateEnvelope,
        clientDataHash: new Uint8Array(32),
        previousCounter: 0,
        publicKeySpki: base64(new Uint8Array(65)),
        teamID,
      }),
    ).rejects.toThrow("rejected");
  });

  it("parses the documented App Attest receipt fields and DER public key", async () => {
    const publicKey = crypto.getRandomValues(new Uint8Array(91));
    const payload = makeReceiptPayload([
      receiptStringField(2, `${teamID}.${app.bundleID}`),
      receiptStringField(3, base64(publicKey)),
      receiptStringField(6, "RECEIPT"),
      receiptStringField(12, new Date().toISOString()),
      receiptStringField(17, "5"),
      receiptStringField(19, new Date(Date.now() + 60_000).toISOString()),
      receiptStringField(21, new Date(Date.now() + 86_400_000).toISOString()),
    ]);
    expect(parseAppAttestReceiptPayload(payload)).toMatchObject({
      appID: `${teamID}.${app.bundleID}`,
      attestedPublicKey: publicKey,
      receiptType: "RECEIPT",
      riskMetric: 5,
    });
  });

  it("rejects duplicate and malformed App Attest receipt fields", () => {
    const duplicate = makeReceiptPayload([
      receiptStringField(2, `${teamID}.${app.bundleID}`),
      receiptStringField(2, `${teamID}.${app.bundleID}`),
    ]);
    expect(() => parseAppAttestReceiptPayload(duplicate)).toThrow(
      "Duplicate receipt field",
    );

    const malformedKey = makeReceiptPayload([
      receiptStringField(2, `${teamID}.${app.bundleID}`),
      receiptStringField(3, "not base64"),
      receiptStringField(6, "RECEIPT"),
      receiptStringField(12, new Date().toISOString()),
    ]);
    expect(() => parseAppAttestReceiptPayload(malformedKey)).toThrow(
      "Invalid App Attest receipt field",
    );
  });

  it("fails closed for permanent fraud-receipt failures", () => {
    expect(fraudStatusForHttpFailure(400)).toBe("error");
    expect(fraudStatusForHttpFailure(401)).toBe("error");
    expect(fraudStatusForHttpFailure(404)).toBe("error");
    expect(fraudStatusForHttpFailure(429)).toBe("pending");
    expect(fraudStatusForHttpFailure(503)).toBe("pending");
    expect(isProvisioningEligibleFraudStatus("error")).toBe(false);
    expect(isProvisioningEligibleFraudStatus("blocked")).toBe(false);
    expect(isProvisioningEligibleFraudStatus("pending")).toBe(true);
    expect(isProvisioningEligibleFraudStatus("accepted")).toBe(true);
  });

  it("decodes a stored fraud receipt to the exact binary request body", async () => {
    const receipt = new Uint8Array([0x30, 0x80, 0x06, 0x09, 0xff, 0x00]);
    const request = new Request("https://data.appattest.apple.com", {
      method: "POST",
      body: fraudReceiptRequestBody(base64(receipt)),
    });

    expect(new Uint8Array(await request.arrayBuffer())).toEqual(receipt);
    expect(() => fraudReceiptRequestBody("not canonical base64")).toThrow(
      "Invalid App Attest receipt",
    );
  });

});

async function makeAttestationFixture(): Promise<{
  attestation: Uint8Array;
  clientDataHash: Uint8Array;
  keyID: string;
  publicKeySpki: string;
  rootPem: string;
}> {
  const now = Date.now();
  const validity = {
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
  };
  const rootKeys = await ecKeyPair();
  const intermediateKeys = await ecKeyPair();
  const leafKeys = await ecKeyPair();
  const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" } as EcdsaParams;
  const root = await X509CertificateGenerator.createSelfSigned(
    {
      name: "CN=APNW Test Root",
      serialNumber: "01",
      ...validity,
      signingAlgorithm,
      keys: rootKeys,
      extensions: [
        new BasicConstraintsExtension(true, 1, true),
        new KeyUsagesExtension(
          KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
          true,
        ),
      ],
    },
    crypto,
  );
  const intermediate = await X509CertificateGenerator.create(
    {
      subject: "CN=APNW Test Intermediate",
      issuer: root.subject,
      serialNumber: "02",
      ...validity,
      signingAlgorithm,
      publicKey: intermediateKeys.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true),
      ],
    },
    crypto,
  );

  const rawPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", leafKeys.publicKey),
  );
  const keyDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", rawPublicKey),
  );
  const keyID = base64(keyDigest);
  const rpID = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${teamID}.${app.bundleID}`),
    ),
  );
  const coseKey = new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, rawPublicKey.slice(1, 33)],
    [-3, rawPublicKey.slice(33, 65)],
  ]);
  const authData = concat(
    rpID,
    new Uint8Array([0x40]),
    new Uint8Array(4),
    new TextEncoder().encode("appattestdevelop"),
    new Uint8Array([0, 32]),
    keyDigest,
    new Uint8Array(encode(coseKey)),
  );
  const clientDataHash = crypto.getRandomValues(new Uint8Array(32));
  const nonce = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      concat(authData, clientDataHash),
    ),
  );
  const nonceDer = concat(
    new Uint8Array([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]),
    nonce,
  );
  const leaf = await X509CertificateGenerator.create(
    {
      subject: "CN=APNW Test App Attest Key",
      issuer: intermediate.subject,
      serialNumber: "03",
      ...validity,
      signingAlgorithm,
      publicKey: leafKeys.publicKey,
      signingKey: intermediateKeys.privateKey,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new Extension(
          "1.2.840.113635.100.8.2",
          false,
          nonceDer.slice().buffer as ArrayBuffer,
        ),
      ],
    },
    crypto,
  );
  const attestation = new Uint8Array(
    encode(
      new Map<string, unknown>([
        ["fmt", "apple-appattest"],
        ["authData", authData],
        [
          "attStmt",
          new Map<string, unknown>([
            [
              "x5c",
              [
                new Uint8Array(leaf.rawData),
                new Uint8Array(intermediate.rawData),
              ],
            ],
            ["receipt", new Uint8Array([1, 2, 3])],
          ]),
        ],
      ]),
    ),
  );
  return {
    attestation,
    clientDataHash,
    keyID,
    publicKeySpki: base64(
      new Uint8Array(await crypto.subtle.exportKey("spki", leafKeys.publicKey)),
    ),
    rootPem: root.toString("pem"),
  };
}

async function makeAssertion(
  privateKey: CryptoKey,
  counter: number,
  clientDataHash: Uint8Array,
  extensions?: Map<string, unknown>,
): Promise<Uint8Array> {
  const rpID = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${teamID}.${app.bundleID}`),
    ),
  );
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter);
  const authData = concat(
    rpID,
    new Uint8Array([extensions ? 0x80 : 0]),
    counterBytes,
    ...(extensions ? [new Uint8Array(encode(extensions))] : []),
  );
  const rawSignature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    concat(authData, clientDataHash),
  );
  const signature = new AsnEcSignatureFormatter().toAsnSignature(
    { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as EcdsaParams,
    rawSignature,
  );
  if (!signature) throw new Error("signature conversion");
  return new Uint8Array(
    encode(
      new Map([
        ["signature", new Uint8Array(signature)],
        ["authenticatorData", authData],
      ]),
    ),
  );
}

function ecKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
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

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function receiptStringField(type: number, value: string): asn1js.Sequence {
  const encodedValue = new asn1js.Utf8String({ value }).toBER(false);
  return new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: type }),
      new asn1js.Integer({ value: 1 }),
      new asn1js.OctetString({ valueHex: encodedValue }),
    ],
  });
}

function makeReceiptPayload(fields: asn1js.Sequence[]): Uint8Array {
  return new Uint8Array(new asn1js.Set({ value: fields }).toBER(false));
}
