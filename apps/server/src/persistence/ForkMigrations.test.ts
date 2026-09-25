import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { reconcileForkLedger, runForkMigrations } from "./ForkMigrations.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// Each test gets its own database: the ledger tests must start from scratch.
const FreshSqlite = NodeSqliteClient.layer({ filename: ":memory:" });

const insertLink = (row: {
  readonly threadId: string;
  readonly host: string;
  readonly number: number;
  readonly snapshot: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_pull_requests
        (thread_id, host, repository, number, url, source, linked_at, snapshot_json, stack_json)
      VALUES (
        ${row.threadId}, ${row.host}, 'arcadia', ${row.number},
        ${`https://a.yandex-team.ru/review/${row.number}`}, 'agent',
        '2026-09-15T00:00:00.000Z', ${row.snapshot}, NULL
      )
    `;
  });

const readLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly host: string;
    readonly number: number;
    readonly snapshot_json: string | null;
  }>`
    SELECT thread_id, host, number, snapshot_json
    FROM projection_thread_pull_requests
    ORDER BY thread_id, host, number
  `;
  return rows.map((row) => ({ ...row }));
});

const readUpstreamLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => `${row.migration_id}_${row.name}`);
});

describe("ForkMigrations", () => {
  it.effect("001 folds review-host links onto the arcadia key, keeping the synced copy", () =>
    Effect.gen(function* () {
      yield* runMigrations();

      // Re-linked after the fix: the old row never synced, the new one did.
      yield* insertLink({ threadId: "one", host: "a.yandex-team.ru", number: 1, snapshot: null });
      yield* insertLink({
        threadId: "one",
        host: "arcadia",
        number: 1,
        snapshot: '{"state":"merged"}',
      });
      // Linked only before the fix: the row itself moves to the canonical key.
      yield* insertLink({ threadId: "two", host: "a.yandex-team.ru", number: 2, snapshot: null });
      // Other hosts are not touched.
      yield* insertLink({ threadId: "three", host: "github.com", number: 3, snapshot: null });

      const executed = yield* runForkMigrations();
      assert.deepStrictEqual(executed, [[1, "CanonicalArcanumThreadPullRequests"]]);

      const expected = [
        { thread_id: "one", host: "arcadia", number: 1, snapshot_json: '{"state":"merged"}' },
        { thread_id: "three", host: "github.com", number: 3, snapshot_json: null },
        { thread_id: "two", host: "arcadia", number: 2, snapshot_json: null },
      ];
      assert.deepStrictEqual(yield* readLinks, expected);

      // Running again is a no-op: the fork ledger remembers it.
      assert.deepStrictEqual(yield* runForkMigrations(), []);
      assert.deepStrictEqual(yield* readLinks, expected);
    }).pipe(Effect.provide(FreshSqlite)),
  );

  it.effect("reconcile frees the shared id an earlier fork build recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A database the previous fork build migrated: our migration sits at 54,
      // which upstream has since given to ProjectionThreadsAutoSettleDisabledAt.
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (54, 'CanonicalArcanumThreadPullRequests', '2026-09-15T00:00:00.000Z')
      `;
      yield* insertLink({ threadId: "two", host: "a.yandex-team.ru", number: 2, snapshot: null });

      // Startup order: reconcile, upstream, fork.
      yield* reconcileForkLedger();
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[54, "ProjectionThreadsAutoSettleDisabledAt"]]);
      yield* runForkMigrations();

      const ledger = yield* readUpstreamLedger;
      assert.include(ledger, "54_ProjectionThreadsAutoSettleDisabledAt");
      assert.notInclude(ledger, "54_CanonicalArcanumThreadPullRequests");
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "auto_settle_disabled_at"));
      assert.deepStrictEqual(yield* readLinks, [
        { thread_id: "two", host: "arcadia", number: 2, snapshot_json: null },
      ]);
    }).pipe(Effect.provide(FreshSqlite)),
  );

  it.effect("reconcile is a no-op on a fresh database", () =>
    Effect.gen(function* () {
      yield* reconcileForkLedger();
      yield* runMigrations();
      yield* runForkMigrations();
      assert.include(yield* readUpstreamLedger, "54_ProjectionThreadsAutoSettleDisabledAt");
    }).pipe(Effect.provide(FreshSqlite)),
  );
});
