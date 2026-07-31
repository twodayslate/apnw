import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_OUTSTANDING_CHALLENGES_PER_SHARD } from "../src/appattest/ProvisioningObject";
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

  it(
    "bounds outstanding unauthenticated challenges per shard",
    async () => {
      const stub = env.PROVISIONING.get(
        env.PROVISIONING.idFromName(
          `challenge-capacity:${crypto.randomUUID()}`,
        ),
      );
      for (
        let index = 0;
        index < MAX_OUTSTANDING_CHALLENGES_PER_SHARD;
        index += 1
      ) {
        const bytes = new Uint8Array(32);
        new DataView(bytes.buffer).setUint32(0, index);
        await expect(
          stub.issueChallenge({
            appID: "chain_of_custody",
            keyID: base64(bytes),
            purpose: "key-attestation",
          }),
        ).resolves.toMatchObject({ ok: true });
      }
      const overflowKey = new Uint8Array(32);
      new DataView(overflowKey.buffer).setUint32(
        0,
        MAX_OUTSTANDING_CHALLENGES_PER_SHARD,
      );
      await expect(
        stub.issueChallenge({
          appID: "chain_of_custody",
          keyID: base64(overflowKey),
          purpose: "key-attestation",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "rate_limited",
      });
    },
    15_000,
  );
});

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
