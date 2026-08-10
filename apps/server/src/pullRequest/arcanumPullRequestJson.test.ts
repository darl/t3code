import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  ARCANUM_EPOCH,
  decodeActiveDiffJson,
  decodeChangeRequestRowJson,
  decodeChangeRequestRowsJsonl,
  decodeChangelistJson,
  decodeCommentsJson,
  decodeErrorMessageJson,
  decodePullRequestDetailJson,
  decodePullRequestEnrichmentJson,
  decodeSearchRowsJson,
} from "./arcanumPullRequestJson.ts";

const PR_URL = "https://a.yandex-team.ru/review/123456";

/** Shaped after `arc pr list --json` / `arc pr status --json`, trimmed to the fields read. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    url: PR_URL,
    summary: "paths: tighten the family engines",
    status: "open",
    from_branch: "users/alice/feature-x",
    to_branch: "trunk",
    ...overrides,
  };
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodeChangeRequestRowsJsonl", () => {
  it("reads one pull request per line, author and reviewers included", () => {
    const rows = decodeChangeRequestRowsJsonl(
      `${JSON.stringify(row({ author: "alice", reviewers: ["bob", "carol"] }))}\n${JSON.stringify(
        row({ id: 123457, summary: "second" }),
      )}\n`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      number: 123456,
      title: "paths: tighten the family engines",
      url: PR_URL,
      headBranch: "users/alice/feature-x",
      baseBranch: "trunk",
      state: "open",
      isDraft: false,
      author: { login: "alice", name: "alice", avatarUrl: null },
      reviewRequestLogins: ["bob", "carol"],
      labels: [],
      additions: 0,
      deletions: 0,
    });
    expect(rows[1]?.author).toBeNull();
  });

  it("skips an undecodable line rather than failing the batch", () => {
    const rows = decodeChangeRequestRowsJsonl(
      `not json at all\n${JSON.stringify({ id: "nope" })}\n${JSON.stringify(row())}\n`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe(123456);
  });

  it.each([
    ["open", "open"],
    ["draft", "open"],
    ["merged", "merged"],
    ["discarded", "closed"],
    ["something new", "open"],
  ])("reads the %s status as %s", (status, expected) => {
    const rows = decodeChangeRequestRowsJsonl(JSON.stringify(row({ status })));

    expect(rows[0]?.state).toBe(expected);
  });

  it("reads draft as a status of its own rather than a flag", () => {
    const rows = decodeChangeRequestRowsJsonl(JSON.stringify(row({ status: "draft" })));

    expect(rows[0]).toMatchObject({ state: "open", isDraft: true });
  });

  it("falls back to the epoch where the row carries no created_at", () => {
    const rows = decodeChangeRequestRowsJsonl(JSON.stringify(row()));

    expect(rows[0]).toMatchObject({ createdAt: ARCANUM_EPOCH, updatedAt: ARCANUM_EPOCH });
  });

  it("converts the protobuf-style {seconds, nanos} timestamp to ISO", () => {
    const rows = decodeChangeRequestRowsJsonl(
      JSON.stringify(row({ created_at: { seconds: 86_400, nanos: 500 } })),
    );

    expect(rows[0]?.createdAt).toBe("1970-01-02T00:00:00.000Z");
    // The JSONL has no updated_at at all, so the creation instant stands in for it.
    expect(rows[0]?.updatedAt).toBe("1970-01-02T00:00:00.000Z");
  });

  it("reads seconds spelled as a string, which the CLI also produces", () => {
    const rows = decodeChangeRequestRowsJsonl(
      JSON.stringify(row({ created_at: { seconds: "86400", nanos: 0 } })),
    );

    expect(rows[0]?.createdAt).toBe("1970-01-02T00:00:00.000Z");
  });
});

describe("decodeChangeRequestRowJson", () => {
  it("reads one `arc pr status --json` answer", () => {
    const decoded = expectSuccess(decodeChangeRequestRowJson(`${JSON.stringify(row())}\n`));

    expect(decoded.number).toBe(123456);
    expect(decoded.state).toBe("open");
  });

  it("fails on an answer that is not a pull request", () => {
    expect(Result.isFailure(decodeChangeRequestRowJson('{"error":"nope"}'))).toBe(true);
  });
});

/** One row as the search endpoint answers it, with every field the listing asks for. */
function searchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    url: PR_URL,
    summary: "paths: tighten the family engines",
    author: { name: "alice" },
    vcs: { from_branch: "users/alice/feature-x", to_branch: "trunk" },
    created_at: "2026-07-01T10:00:00.123456Z",
    updated_at: "2026-07-02T11:00:00.123456Z",
    status: "published",
    full_status: "open",
    labels: [{ name: "backend" }],
    assignees: [{ user: { name: "bob" } }],
    active_diff_set: { patch_stats: { additions: 10, deletions: 2 } },
    ...overrides,
  };
}

