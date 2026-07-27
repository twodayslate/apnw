import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applySchemaMigrations,
  schemaMigrationPath,
} from "../src/storage/schema";

describe("Durable Object schemas", () => {
  it("creates both first-release schemas at version 1", async () => {
    const channel = env.CHANNELS.get(
      env.CHANNELS.idFromName(`schema:${crypto.randomUUID()}`),
    );
    await channel.provision("a".repeat(64));
    const channelVersion = await runInDurableObject(
      channel,
      (_instance, state) =>
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM schema_metadata WHERE singleton = 1",
          )
          .one().version,
    );

    const provisioning = env.PROVISIONING.get(
      env.PROVISIONING.idFromName(`schema:${crypto.randomUUID()}`),
    );
    const provisioningVersion = await runInDurableObject(
      provisioning,
      (_instance, state) =>
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM schema_metadata WHERE singleton = 1",
          )
          .one().version,
    );

    expect(channelVersion).toBe(1);
    expect(provisioningVersion).toBe(1);
  });

  it("plans only complete sequential migrations", () => {
    const migrations = [
      { fromVersion: 1, toVersion: 2, statements: "SELECT 1;" },
      { fromVersion: 2, toVersion: 3, statements: "SELECT 2;" },
    ] as const;

    expect(schemaMigrationPath(1, 3, migrations)).toEqual(migrations);
    expect(schemaMigrationPath(2, 3, migrations)).toEqual([migrations[1]]);
    expect(schemaMigrationPath(3, 3, migrations)).toEqual([]);
    expect(() => schemaMigrationPath(1, 3, [migrations[1]])).toThrow(
      "Missing schema migration from version 1",
    );
    expect(() => schemaMigrationPath(4, 3, migrations)).toThrow(
      "Database schema is newer than this Worker",
    );
    expect(() =>
      schemaMigrationPath(1, 2, [
        { fromVersion: 2, toVersion: 3, statements: "SELECT 3;" },
      ]),
    ).toThrow("Invalid schema migration registry");
  });

  it("applies a future SQLite migration atomically with its version", async () => {
    const channel = env.CHANNELS.get(
      env.CHANNELS.idFromName(`migration:${crypto.randomUUID()}`),
    );
    await channel.provision("c".repeat(64));

    const result = await runInDurableObject(channel, (_instance, state) => {
      applySchemaMigrations(state.storage, 2, [
        {
          fromVersion: 1,
          toVersion: 2,
          statements:
            "CREATE TABLE migration_probe(value TEXT NOT NULL); INSERT INTO migration_probe(value) VALUES ('applied');",
        },
      ]);
      return {
        probe: state.storage.sql
          .exec<{ value: string }>("SELECT value FROM migration_probe")
          .one().value,
        version: state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM schema_metadata WHERE singleton = 1",
          )
          .one().version,
      };
    });

    expect(result).toEqual({ probe: "applied", version: 2 });
  });

  it("rolls back schema statements when a future migration fails", async () => {
    const channel = env.CHANNELS.get(
      env.CHANNELS.idFromName(`migration-failure:${crypto.randomUUID()}`),
    );
    await channel.provision("d".repeat(64));

    const result = await runInDurableObject(channel, (_instance, state) => {
      expect(() =>
        applySchemaMigrations(state.storage, 2, [
          {
            fromVersion: 1,
            toVersion: 2,
            statements:
              "CREATE TABLE migration_probe(value TEXT NOT NULL); INSERT INTO table_that_does_not_exist(value) VALUES ('fail');",
          },
        ]),
      ).toThrow();
      return {
        probeTables: state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name = 'migration_probe'`,
          )
          .one().count,
        version: state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM schema_metadata WHERE singleton = 1",
          )
          .one().version,
      };
    });

    expect(result).toEqual({ probeTables: 0, version: 1 });
  });
});
