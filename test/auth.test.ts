import { describe, expect, it } from "vitest";
import {
  capabilityDigest,
  channelReference,
  decodeBase64Url,
  deriveChannelName,
  readAdminCapability,
  readCapability,
  readInstallationCapability,
} from "../src/auth";

const capability =
  "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY";
const otherCapability =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

describe("capability authentication", () => {
  it("accepts exactly one canonical 256-bit bearer capability", () => {
    const request = new Request("https://example.com", {
      headers: {
        authorization: `Bearer ${capability}`,
        "x-channel-admin-authorization": `Bearer ${otherCapability}`,
        "x-installation-authorization": `Bearer ${otherCapability}`,
      },
    });
    expect(readCapability(request)).toBe(capability);
    expect(readAdminCapability(request)).toBe(otherCapability);
    expect(readInstallationCapability(request)).toBe(otherCapability);
    expect(decodeBase64Url(capability)).toHaveLength(32);
  });

  it("rejects missing, malformed, padded, ambiguous, and oversized credentials", () => {
    const credentials = [
      undefined,
      "Bearer short",
      `Bearer ${capability}=`,
      `Bearer  ${capability}`,
      `Bearer ${capability}, Bearer ${otherCapability}`,
      `Basic ${capability}`,
      `Bearer ${"a".repeat(44)}`,
    ];
    for (const authorization of credentials) {
      const headers = authorization ? { authorization } : undefined;
      expect(() =>
        readCapability(new Request("https://example.com", { headers })),
      ).toThrow("Not found");
    }
  });

  it("isolates apps and capabilities in stable SHA-256 object names", async () => {
    const first = await deriveChannelName("chain_of_custody", capability);
    const same = await deriveChannelName("chain_of_custody", capability);
    const otherApp = await deriveChannelName("another_app", capability);
    const other = await deriveChannelName(
      "chain_of_custody",
      otherCapability,
    );
    expect(first).toBe(same);
    expect(first).toHaveLength(64);
    expect(first).not.toBe(otherApp);
    expect(first).not.toBe(other);
    expect(first).not.toContain(capability);
  });

  it("separates capability roles and rotates pseudonymous log references daily", async () => {
    const admin = await capabilityDigest("admin", "app", capability);
    const installation = await capabilityDigest(
      "installation",
      "app",
      capability,
    );
    const dayOne = await channelReference(
      otherCapability,
      "channel-object-name",
      new Date("2026-07-26T12:00:00Z"),
    );
    const dayTwo = await channelReference(
      otherCapability,
      "channel-object-name",
      new Date("2026-07-27T12:00:00Z"),
    );
    expect(admin).not.toBe(installation);
    expect(dayOne).toMatch(/^[0-9a-f]{16}$/);
    expect(dayOne).not.toBe(dayTwo);
  });
});
