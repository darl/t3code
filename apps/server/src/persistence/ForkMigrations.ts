/**
 * Fork-owned schema migrations, kept out of upstream's migration ledger.
 *
 * Upstream's migrator compares ids only: any id the fork records in
 * effect_sql_migrations hides the upstream migration that later lands under the
 * same id. So fork migrations get their own ledger table and their own ids, and
 * run after upstream's migrations. Each fork migration must be idempotent: it
 * may run again on a database that already applied it under the old shared id.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
