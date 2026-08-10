import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PullRequestActor } from "@t3tools/contracts";

import * as ArcanumCli from "../sourceControl/ArcanumCli.ts";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";
import * as ArcanumPullRequestProvider from "./ArcanumPullRequestProvider.ts";
import { ARCANUM_VIEWER_PERMISSIONS, arcanumErrorReason } from "./ArcanumPullRequestProvider.ts";
import type {
  ArcanumChangeRequestRow,
  ArcanumPullRequestDetail,
} from "./arcanumPullRequestJson.ts";

const PR_URL = "https://a.yandex-team.ru/review/123456";

const alice: PullRequestActor = { login: "alice", name: "alice", avatarUrl: null };
const bob: PullRequestActor = { login: "bob", name: "bob", avatarUrl: null };

describe("arcanumErrorReason", () => {
  it("reports a missing arc as the tool's absence, and a signed-out one as the account's", () => {
    const context = {
      operation: "execute" as const,
      command: "arc" as const,
      cwd: "/w/arcadia",
      cause: new Error("spawn arc ENOENT"),
    };

    expect(arcanumErrorReason(new ArcanumCli.ArcanumCliUnavailableError(context))).toBe(
      "missing-tool",
    );
    expect(arcanumErrorReason(new ArcanumCli.ArcanumCliAuthenticationError(context))).toBe(
      "unauthenticated",
    );
    expect(arcanumErrorReason(new ArcanumCli.ArcanumCliCommandError(context))).toBe("failed");
  });

  it("treats an absent token and an HTTP 401 as unusable credentials, and nothing else", () => {
    const responseError = (status: number) =>
      new ArcanumPullRequestApi.ArcanumResponseError({
        operation: "getPullRequestDetail",
        status,
        responseBodyLength: 0,
      });

    expect(
      arcanumErrorReason(new ArcanumPullRequestApi.ArcanumTokenMissingError({ operation: "x" })),
    ).toBe("unauthenticated");
    expect(arcanumErrorReason(responseError(401))).toBe("unauthenticated");
    expect(arcanumErrorReason(responseError(403))).toBe("failed");
    expect(
      arcanumErrorReason(
        new ArcanumPullRequestApi.ArcanumRequestError({
          operation: "comment",
          cause: new Error("socket closed"),
        }),
      ),
    ).toBe("failed");
  });
});

describe("arcanum viewer permissions", () => {
  it("grants everything the capabilities declare, because Arcanum names no permission", () => {
    // Arcanum states nothing per viewer anywhere these reads reach, and an unreported
    // permission is granted rather than guessed away: Arcanum refuses the ones it will not
    // allow, at the moment they are taken, in words this could not have written.
    expect(ARCANUM_VIEWER_PERMISSIONS).toEqual({
      actions: ["close", "ready"],
      comment: true,
      resolve: true,
      // Approve is deferred until the /v1/approvals endpoint the swagger names is probed;
      // request-changes is Arcanum's open issues.
      verdicts: ["comment", "request-changes"],
      // False because the host offers no reviewer request here, not because this viewer may not.
      requestReviewers: false,
    });
  });
});

const detailFixture: ArcanumPullRequestDetail = {
  url: PR_URL,
  title: "paths: tighten the family engines",
  author: alice,
  body: "See the review notes.",
  state: "open",
  mergeability: "unknown",
  headBranch: "users/alice/feature-x",
  baseBranch: "trunk",
  reviewers: [bob],
  reviewRequestLogins: ["bob"],
  labels: [{ name: "backend", color: null }],
  createdAt: "2026-07-01T10:00:00.123456Z",
  updatedAt: "2026-07-02T11:00:00.123456Z",
  mergedAt: null,
  closedAt: null,
};

const listRowFixture: ArcanumChangeRequestRow = {
  number: 123456,
  title: "paths: tighten the family engines",
  url: PR_URL,
  author: alice,
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
};

const target = {
  cwd: "/w/arcadia",
  repository: "arcadia",
  host: "arcadia",
  number: 123456,
};

