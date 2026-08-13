import * as Effect from "effect/Effect";
import type {
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import {
  ARCANUM_EPOCH,
  type ArcanumChangeRequestRow,
  type ArcanumPullRequestEnrichment,
} from "./arcanumPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  // `arc pr discard <id>` closes and `arc pr publish <id>` takes a draft live. `arc pr merge`
  // only configures merge settings — nothing here merges, so nothing offers to.
  actions: ["close", "ready"],
  mergeMethods: [],
  // No `updateMethods`: nothing verified brings an Arcanum branch up to date from here, and a
  // provider that says nothing offers nothing.
  // The search endpoint's query grammar has atoms for state, author, assignee, label and path
  // — and no free text at all (live-verified 400 "bad filter") — so a query is ignored rather
  // than sent as the wrong filter.
  search: false,
  // False is the write half: the comments payload carries reactions and they are decoded and
  // shown read-only, but no endpoint that adds or removes one has been verified, and this one
  // flag is what offers the picker.
  reactions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // Approve is deferred: an /v1/approvals endpoint exists in the swagger dump but has not
    // been probed, and a dead Approve button would be worse than none. Request-changes is
    // Arcanum's open issues.
    verdicts: ["comment", "request-changes"],
  },
  // Arcanum assigns reviewers through its own review rules, and nothing verified here lists
  // or writes them, so the page takes no part in it.
  reviewers: { request: false, listCandidates: false },
  // No `edit`: nothing verified rewrites a summary, a description or a remark on Arcanum, and
  // a host that says nothing about rewriting is one that cannot.
};

/**
 * Everything the capabilities declare, granted to whoever is signed in. Arcanum states nothing
 * per viewer anywhere these reads reach, and the upstream doctrine is that a permission the
 * host reports nothing about is granted: a hidden control leaves someone entitled to it with
 * no way through, while one Arcanum refuses at least says why.
 */
export const ARCANUM_VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  resolve: CAPABILITIES.review.resolve,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: CAPABILITIES.reviewers.request,
};

/** The failures that mean the tool or the credentials are the problem, rather than one request. */
export function arcanumErrorReason(
  error: ArcanumPullRequestApi.ArcanumPullRequestApiError,
): PullRequestProviderError["reason"] {
  switch (error._tag) {
    case "ArcanumCliUnavailableError":
      return "missing-tool";
    case "ArcanumCliAuthenticationError":
    case "ArcanumTokenMissingError":
      return "unauthenticated";
    case "ArcanumResponseError":
      return error.status === 401 ? "unauthenticated" : "failed";
    default:
      return "failed";
  }
}

