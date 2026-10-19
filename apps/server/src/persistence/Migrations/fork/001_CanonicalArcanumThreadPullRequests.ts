import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Canonicalize old review-host keys to arcadia so duplicate links stop triggering redundant host reads.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM projection_thread_pull_requests
    WHERE host = 'a.yandex-team.ru'
      AND repository = 'arcadia'
      AND EXISTS (
        SELECT 1
        FROM projection_thread_pull_requests AS canonical
        WHERE canonical.thread_id = projection_thread_pull_requests.thread_id
          AND canonical.host = 'arcadia'
          AND canonical.repository = 'arcadia'
          AND canonical.number = projection_thread_pull_requests.number
      )
  `;
  yield* sql`
    UPDATE projection_thread_pull_requests
    SET host = 'arcadia'
    WHERE host = 'a.yandex-team.ru'
      AND repository = 'arcadia'
  `;
});
