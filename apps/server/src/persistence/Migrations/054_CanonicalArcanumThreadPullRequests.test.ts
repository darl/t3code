import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_CanonicalArcanumThreadPullRequests", (it) => {
  it.effect("folds review-host links onto the arcadia key, keeping the synced copy", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const insert = (row: {
        readonly threadId: string;
        readonly host: string;
        readonly number: number;
        readonly snapshot: string | null;
      }) => sql`
        INSERT INTO projection_thread_pull_requests
          (thread_id, host, repository, number, url, source, linked_at, snapshot_json, stack_json)
        VALUES (
          ${row.threadId}, ${row.host}, 'arcadia', ${row.number},
          ${`https://a.yandex-team.ru/review/${row.number}`}, 'agent',
          '2026-09-15T00:00:00.000Z', ${row.snapshot}, NULL
        )
      `;
      // Re-linked after the fix: the old row never synced, the new one did.
      yield* insert({ threadId: "one", host: "a.yandex-team.ru", number: 1, snapshot: null });
      yield* insert({
        threadId: "one",
        host: "arcadia",
        number: 1,
        snapshot: '{"state":"merged"}',
      });
      // Linked only before the fix: the row itself moves to the canonical key.
      yield* insert({ threadId: "two", host: "a.yandex-team.ru", number: 2, snapshot: null });
      // Other hosts are not touched.
      yield* insert({ threadId: "three", host: "github.com", number: 3, snapshot: null });

      yield* runMigrations({ toMigrationInclusive: 54 });

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
      assert.deepStrictEqual(
        rows.map((row) => ({ ...row })),
        [
          { thread_id: "one", host: "arcadia", number: 1, snapshot_json: '{"state":"merged"}' },
          { thread_id: "three", host: "github.com", number: 3, snapshot_json: null },
          { thread_id: "two", host: "arcadia", number: 2, snapshot_json: null },
        ],
      );
    }),
  );
});
