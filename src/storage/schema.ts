export interface SchemaMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly statements: string;
}

export function applySchemaMigrations(
  storage: DurableObjectStorage,
  currentVersion: number,
  migrations: readonly SchemaMigration[],
): void {
  const sql = storage.sql;
  const deployedVersion = sql
    .exec<{ version: number }>(
      "SELECT version FROM schema_metadata WHERE singleton = 1",
    )
    .one()?.version;
  if (deployedVersion === undefined) {
    throw new Error("Schema version is missing");
  }

  for (const migration of schemaMigrationPath(
    deployedVersion,
    currentVersion,
    migrations,
  )) {
    storage.transactionSync(() => {
      sql.exec(migration.statements);
      const update = sql.exec(
        "UPDATE schema_metadata SET version = ? WHERE singleton = 1 AND version = ?",
        migration.toVersion,
        migration.fromVersion,
      );
      if (update.rowsWritten !== 1) {
        throw new Error("Schema changed during migration");
      }
    });
  }
}

/**
 * Returns the exact, sequential migration path from a deployed schema to the
 * current schema. Fresh databases are created directly at the current version;
 * this is only for versions that have actually shipped.
 */
export function schemaMigrationPath(
  deployedVersion: number,
  currentVersion: number,
  migrations: readonly SchemaMigration[],
): readonly SchemaMigration[] {
  if (
    !Number.isInteger(deployedVersion) ||
    deployedVersion < 1 ||
    !Number.isInteger(currentVersion) ||
    currentVersion < 1
  ) {
    throw new Error("Invalid schema version");
  }
  if (deployedVersion > currentVersion) {
    throw new Error("Database schema is newer than this Worker");
  }

  const bySourceVersion = new Map<number, SchemaMigration>();
  for (const migration of migrations) {
    if (
      !Number.isInteger(migration.fromVersion) ||
      !Number.isInteger(migration.toVersion) ||
      migration.fromVersion < 1 ||
      migration.toVersion !== migration.fromVersion + 1 ||
      migration.toVersion > currentVersion ||
      migration.statements.trim() === "" ||
      bySourceVersion.has(migration.fromVersion)
    ) {
      throw new Error("Invalid schema migration registry");
    }
    bySourceVersion.set(migration.fromVersion, migration);
  }

  const path: SchemaMigration[] = [];
  let version = deployedVersion;
  while (version < currentVersion) {
    const migration = bySourceVersion.get(version);
    if (!migration) {
      throw new Error(`Missing schema migration from version ${version}`);
    }
    path.push(migration);
    version = migration.toVersion;
  }
  return path;
}