function searchPage(entries: ReadonlyArray<unknown>): string {
  return JSON.stringify({ data: { review_requests: entries } });
}

describe("decodeSearchRowsJson", () => {
  it("reads a search row whole: author, assignees, labels, and line counts", () => {
    const decoded = expectSuccess(decodeSearchRowsJson(searchPage([searchRow()])));

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual({
      number: 123456,
      title: "paths: tighten the family engines",
      url: PR_URL,
      author: { login: "alice", name: "alice", avatarUrl: null },
      headBranch: "users/alice/feature-x",
      baseBranch: "trunk",
      state: "open",
      isDraft: false,
      createdAt: "2026-07-01T10:00:00.123456Z",
      updatedAt: "2026-07-02T11:00:00.123456Z",
      reviewRequestLogins: ["bob"],
      labels: [{ name: "backend", color: null }],
      additions: 10,
      deletions: 2,
    });
  });

  it("keeps a malformed row as a null placeholder, because the offset must step past it", () => {
    const decoded = expectSuccess(decodeSearchRowsJson(searchPage([{ id: "nope" }, searchRow()])));

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toBeNull();
    expect(decoded[1]?.number).toBe(123456);
  });

  it("nulls a row without its branches, which the wire contract cannot carry", () => {
    const decoded = expectSuccess(decodeSearchRowsJson(searchPage([searchRow({ vcs: {} })])));

    expect(decoded[0]).toBeNull();
  });

  it.each([
    ["open", "open"],
    ["merged", "merged"],
    ["discarded", "closed"],
    ["merging", "open"],
  ])("reads full_status %s as %s", (fullStatus, expected) => {
    const decoded = expectSuccess(
      decodeSearchRowsJson(searchPage([searchRow({ full_status: fullStatus })])),
    );

    expect(decoded[0]?.state).toBe(expected);
  });

  it("reads the draft publication status as a draft", () => {
    const decoded = expectSuccess(
      decodeSearchRowsJson(searchPage([searchRow({ status: "draft" })])),
    );

    expect(decoded[0]?.isDraft).toBe(true);
  });

  it("fails when the answer carries no data envelope", () => {
    expect(Result.isFailure(decodeSearchRowsJson('{"error":"nope"}'))).toBe(true);
  });
});

