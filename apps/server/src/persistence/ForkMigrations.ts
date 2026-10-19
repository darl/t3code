// Fork migrations use a separate ledger so their IDs cannot hide future upstream migrations. They run afterward and must be idempotent for databases using the old shared ledger.
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./Migrations/fork/001_CanonicalArcanumThreadPullRequests.ts";

export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";
const UPSTREAM_MIGRATIONS_TABLE = "effect_sql_migrations";

const forkMigrationEntries = [
  [1, "CanonicalArcanumThreadPullRequests", ForkMigration0001],
] as const;

const forkMigrationNames = forkMigrationEntries.map(([, name]) => name);

const loader = Migrator.fromRecord(
  Object.fromEntries(
    forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

const run = Migrator.make({});

export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN (${FORK_MIGRATIONS_TABLE}, ${UPSTREAM_MIGRATIONS_TABLE})
  `;
  if (!tables.some((table) => table.name === FORK_MIGRATIONS_TABLE)) return true;
  const rows = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM fork_sql_migrations
  `;
  if ((rows[0]?.latestId ?? 0) < Math.max(...forkMigrationEntries.map(([id]) => id))) return true;
  if (!tables.some((table) => table.name === UPSTREAM_MIGRATIONS_TABLE)) return false;
  const stale = yield* sql`
    SELECT 1 FROM effect_sql_migrations WHERE name IN ${sql.in(forkMigrationNames)} LIMIT 1
  `;
  return stale.length > 0;
});

/**
 * Removes fork migrations that an earlier fork build recorded in upstream's
 * ledger, so the upstream migration that now owns that id can run. Must run
 * before upstream's migrations. A fresh database has no ledger yet.
 */
export const reconcileForkLedger = Effect.fn("reconcileForkLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${UPSTREAM_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return;
  const stale = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE name IN ${sql.in(forkMigrationNames)}
  `;
  if (stale.length === 0) return;
  yield* sql`
    DELETE FROM effect_sql_migrations WHERE name IN ${sql.in(forkMigrationNames)}
  `;
  yield* Effect.log("Moved fork migrations out of the upstream ledger").pipe(
    Effect.annotateLogs({
      migrations: stale.map((row) => `${row.migration_id}_${row.name}`),
    }),
  );
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({ loader, table: FORK_MIGRATIONS_TABLE });
  yield* executed.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(
        Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
      );
  return executed;
});
