import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  deriveChannelName,
  readCapability,
} from "../src/auth";

const capability =
  "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY";
const hmacKey =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

describe("capability authentication", () => {
  it("accepts a 256-bit base64url bearer capability", () => {
    const request = new Request("https://example.com", {
      headers: { authorization: `Bearer ${capability}` },
    });
    expect(readCapability(request)).toBe(capability);
    expect(decodeBase64Url(capability)).toHaveLength(32);
  });

  it("rejects missing, short, malformed, and oversized credentials", () => {
    const credentials = [
      undefined,
      "Bearer short",
      `Bearer ${"a".repeat(129)}`,
      `Basic ${capability}`,
    ];
    for (const authorization of credentials) {
      const headers = authorization ? { authorization } : undefined;
      expect(() =>
        readCapability(new Request("https://example.com", { headers })),
      ).toThrow("Not found");
    }
  });

  it("isolates apps and capabilities in deterministic object names", async () => {
    const first = await deriveChannelName(
      hmacKey,
      "chain_of_custody",
      capability,
    );
    const same = await deriveChannelName(
      hmacKey,
      "chain_of_custody",
      capability,
    );
    const otherApp = await deriveChannelName(
      hmacKey,
      "another_app",
      capability,
    );
    const otherCapability = await deriveChannelName(
      hmacKey,
      "chain_of_custody",
      "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    );
    expect(first).toBe(same);
    expect(first).toHaveLength(64);
    expect(first).not.toBe(otherApp);
    expect(first).not.toBe(otherCapability);
    expect(first).not.toContain(capability);
  });
});