describe("decodePullRequestDetailJson", () => {
  it("reads the v2 detail whole", () => {
    const decoded = expectSuccess(
      decodePullRequestDetailJson(
        JSON.stringify({
          data: {
            url: PR_URL,
            author: { name: "alice", uid: "1120000000000001" },
            summary: "paths: tighten the family engines",
            description: "See the review notes.",
            approvers: [{ name: "bob" }, { broken: 1 }],
            assignees: [{ name: "carol" }, { user: { name: "dave" } }],
            vcs: { from_branch: "users/alice/feature-x", to_branch: "trunk" },
            created_at: "2026-07-01T10:00:00.123456Z",
            updated_at: "2026-07-02T11:00:00.123456Z",
            status: "open",
            labels: [{ name: "backend" }],
          },
        }),
      ),
    );

    expect(decoded).toEqual({
      url: PR_URL,
      title: "paths: tighten the family engines",
      author: { login: "alice", name: "alice", avatarUrl: null },
      body: "See the review notes.",
      state: "open",
      mergeability: "unknown",
      headBranch: "users/alice/feature-x",
      baseBranch: "trunk",
      reviewers: [{ login: "bob", name: "bob", avatarUrl: null }],
      reviewRequestLogins: ["carol", "dave"],
      labels: [{ name: "backend", color: null }],
      createdAt: "2026-07-01T10:00:00.123456Z",
      updatedAt: "2026-07-02T11:00:00.123456Z",
      // `closed_at` only appears once the request closed, and it has not.
      mergedAt: null,
      closedAt: null,
    });
  });

  it("reads a merged detail's closed_at as the merge instant", () => {
    const decoded = expectSuccess(
      decodePullRequestDetailJson(
        JSON.stringify({
          data: {
            description: "",
            status: "merged",
            closed_at: "2026-07-03T12:00:00.123456Z",
          },
        }),
      ),
    );

    expect(decoded.state).toBe("merged");
    expect(decoded.mergedAt).toBe("2026-07-03T12:00:00.123456Z");
    expect(decoded.closedAt).toBe("2026-07-03T12:00:00.123456Z");
  });

  it("reads a discarded detail as closed but not merged", () => {
    const decoded = expectSuccess(
      decodePullRequestDetailJson(
        JSON.stringify({
          data: { status: "discarded", closed_at: "2026-07-03T12:00:00.123456Z" },
        }),
      ),
    );

    expect(decoded.state).toBe("closed");
    expect(decoded.mergedAt).toBeNull();
    expect(decoded.closedAt).toBe("2026-07-03T12:00:00.123456Z");
  });

  it("reads a conflict in attention_required as conflicting", () => {
    const decoded = expectSuccess(
      decodePullRequestDetailJson(JSON.stringify({ data: { attention_required: ["conflict"] } })),
    );

    expect(decoded.mergeability).toBe("conflicting");
  });

  it("tolerates a nearly empty payload", () => {
    const decoded = expectSuccess(decodePullRequestDetailJson(JSON.stringify({ data: {} })));

    expect(decoded).toMatchObject({
      url: null,
      title: null,
      author: null,
      body: "",
      state: "open",
      mergeability: "unknown",
      reviewers: [],
      labels: [],
    });
  });

  it("fails when the answer carries no data envelope", () => {
    expect(Result.isFailure(decodePullRequestDetailJson('{"error":"nope"}'))).toBe(true);
  });
});

describe("decodePullRequestEnrichmentJson", () => {
  it("reads checks, the draft status, and the line counts", () => {
    const decoded = expectSuccess(
      decodePullRequestEnrichmentJson(
        JSON.stringify({
          data: {
            status: "draft",
            checks: [
              {
                system: "CI",
                type: "build",
                status: "success",
                description: "all green",
                system_check_uri: "https://ci.test.local/build/1",
              },
              // A nameless check carries nothing to show and is skipped.
              { status: "failure" },
            ],
            active_diff_set: { patch_stats: { additions: 12, deletions: 3 } },
          },
        }),
      ),
    );

    expect(decoded).toEqual({
      isDraft: true,
      additions: 12,
      deletions: 3,
      checks: [
        {
          name: "build",
          status: "success",
          description: "all green",
          url: "https://ci.test.local/build/1",
        },
      ],
    });
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
    ["error", "failure"],
    ["pending", "pending"],
    ["cancelled", "cancelled"],
    ["skipped", "skipped"],
    ["action_required", "neutral"],
    ["unknown", "neutral"],
    ["never seen before", "neutral"],
  ])("reads the %s check status as %s", (status, expected) => {
    const decoded = expectSuccess(
      decodePullRequestEnrichmentJson(
        JSON.stringify({ data: { checks: [{ type: "lint", status }] } }),
      ),
    );

    expect(decoded.checks[0]?.status).toBe(expected);
  });

  it("names a check by its system when it carries no type", () => {
    const decoded = expectSuccess(
      decodePullRequestEnrichmentJson(
        JSON.stringify({ data: { checks: [{ system: "arcanum", status: "pending" }] } }),
      ),
    );

    expect(decoded.checks[0]?.name).toBe("arcanum");
  });

  it("answers a published request as not a draft", () => {
    const decoded = expectSuccess(
      decodePullRequestEnrichmentJson(JSON.stringify({ data: { status: "published" } })),
    );

    expect(decoded).toEqual({ isDraft: false, additions: 0, deletions: 0, checks: [] });
  });
});