function toChangeRequest(row: ArcanumChangeRequestRow): ProviderChangeRequest {
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    state: row.state,
    isDraft: row.isDraft,
    // A listing row reports no conflict state; the detail's attention_required does.
    mergeability: "unknown",
    additions: row.additions,
    deletions: row.deletions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewRequestLogins: row.reviewRequestLogins,
    labels: row.labels,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

  const fail = (operation: string) => (error: ArcanumPullRequestApi.ArcanumPullRequestApiError) =>
    new PullRequestProviderError({
      provider: "arcanum",
      operation,
      reason: arcanumErrorReason(error),
      // Every Arcanum failure states its own fact; this names the operation around it, so
      // the two do not stack into "failed in x: failed in y: ...".
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "arcanum",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      api.getViewer({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    // `input.query` is deliberately dropped: the search grammar matches no free text, so the
    // page comes back unnarrowed and the caller filters it.
    listChangeRequests: (input) =>
      api
        .listPullRequests({
          cwd: input.cwd,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            ...(batch.cursorAdvance === undefined ? {} : { cursorAdvance: batch.cursorAdvance }),
            // The search endpoint pages by offset in a stable -updated_at order, so its slices
            // can be stepped past. Merged listings ride the CLI, which answers in an order no
            // cursor continues — a larger limit is the only way to the rest there.
            continues: input.state !== "merged",
          })),
        ),

    getChangeRequest: (input) =>
      Effect.gen(function* () {
        // Sequential rather than a burst: Arcanum rate-limits around one request a second.
        // The v2 detail is the core; the v1 enrichment (checks, draft, line counts) and the
        // changed-file count degrade rather than blank it.
        const detail = yield* api.getPullRequestDetail({ number: input.number });
        const enrichment = yield* api.getPullRequestEnrichment({ number: input.number }).pipe(
          Effect.orElseSucceed(
            (): ArcanumPullRequestEnrichment => ({
              isDraft: false,
              additions: 0,
              deletions: 0,
              diffSetId: null,
            }),
          ),
        );
        // The check statuses live only on the diff set's own checks — the entity's `checks`
        // field carries none at all — so they are read by the id the enrichment answered.
        const checks =
          enrichment.diffSetId === null
            ? []
            : yield* api
                .getChecks({ number: input.number, diffSetId: enrichment.diffSetId })
                .pipe(Effect.orElseSucceed((): ReadonlyArray<PullRequestCheck> => []));
        const changedFiles = yield* api.getActiveDiff({ number: input.number }).pipe(
          Effect.flatMap((diff) => api.getChangelist({ number: input.number, diffId: diff.id })),
          Effect.map((changelist) => changelist.length),
          Effect.orElseSucceed(() => 0),
        );
        const updatedAt = detail.updatedAt ?? ARCANUM_EPOCH;
        const result: ProviderChangeRequestDetail = {
          number: input.number,
          title: detail.title ?? `Review request ${input.number}`,
          // The review UI's own address form, for a detail that answered without its url.
          url: detail.url ?? `https://a.yandex-team.ru/review/${input.number}`,
          author: detail.author,
          headBranch: detail.headBranch ?? "(unknown)",
          // Arcadia's default branch is always trunk.
          baseBranch: detail.baseBranch ?? "trunk",
          state: detail.state,
          isDraft: enrichment.isDraft,
          mergeability: detail.mergeability,
          additions: enrichment.additions,
          deletions: enrichment.deletions,
          createdAt: detail.createdAt ?? ARCANUM_EPOCH,
          updatedAt,
          reviewRequestLogins: detail.reviewRequestLogins,
          labels: detail.labels,
          body: detail.body,
          changedFiles,
          mergedAt: detail.mergedAt,
          closedAt: detail.closedAt,
          reviewers: detail.reviewers,
          checks,
          // Nothing here merges, so no strategy is offered either.
          mergeCapabilities: { merge: false, squash: false, rebase: false },
          viewerPermissions: ARCANUM_VIEWER_PERMISSIONS,
        };
        return result;
      }).pipe(Effect.mapError(fail("getChangeRequest"))),

    getChangeRequestActivity: (input) =>
      // The CLI status read is repeated for the pull request's own url, which every comment's
      // address hangs off, rather than making the core detail wait for the conversation.
      api.getPullRequestStatus({ cwd: input.cwd, number: input.number }).pipe(
        Effect.flatMap((status) => api.listActivity({ number: input.number, url: status.url })),
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          (activity): ProviderChangeRequestActivity => ({
            comments: activity.comments,
            commentCount: activity.commentCount,
            // The endpoint answers the conversation whole; a conversation read to its end is
            // never truncated, however long it is.
            commentsTruncated: false,
            reviewThreads: activity.reviewThreads,
            // Arcanum's commits live behind the diff-set list, which nothing verified reads yet.
            commits: [],
          }),
        ),
      ),

    // No request at all, like Azure: Arcanum states nothing about the viewer that a pull
    // request read can reach, so the answer is the same constant the detail carries.
    getViewerPermissions: () => Effect.succeed(ARCANUM_VIEWER_PERMISSIONS),

    getDiff: (input) => {
      // `commits` is always empty here, so a commit never arrives — but the parameter exists
      // on the port, and a value that is not a sha must not reach an argv. Checked first, and
      // a sha this provider cannot slice by is refused cleanly rather than answering with the
      // whole diff under a commit's name.
      if (input.commit !== undefined) {
        return Effect.fail(
          new PullRequestProviderError({
            provider: "arcanum",
            operation: "getDiff",
            reason: "failed",
            detail: /^[0-9a-f]{7,64}$/i.test(input.commit)
              ? "Arcanum serves no per-commit diff."
              : "The named commit was not a commit sha.",
          }),
        );
      }
      return api.getDiff({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getDiff")),
        Effect.map((diff) => ({ ...diff, nextCursor: null })),
      );
    },

    getDiffFileContents: (input) =>
      api
        .getDiffFileContents({
          cwd: input.cwd,
          number: input.number,
          changeType: input.changeType,
          oldPath: input.oldPath,
          newPath: input.newPath,
        })
        .pipe(Effect.mapError(fail("getDiffFileContents"))),

    runAction: (input) => {
      // Only close and ready reach here: the provider declares the others unsupported, so the
      // service never offers them — refused all the same rather than trusted.
      if (input.action === "close") {
        return api
          .discard({ cwd: input.cwd, number: input.number })
          .pipe(Effect.mapError(fail("runAction")));
      }
      if (input.action === "ready") {
        return api
          .publish({ cwd: input.cwd, number: input.number })
          .pipe(Effect.mapError(fail("runAction")));
      }
      return Effect.fail(
        new PullRequestProviderError({
          provider: "arcanum",
          operation: "runAction",
          reason: "failed",
          detail: `Arcanum cannot ${input.action} a change request from here.`,
        }),
      );
    },

    comment: (input) =>
      api
        .comment({ number: input.number, body: input.body })
        .pipe(Effect.mapError(fail("comment"))),

    submitReview: (input) =>
      api
        .submitReview({
          number: input.number,
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        })
        .pipe(Effect.mapError(fail("submitReview"))),

    // Never called: `capabilities.reviewers.listCandidates` is false, and the service refuses
    // the list without it.
    listReviewerCandidates: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "arcanum",
          operation: "listReviewerCandidates",
          reason: "failed",
          detail: "Arcanum cannot say who may review a change request.",
        }),
      ),

    // Never called: `capabilities.reviewers.request` is false, and the service refuses it
    // without it.
    setReviewerRequest: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "arcanum",
          operation: "setReviewerRequest",
          reason: "failed",
          detail: "Arcanum reviewer requests cannot be written from here yet.",
        }),
      ),

    replyToThread: (input) =>
      api
        .replyToThread({ threadId: input.threadId, body: input.body })
        .pipe(Effect.mapError(fail("replyToThread"))),

    // Never called: `capabilities.reactions` is false, and the service refuses without it.
    // The reactions the conversation carries are read-only until a write endpoint is verified.
    setReaction: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "arcanum",
          operation: "setReaction",
          reason: "failed",
          detail: "Arcanum reactions cannot be written from here yet.",
        }),
      ),

    setThreadResolution: (input) =>
      api
        .setThreadResolution({ threadId: input.threadId, resolved: input.resolved })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
