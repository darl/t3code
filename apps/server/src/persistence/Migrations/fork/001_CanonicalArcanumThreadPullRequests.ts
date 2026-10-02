import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Thread links to Arcanum reviews used to be stored under the review UI's hostname,
 * a.yandex-team.ru, while the arc checkout's project answers to the host "arcadia". Links
 * written since carry the canonical key, so a thread that was re-linked got a second row
 * for the same review: the old one could never be synced and kept the review due for a
 * host read every minute. Fold the old rows onto the canonical key.
 */
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