describe("decodeErrorMessageJson", () => {
  it("reads the first message of the errors envelope", () => {
    const message = decodeErrorMessageJson(
      JSON.stringify({
        errors: [{ status: "404", message: "reviewRequest 123456 not found" }],
      }),
    );

    expect(message).toBe("reviewRequest 123456 not found");
  });

  it("answers null for a body that is not the errors shape", () => {
    expect(decodeErrorMessageJson("<html>gateway timeout</html>")).toBeNull();
    expect(decodeErrorMessageJson(JSON.stringify({ data: {} }))).toBeNull();
  });

  it("bounds a message that would not fit an error detail", () => {
    const message = decodeErrorMessageJson(
      JSON.stringify({ errors: [{ status: "400", message: "x".repeat(500) }] }),
    );

    expect(message).toHaveLength(200);
  });
});

describe("decodeActiveDiffJson", () => {
  it("reads the diff set id and the two commit ids", () => {
    const decoded = expectSuccess(
      decodeActiveDiffJson(
        JSON.stringify({
          data: { id: 777, commit_ids: { base: "a".repeat(40), merge: "b".repeat(40) } },
        }),
      ),
    );

    expect(decoded).toEqual({ id: "777", base: "a".repeat(40), merge: "b".repeat(40) });
  });

  it("refuses commit ids that are not shas, because they go back into an argv", () => {
    const decoded = decodeActiveDiffJson(
      JSON.stringify({
        data: { id: 777, commit_ids: { base: "--exec=evil", merge: "b".repeat(40) } },
      }),
    );

    expect(Result.isFailure(decoded)).toBe(true);
  });
});

describe("decodeChangelistJson", () => {
  it("reads paths, entry ids and source paths, skipping malformed rows", () => {
    const decoded = expectSuccess(
      decodeChangelistJson(
        JSON.stringify({
          data: [
            { path: "project/lib/util.ts", entry_id: 41 },
            {
              path: "project/lib/moved.ts",
              entry_id: "eid:1:42",
              change_type: "move",
              source: { path: "project/lib/before.ts", commit_id: "c".repeat(40) },
            },
            { nope: true },
          ],
        }),
      ),
    );

    // Entry ids round-trip exactly as they arrived, number or string.
    expect(decoded).toEqual([
      { path: "project/lib/util.ts", entryId: 41, sourcePath: null },
      { path: "project/lib/moved.ts", entryId: "eid:1:42", sourcePath: "project/lib/before.ts" },
    ]);
  });
});

function anchor(overrides: {
  readonly side?: string;
  readonly line?: number;
  readonly size?: number;
  readonly beforePath?: string | null;
  readonly afterPath?: string | null;
}): Record<string, unknown> {
  return {
    review_request: {
      diff: {
        file: {
          entry_id: {
            content_id_before: {
              commit_id: "a".repeat(40),
              path: overrides.beforePath ?? "project/lib/util.ts",
            },
            content_id_after: {
              commit_id: "b".repeat(40),
              path: overrides.afterPath ?? "project/lib/util.ts",
            },
          },
          position: {
            line: overrides.line ?? 12,
            size: overrides.size ?? 1,
            side: overrides.side ?? "new",
          },
        },
      },
    },
  };
}

function comments(entries: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({ data: entries });
}

