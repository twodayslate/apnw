import { describe, expect, it } from "vitest";
import { provisioningShard } from "../src/index";

describe("App Attest provisioning shards", () => {
  it("routes keys deterministically across only the fixed shard set", async () => {
    const keys = Array.from({ length: 2_048 }, (_, index) => {
      const bytes = new Uint8Array(32);
      new DataView(bytes.buffer).setUint32(0, index);
      return base64(bytes);
    });
    const first = await Promise.all(
      keys.map((keyID) => provisioningShard("chain_of_custody", keyID, 256)),
    );
    const repeated = await Promise.all(
      keys.map((keyID) => provisioningShard("chain_of_custody", keyID, 256)),
    );
    const otherApp = await Promise.all(
      keys.map((keyID) => provisioningShard("another_app", keyID, 256)),
    );
    expect(repeated).toEqual(first);
    expect(first.every((shard) => shard >= 0 && shard < 256)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(240);
    expect(
      first.filter((shard, index) => shard !== otherApp[index]).length,
    ).toBeGreaterThan(1_900);
  });
});

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