describe("ArcanumPullRequestProvider.make", () => {
  it.effect("reads the detail sequentially: v2, then v1 enrichment, then the changed files", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const provider = yield* ArcanumPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({
            getPullRequestDetail: vi.fn(() =>
              Effect.sync(() => {
                calls.push("detail");
                return detailFixture;
              }),
            ),
            getPullRequestEnrichment: vi.fn(() =>
              Effect.sync(() => {
                calls.push("enrichment");
                return {
                  checks: [
                    { name: "build", status: "success" as const, description: null, url: null },
                  ],
                  isDraft: true,
                  additions: 5,
                  deletions: 1,
                };
              }),
            ),
            getActiveDiff: vi.fn(() =>
              Effect.sync(() => {
                calls.push("activeDiff");
                return { id: "777", base: "a".repeat(40), merge: "b".repeat(40) };
              }),
            ),
            getChangelist: vi.fn(() =>
              Effect.sync(() => {
                calls.push("changelist");
                return [
                  { path: "project/lib/util.ts", entryId: 41, sourcePath: null },
                  { path: "project/lib/other.ts", entryId: 42, sourcePath: null },
                ];
              }),
            ),
          }),
        ),
      );

      const detail = yield* provider.getChangeRequest(target);

      // Sequential, one request a second being Arcanum's ceiling — never a burst.
      expect(calls).toEqual(["detail", "enrichment", "activeDiff", "changelist"]);
      expect(detail).toMatchObject({
        number: 123456,
        title: "paths: tighten the family engines",
        url: PR_URL,
        state: "open",
        // Draft lives on the v1 entity, not the v2 detail.
        isDraft: true,
        additions: 5,
        deletions: 1,
        changedFiles: 2,
        reviewers: [bob],
        reviewRequestLogins: ["bob"],
        labels: [{ name: "backend", color: null }],
        checks: [{ name: "build", status: "success", description: null, url: null }],
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        viewerPermissions: ARCANUM_VIEWER_PERMISSIONS,
      });
    }),
  );

  it.effect("degrades the enrichment and the count rather than blanking the detail", () =>
    Effect.gen(function* () {
      const refusal = new ArcanumPullRequestApi.ArcanumResponseError({
        operation: "getPullRequestEnrichment",
        status: 500,
        responseBodyLength: 0,
      });
      const provider = yield* ArcanumPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({
            getPullRequestDetail: vi.fn(() => Effect.succeed(detailFixture)),
            getPullRequestEnrichment: vi.fn(() => Effect.fail(refusal)),
            getActiveDiff: vi.fn(() => Effect.fail(refusal)),
          }),
        ),
      );

      const detail = yield* provider.getChangeRequest(target);

      expect(detail).toMatchObject({
        isDraft: false,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        checks: [],
        body: "See the review notes.",
      });
    }),
  );

  it.effect(
    "hands the search listing over with its cursor advance, as one a cursor continues",
    () =>
      Effect.gen(function* () {
        const listPullRequests = vi.fn<
          ArcanumPullRequestApi.ArcanumPullRequestApi["Service"]["listPullRequests"]
        >(() => Effect.succeed({ items: [listRowFixture], truncated: true, cursorAdvance: 3 }));
        const provider = yield* ArcanumPullRequestProvider.make.pipe(
          Effect.provide(
            Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({ listPullRequests }),
          ),
        );

        const page = yield* provider.listChangeRequests({
          ...target,
          state: "open",
          involvement: "authored",
          viewer: "alice",
          limit: 2,
          cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 3 },
        });

        expect(listPullRequests.mock.calls[0]?.[0]).toMatchObject({
          cwd: "/w/arcadia",
          cursor: { delivered: 3 },
        });
        expect(page.continues).toBe(true);
        expect(page.cursorAdvance).toBe(3);
        expect(page.items[0]).toMatchObject({
          number: 123456,
          additions: 10,
          deletions: 2,
          reviewRequestLogins: ["bob"],
          labels: [{ name: "backend", color: null }],
        });
      }),
  );

  it.effect("reports the merged listing as one no cursor continues", () =>
    Effect.gen(function* () {
      const provider = yield* ArcanumPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({
            listPullRequests: vi.fn(() => Effect.succeed({ items: [], truncated: false })),
          }),
        ),
      );

      const page = yield* provider.listChangeRequests({
        ...target,
        state: "merged",
        involvement: "all",
        viewer: "alice",
        limit: 20,
      });

      expect(page.continues).toBe(false);
      expect(page.cursorAdvance).toBeUndefined();
    }),
  );

  it.effect("refuses a commit-sliced diff cleanly, sha or not", () =>
    Effect.gen(function* () {
      const provider = yield* ArcanumPullRequestProvider.make.pipe(
        Effect.provide(Layer.mock(ArcanumPullRequestApi.ArcanumPullRequestApi)({})),
      );

      const invalid = yield* Effect.flip(
        provider.getDiff({ ...target, commit: "../../../etc/passwd" }),
      );
      const valid = yield* Effect.flip(provider.getDiff({ ...target, commit: "a1b2c3d4e5f6a7b8" }));

      assert.strictEqual(invalid.detail, "The named commit was not a commit sha.");
      assert.strictEqual(valid.detail, "Arcanum serves no per-commit diff.");
    }),
  );
});