describe("decodeCommentsJson", () => {
  it("reads a root without an anchor and its reply as the flat timeline", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 10,
            content: "Looks close.",
            created_at: "2026-07-01T10:00:00Z",
            user: { name: "bob" },
          },
          {
            id: 11,
            content: "Agreed.",
            created_at: "2026-07-01T11:00:00Z",
            user: { name: "alice" },
            reply_to_id: 10,
          },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.reviewThreads).toEqual([]);
    expect(decoded.comments.map((comment) => [comment.id, comment.kind])).toEqual([
      ["10", "issue-comment"],
      ["11", "issue-comment"],
    ]);
    expect(decoded.comments[0]).toMatchObject({
      author: { login: "bob" },
      body: "Looks close.",
      url: `${PR_URL}#comment-10`,
      path: null,
    });
    expect(decoded.commentCount).toBe(2);
  });

  it("skips deleted comments and unpublished drafts", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 10,
            content: "gone",
            created_at: "2026-07-01T10:00:00Z",
            deleted_at: "2026-07-01T12:00:00Z",
          },
          { id: 11, content: "still drafting", created_at: "2026-07-01T10:00:00Z", draft: true },
          { id: 12, content: "stands", created_at: "2026-07-01T10:00:00Z" },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.comments.map((comment) => comment.id)).toEqual(["12"]);
    expect(decoded.commentCount).toBe(1);
  });

  it("reads an anchored root as a thread on the new side of the diff", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 20,
            content: "tighten this",
            created_at: "2026-07-01T10:00:00Z",
            user: { name: "bob" },
            issue_status: "open",
            anchor: anchor({ side: "new", line: 12, afterPath: "project/lib/util.ts" }),
          },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.comments).toEqual([]);
    expect(decoded.reviewThreads).toHaveLength(1);
    expect(decoded.reviewThreads[0]).toMatchObject({
      id: "20",
      path: "project/lib/util.ts",
      line: 12,
      side: "right",
      isResolved: false,
      isOutdated: false,
    });
  });

  it("anchors an old-side thread to the path the file had before", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 21,
            content: "why remove?",
            created_at: "2026-07-01T10:00:00Z",
            anchor: anchor({
              side: "old",
              line: 30,
              beforePath: "project/lib/before.ts",
              afterPath: "project/lib/after.ts",
            }),
          },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.reviewThreads[0]).toMatchObject({
      path: "project/lib/before.ts",
      side: "left",
      line: 30,
    });
  });

  it("points a ranged comment at the last line of its range", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 22,
            content: "this whole block",
            created_at: "2026-07-01T10:00:00Z",
            anchor: anchor({ line: 10, size: 4 }),
          },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.reviewThreads[0]?.line).toBe(13);
  });

  it.each([
    ["resolved", true],
    ["dropped", true],
    // Verified vocabulary: not_issue leaves nothing to resolve either.
    ["not_issue", true],
    ["open", false],
    [null, false],
  ])("reads issue_status %s as isResolved %s", (issueStatus, expected) => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 23,
            content: "note",
            created_at: "2026-07-01T10:00:00Z",
            issue_status: issueStatus,
            anchor: anchor({}),
          },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.reviewThreads[0]?.isResolved).toBe(expected);
  });

  it("keeps an anchored thread's replies inside it, sorted, and out of the flat timeline", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          {
            id: 30,
            content: "root",
            created_at: "2026-07-01T10:00:00Z",
            anchor: anchor({}),
          },
          // Arrives out of order, and a reply to a reply still belongs to the root's thread.
          {
            id: 32,
            content: "third",
            created_at: "2026-07-01T12:00:00Z",
            reply_to_id: 31,
          },
          {
            id: 31,
            content: "second",
            created_at: "2026-07-01T11:00:00Z",
            reply_to_id: 30,
          },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.comments).toEqual([]);
    expect(decoded.reviewThreads[0]?.comments.map((comment) => comment.id)).toEqual([
      "30",
      "31",
      "32",
    ]);
    expect(decoded.commentCount).toBe(3);
  });

  it("skips an unreadable entry rather than failing the conversation", () => {
    const decoded = expectSuccess(
      decodeCommentsJson(
        comments([
          { id: {} as unknown as number, content: "broken" },
          { id: 40, content: "stands", created_at: "2026-07-01T10:00:00Z" },
        ]),
        PR_URL,
      ),
    );

    expect(decoded.comments.map((comment) => comment.id)).toEqual(["40"]);
  });

  it("fails when the answer carries no data envelope", () => {
    expect(Result.isFailure(decodeCommentsJson('{"error":"nope"}', PR_URL))).toBe(true);
  });
});
