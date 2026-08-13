import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewThread,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * Arcanum's enums are decoded as plain strings and normalized here, in the same tolerant style
 * as the Bitbucket and GitLab decoders: a new pull request status or check state must not fail
 * a whole payload. The wire shapes below were verified against the live API and its swagger
 * dump (2026-08-10) unless a comment says otherwise. API timestamps are ISO8601 UTC with
 * microseconds; the CLI JSONL alone spells time protobuf-style as {seconds, nanos}.
 */

/** The CLI JSONL reports no update timestamp; the page needs some ISO instant. */
export const ARCANUM_EPOCH = "1970-01-01T00:00:00Z";

/** How much of a host-reported error message travels into an error detail. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * One mapping for every place Arcanum states a lifecycle: the CLI `status`, the search
 * endpoint's `full_status`, and the v2 detail's `status` all spell merged and discarded the
 * same way, and everything else — open, draft, uploading, conflicts, merging, merge_failed —
 * is a change request still standing.
 */
function arcanumStateOf(value: string | null | undefined): PullRequestState {
  switch (value?.trim().toLowerCase()) {
    case "merged":
      return "merged";
    case "discarded":
      return "closed";
    default:
      return "open";
  }
}

function toActorFromLogin(login: string | null): PullRequestActor | null {
  return login === null ? null : { login, name: login, avatarUrl: null };
}

/** Verified: Arcanum user objects are `{name, uid}`, and `name` IS the login. No avatar. */
const RawActorSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

/** An assignee arrives as `{user:{name}}` on the search endpoint; a bare `{name}` reads too. */
const RawAssigneeSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(RawActorSchema)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeActorPayload = Schema.decodeUnknownExit(RawActorSchema);
const decodeAssigneePayload = Schema.decodeUnknownExit(RawAssigneeSchema);
const decodeLabelPayload = Schema.decodeUnknownExit(RawLabelSchema);

function toReviewers(entries: ReadonlyArray<unknown>): ReadonlyArray<PullRequestActor> {
  return entries.flatMap((entry) => {
    const decoded = decodeActorPayload(entry);
    if (Exit.isFailure(decoded)) return [];
    const actor = toActorFromLogin(trimmed(decoded.value.name));
    return actor === null ? [] : [actor];
  });
}

function toAssigneeLogins(entries: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return entries.flatMap((entry) => {
    const decoded = decodeAssigneePayload(entry);
    if (Exit.isFailure(decoded)) return [];
    const login = trimmed(decoded.value.user?.name) ?? trimmed(decoded.value.name);
    return login === null ? [] : [login];
  });
}

function toLabels(entries: ReadonlyArray<unknown>): ReadonlyArray<PullRequestLabel> {
  return entries.flatMap((entry): ReadonlyArray<PullRequestLabel> => {
    const decoded = decodeLabelPayload(entry);
    if (Exit.isFailure(decoded)) return [];
    const name = trimmed(decoded.value.name);
    // Arcanum labels carry no color of their own.
    return name === null ? [] : [{ name, color: null }];
  });
}

export interface ArcanumChangeRequestRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly additions: number;
  readonly deletions: number;
}

// ---------------------------------------------------------------------------
// CLI rows: `arc pr list --json` (JSONL — the merged-state listing only, the
// search endpoint having no merged() atom) and `arc pr status <ref> --json`.
// ---------------------------------------------------------------------------

/** Verified: the CLI's protobuf-style timestamp, `{seconds, nanos}`, seconds sometimes a string. */
const RawCliTimestampSchema = Schema.Struct({
  seconds: Schema.Union([Schema.Number, Schema.String]),
  nanos: Schema.optional(Schema.NullOr(Schema.Number)),
});

/**
 * One row of the CLI's JSONL, verified keys: id, url, author (a bare login string), summary,
 * description, status (open|draft|merged|discarded), issues, from_branch, from_id, to_branch,
 * reviewers, created_at — plus merged_revision once merged. Only what the page reads is
 * decoded, optionally wherever a row can stand without it.
 */
const RawCliRowSchema = Schema.Struct({
  id: PositiveInt,
  url: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  from_branch: TrimmedNonEmptyString,
  to_branch: TrimmedNonEmptyString,
  author: Schema.optional(Schema.NullOr(Schema.String)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  created_at: Schema.optional(Schema.NullOr(RawCliTimestampSchema)),
});

function isoFromProtoSeconds(
  timestamp: Schema.Schema.Type<typeof RawCliTimestampSchema> | null | undefined,
): string | null {
  if (timestamp === null || timestamp === undefined) return null;
  const seconds = Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) return null;
  return Option.match(DateTime.make(seconds * 1000), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function toCliRow(raw: Schema.Schema.Type<typeof RawCliRowSchema>): ArcanumChangeRequestRow {
  const createdAt = isoFromProtoSeconds(raw.created_at) ?? ARCANUM_EPOCH;
  return {
    number: raw.id,
    title: raw.summary,
    url: raw.url,
    author: toActorFromLogin(trimmed(raw.author)),
    headBranch: raw.from_branch,
    baseBranch: raw.to_branch,
    state: arcanumStateOf(raw.status),
    // Draft is a fourth CLI status rather than a flag of its own.
    isDraft: raw.status?.trim().toLowerCase() === "draft",
    createdAt,
    // The JSONL carries no updated_at at all, so the creation instant stands in for it.
    updatedAt: createdAt,
    reviewRequestLogins: (raw.reviewers ?? []).flatMap((login) => trimmed(login) ?? []),
    // Labels ride the API rows; the CLI row spells only issue keys, which are not labels.
    labels: [],
    additions: 0,
    deletions: 0,
  };
}

const decodeCliRow = decodeJsonResult(RawCliRowSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/** One `arc pr status <ref> --json` answer. */
export function decodeChangeRequestRowJson(
  raw: string,
): Result.Result<ArcanumChangeRequestRow, DecodeFailure> {
  const decoded = decodeCliRow(raw.trim());
  return Result.isSuccess(decoded)
    ? Result.succeed(toCliRow(decoded.success))
    : Result.fail(decoded.failure);
}

/**
 * `arc pr list --json` prints JSONL, one pull request per line. An undecodable line is skipped
 * rather than failing the batch, as on the other hosts.
 */
export function decodeChangeRequestRowsJsonl(raw: string): ReadonlyArray<ArcanumChangeRequestRow> {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const decoded = decodeCliRow(line);
      return Result.isSuccess(decoded) ? [toCliRow(decoded.success)] : [];
    });
}

// ---------------------------------------------------------------------------
// HTTP: every successful Arcanum response envelopes as {"data": ...}; a failed
// one as {"errors":[{"status":"<code-string>","message":"..."}]}.
// ---------------------------------------------------------------------------

const RawEnvelopeSchema = Schema.Struct({ data: Schema.Unknown });
const decodeEnvelope = decodeJsonResult(RawEnvelopeSchema);

const RawErrorEnvelopeSchema = Schema.Struct({ errors: Schema.Array(Schema.Unknown) });
const RawErrorEntrySchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Int]))),
  message: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeErrorEnvelope = decodeJsonResult(RawErrorEnvelopeSchema);
const decodeErrorEntry = Schema.decodeUnknownExit(RawErrorEntrySchema);

/**
 * The first message of a failed response's own envelope — e.g. "reviewRequest 999999999 not
 * found" — bounded because it travels into an error detail the page shows. Null for a body
 * that is not Arcanum's error shape at all.
 */
export function decodeErrorMessageJson(raw: string): string | null {
  const envelope = decodeErrorEnvelope(raw);
  if (!Result.isSuccess(envelope)) return null;
  for (const entry of envelope.success.errors) {
    const decoded = decodeErrorEntry(entry);
    if (Exit.isFailure(decoded)) continue;
    const message = trimmed(decoded.value.message);
    if (message !== null) return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }
  return null;
}

/** A commit id goes back into an `arc` argv, so it is checked rather than trusted. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

// ---------------------------------------------------------------------------
// Search: GET /v1/review-requests?query=...
// ---------------------------------------------------------------------------

/**
 * One row of the search endpoint, exactly the fields the listing asks for. `vcs` is required
 * whole: the wire contract will not carry a change request without its branches, so a row
 * missing them is skipped rather than breaking the page it travels in.
 */
const RawSearchRowSchema = Schema.Struct({
  id: PositiveInt,
  url: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  vcs: Schema.Struct({
    from_branch: TrimmedNonEmptyString,
    to_branch: TrimmedNonEmptyString,
  }),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  /** draft | published | discarded — the publication state, not the lifecycle. */
  status: Schema.optional(Schema.NullOr(Schema.String)),
  /** The lifecycle: open | merged | discarded | merging | ... */
  full_status: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  active_diff_set: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        patch_stats: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              additions: Schema.optional(Schema.NullOr(Schema.Int)),
              deletions: Schema.optional(Schema.NullOr(Schema.Int)),
            }),
          ),
        ),
      }),
    ),
  ),
});

const RawSearchPageSchema = Schema.Struct({
  review_requests: Schema.Array(Schema.Unknown),
});

const decodeSearchPagePayload = Schema.decodeUnknownExit(RawSearchPageSchema);
const decodeSearchRowPayload = Schema.decodeUnknownExit(RawSearchRowSchema);

function toSearchRow(raw: Schema.Schema.Type<typeof RawSearchRowSchema>): ArcanumChangeRequestRow {
  return {
    number: raw.id,
    title: raw.summary,
    url: raw.url,
    author: toActorFromLogin(trimmed(raw.author?.name)),
    headBranch: raw.vcs.from_branch,
    baseBranch: raw.vcs.to_branch,
    state: arcanumStateOf(raw.full_status),
    isDraft: raw.status?.trim().toLowerCase() === "draft",
    createdAt: trimmed(raw.created_at) ?? ARCANUM_EPOCH,
    updatedAt: trimmed(raw.updated_at) ?? ARCANUM_EPOCH,
    reviewRequestLogins: toAssigneeLogins(raw.assignees ?? []),
    labels: toLabels(raw.labels ?? []),
    additions: raw.active_diff_set?.patch_stats?.additions ?? 0,
    deletions: raw.active_diff_set?.patch_stats?.deletions ?? 0,
  };
}

/**
 * The search page, row for raw row: a malformed entry decodes to null rather than vanishing,
 * because the caller pages this endpoint by offset and has to count every row it consumed —
 * malformed ones included — to know where the next slice starts.
 */
export function decodeSearchRowsJson(
  raw: string,
): Result.Result<ReadonlyArray<ArcanumChangeRequestRow | null>, DecodeFailure> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const page = decodeSearchPagePayload(envelope.success.data);
  if (Exit.isFailure(page)) return Result.fail(page.cause);
  return Result.succeed(
    page.value.review_requests.map((entry) => {
      const row = decodeSearchRowPayload(entry);
      return Exit.isSuccess(row) ? toSearchRow(row.value) : null;
    }),
  );
}

// ---------------------------------------------------------------------------
// Detail: GET /v2/pull-requests/{id}.
// ---------------------------------------------------------------------------

/**
 * The v2 detail, every field verified live. There is no draft flag here — draft lives on the
 * v1 entity's `status` — and `closed_at` only appears once the request merged or discarded.
 */
const RawDetailSchema = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  approvers: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  vcs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        from_branch: Schema.optional(Schema.NullOr(Schema.String)),
        to_branch: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  /** open|uploading|conflicts|errors|configuration_failed|merging|merge_failed|merged|discarded|no_changes|unknown */
  status: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  attention_required: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

export interface ArcanumPullRequestDetail {
  readonly url: string | null;
  readonly title: string | null;
  readonly author: PullRequestActor | null;
  readonly body: string;
  readonly state: PullRequestState;
  readonly mergeability: PullRequestMergeability;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
}

const decodeDetailPayload = Schema.decodeUnknownExit(RawDetailSchema);

export function decodePullRequestDetailJson(
  raw: string,
): Result.Result<ArcanumPullRequestDetail, DecodeFailure> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const decoded = decodeDetailPayload(envelope.success.data);
  if (Exit.isFailure(decoded)) return Result.fail(decoded.cause);
  const detail = decoded.value;
  const state = arcanumStateOf(detail.status);
  const closedAt = trimmed(detail.closed_at);
  // The nearest thing to a conflict statement anywhere on the detail.
  const conflicting = (detail.attention_required ?? []).some(
    (entry) => typeof entry === "string" && entry.trim().toLowerCase() === "conflict",
  );
  return Result.succeed({
    url: trimmed(detail.url),
    title: trimmed(detail.summary),
    author: toActorFromLogin(trimmed(detail.author?.name)),
    body: detail.description ?? "",
    state,
    mergeability: conflicting ? "conflicting" : "unknown",
    headBranch: trimmed(detail.vcs?.from_branch),
    baseBranch: trimmed(detail.vcs?.to_branch),
    reviewers: toReviewers(detail.approvers ?? []),
    reviewRequestLogins: toAssigneeLogins(detail.assignees ?? []),
    labels: toLabels(detail.labels ?? []),
    createdAt: trimmed(detail.created_at),
    updatedAt: trimmed(detail.updated_at),
    // `closed_at` is the one closing instant Arcanum reports, whichever way it closed.
    mergedAt: state === "merged" ? closedAt : null,
    closedAt,
  });
}

// ---------------------------------------------------------------------------
// Enrichment: GET /v1/review-requests/{id}?fields=status,active_diff_set(...),
// then GET /v1/review-requests/{id}/diff-sets/{diffSetId}/checks.
// ---------------------------------------------------------------------------

const RawEnrichmentSchema = Schema.Struct({
  /** draft | published | discarded — the publication state the v2 detail does not carry. */
  status: Schema.optional(Schema.NullOr(Schema.String)),
  active_diff_set: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Int, Schema.String]))),
        patch_stats: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              additions: Schema.optional(Schema.NullOr(Schema.Int)),
              deletions: Schema.optional(Schema.NullOr(Schema.Int)),
            }),
          ),
        ),
      }),
    ),
  ),
});

export interface ArcanumPullRequestEnrichment {
  readonly isDraft: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** The active diff set's id, which is where the checks with real statuses live. */
  readonly diffSetId: string | null;
}

const decodeEnrichmentPayload = Schema.decodeUnknownExit(RawEnrichmentSchema);

export function decodePullRequestEnrichmentJson(
  raw: string,
): Result.Result<ArcanumPullRequestEnrichment, DecodeFailure> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const decoded = decodeEnrichmentPayload(envelope.success.data);
  if (Exit.isFailure(decoded)) return Result.fail(decoded.cause);
  const enrichment = decoded.value;
  const diffSetId = enrichment.active_diff_set?.id;
  return Result.succeed({
    isDraft: enrichment.status?.trim().toLowerCase() === "draft",
    additions: enrichment.active_diff_set?.patch_stats?.additions ?? 0,
    deletions: enrichment.active_diff_set?.patch_stats?.deletions ?? 0,
    diffSetId: diffSetId === null || diffSetId === undefined ? null : String(diffSetId),
  });
}

/**
 * One check of `/v1/review-requests/{id}/diff-sets/{diffSetId}/checks`, shape verified live
 * (2026-08-11): {system: "CI"|"arcanum", type, status, description, system_check_uri,
 * updated_at, ...}. The entity's own `checks` field carries NO `status` key at all — reading
 * it is what once rendered every check as neutral — so statuses are read from here.
 */
const RawCheckSchema = Schema.Struct({
  system: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  system_check_uri: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCheckPayload = Schema.decodeUnknownExit(RawCheckSchema);

/**
 * The check status vocabulary as the diff-set checks endpoint answers it — pending, success,
 * failure and skipped observed live (2026-08-11), with running, error, cancelled, unknown and
 * action_required in the swagger beside them. Anything new reads as neutral rather than
 * failing the check.
 */
function toCheckStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
    case "running":
      return "pending";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    // action_required and unknown carry no verdict of their own.
    default:
      return "neutral";
  }
}

/** Malformed and nameless entries are skipped rather than failing the whole board. */
export function decodeDiffSetChecksJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCheck>, DecodeFailure> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const rows = decodeArrayPayload(envelope.success.data);
  if (Exit.isFailure(rows)) return Result.fail(rows.cause);
  const checks: PullRequestCheck[] = [];
  for (const row of rows.value) {
    const check = decodeCheckPayload(row);
    if (Exit.isFailure(check)) continue;
    const name = trimmed(check.value.type) ?? trimmed(check.value.system);
    if (name === null) continue;
    checks.push({
      name,
      status: toCheckStatus(check.value.status),
      description: trimmed(check.value.description),
      url: trimmed(check.value.system_check_uri),
    });
  }
  return Result.succeed(checks);
}

// ---------------------------------------------------------------------------
// Diff plumbing: active-diff and changelist.
// ---------------------------------------------------------------------------

/**
 * `/v1/pull-requests/{id}/active-diff` — verified fields: id, commit_ids{base,merge},
 * has_conflicts, published, created_at; only the ids are asked for. The two commit ids go
 * back into an `arc diff` argv, so a payload whose ids are not sha-shaped is a failed decode
 * rather than a trusted argument.
 */
const RawActiveDiffSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Int, Schema.String]))),
  commit_ids: Schema.Struct({
    base: TrimmedNonEmptyString,
    merge: TrimmedNonEmptyString,
  }),
});

export interface ArcanumActiveDiff {
  /** The diff set id, which a line comment names as `diff_set_xid`. */
  readonly id: string;
  readonly base: string;
  readonly merge: string;
}

const decodeActiveDiffPayload = Schema.decodeUnknownExit(RawActiveDiffSchema);

export function decodeActiveDiffJson(
  raw: string,
): Result.Result<ArcanumActiveDiff, DecodeFailure | Error> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const decoded = decodeActiveDiffPayload(envelope.success.data);
  if (Exit.isFailure(decoded)) return Result.fail(decoded.cause);
  const { base, merge } = decoded.value.commit_ids;
  if (!COMMIT_SHA_PATTERN.test(base) || !COMMIT_SHA_PATTERN.test(merge)) {
    return Result.fail(new Error("The active diff named commit ids that are not commit shas."));
  }
  return Result.succeed({
    id: decoded.value.id === null || decoded.value.id === undefined ? "" : String(decoded.value.id),
    base,
    merge,
  });
}

/**
 * One changelist row — verified fields: path, entry_id ("eid:1:…"), change_type
 * (none|add|modify|delete|copy|move|conflict), binary, source{path, commit_id}, patch_stats.
 * `source.path` is what a copied or moved file was called before, which is how a review
 * comment on a renamed file finds its entry.
 */
const RawChangelistEntrySchema = Schema.Struct({
  path: TrimmedNonEmptyString,
  entry_id: Schema.Union([Schema.Int, Schema.String]),
  source: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export interface ArcanumChangelistEntry {
  readonly path: string;
  /** Kept exactly as Arcanum sent it — number or string — because it is round-tripped back. */
  readonly entryId: string | number;
  /** The path a copied or moved file had before the change; null everywhere else. */
  readonly sourcePath: string | null;
}

const RawArraySchema = Schema.Array(Schema.Unknown);
const decodeArrayPayload = Schema.decodeUnknownExit(RawArraySchema);
const decodeChangelistEntry = Schema.decodeUnknownExit(RawChangelistEntrySchema);

/** Malformed entries are skipped rather than failing the changelist, as on the other hosts. */
export function decodeChangelistJson(
  raw: string,
): Result.Result<ReadonlyArray<ArcanumChangelistEntry>, DecodeFailure> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const rows = decodeArrayPayload(envelope.success.data);
  if (Exit.isFailure(rows)) return Result.fail(rows.cause);
  const entries: ArcanumChangelistEntry[] = [];
  for (const row of rows.value) {
    const entry = decodeChangelistEntry(row);
    if (Exit.isFailure(entry)) continue;
    entries.push({
      path: entry.value.path,
      entryId: entry.value.entry_id,
      sourcePath: trimmed(entry.value.source?.path),
    });
  }
  return Result.succeed(entries);
}

// ---------------------------------------------------------------------------
// Comments: GET /v1/public/review-requests/{id}/comments.
// ---------------------------------------------------------------------------

/**
 * One comment's anchor, shape verified live: the file names its two content ids and the
 * position beside them; position.side is {old|new}. Replies travel flat via reply_to_id and
 * carry no anchor and no issue_status of their own.
 */
const RawAnchorSchema = Schema.Struct({
  review_request: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        diff: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              file: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    entry_id: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          content_id_before: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                commit_id: Schema.optional(Schema.NullOr(Schema.String)),
                                path: Schema.optional(Schema.NullOr(Schema.String)),
                              }),
                            ),
                          ),
                          content_id_after: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                commit_id: Schema.optional(Schema.NullOr(Schema.String)),
                                path: Schema.optional(Schema.NullOr(Schema.String)),
                              }),
                            ),
                          ),
                        }),
                      ),
                    ),
                    position: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          line: Schema.optional(Schema.NullOr(Schema.Int)),
                          size: Schema.optional(Schema.NullOr(Schema.Int)),
                          side: Schema.optional(Schema.NullOr(Schema.String)),
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});

/**
 * One reaction as the comments payload spells it: `{code, user}`, one entry per person. The
 * code vocabulary is matched tolerantly onto the eight contents the contract carries, and
 * anything outside them is left out rather than shown under a name no picker could take back
 * — the same doctrine as GitLab's awards.
 */
// UNVERIFIED: the reaction code vocabulary; the field shape is live-verified, the spellings
// below cover the common forms until a live payload settles them.
const CONTENT_BY_ARCANUM_CODE: Record<string, PullRequestReactionContent> = {
  "+1": "thumbs-up",
  thumbs_up: "thumbs-up",
  thumbsup: "thumbs-up",
  like: "thumbs-up",
  "-1": "thumbs-down",
  thumbs_down: "thumbs-down",
  thumbsdown: "thumbs-down",
  dislike: "thumbs-down",
  laugh: "laugh",
  laughing: "laugh",
  smile: "laugh",
  hooray: "hooray",
  tada: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const RawReactionSchema = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawActorSchema)),
});

const decodeReactionPayload = Schema.decodeUnknownExit(RawReactionSchema);

function toCommentReactions(entries: ReadonlyArray<unknown>): ReadonlyArray<PullRequestReaction> {
  const groups = new Map<PullRequestReactionContent, { count: number; actors: string[] }>();
  for (const entry of entries) {
    const decoded = decodeReactionPayload(entry);
    if (Exit.isFailure(decoded)) continue;
    const content = CONTENT_BY_ARCANUM_CODE[trimmed(decoded.value.code)?.toLowerCase() ?? ""];
    if (content === undefined) continue;
    const group = groups.get(content) ?? { count: 0, actors: [] };
    group.count += 1;
    const actor = trimmed(decoded.value.user?.name);
    if (actor !== null) group.actors.push(actor);
    groups.set(content, group);
  }
  // Nothing in the payload says which reaction is the reader's, and with no verified write
  // endpoint there is no pill to press or take back — so none reads as pressed.
  return [...groups.entries()].map(([content, group]) => ({
    content,
    count: group.count,
    actors: group.actors,
    viewerHasReacted: false,
  }));
}

const RawCommentSchema = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  published_at: Schema.optional(Schema.NullOr(Schema.String)),
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawActorSchema)),
  /** open | resolved | dropped | not_issue — the verified vocabulary. */
  issue_status: Schema.optional(Schema.NullOr(Schema.String)),
  reply_to_id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Int, Schema.String]))),
  /** Verified absent when false, which optional decoding reads correctly. */
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  reactions: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  anchor: Schema.optional(Schema.NullOr(RawAnchorSchema)),
});

type RawComment = Schema.Schema.Type<typeof RawCommentSchema>;

const decodeCommentEntry = Schema.decodeUnknownExit(RawCommentSchema);

export interface ArcanumActivity {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  /** Every entry kept after deleted and draft comments were dropped. */
  readonly commentCount: number;
}

/**
 * Arcanum answers one flat array, so threads are reassembled from it: a root with an anchor
 * opens one, and every reply that names it belongs in it. Every kept comment also stands in
 * the flat timeline — an anchored one as a review-comment pinned to its path, the way the
 * GitHub provider reads its review threads into the conversation — because a timeline that
 * hides the inline remarks counts what it will not show. Deleted comments and drafts their
 * author has not published carry nothing to show.
 */
export function decodeCommentsJson(
  raw: string,
  prUrl: string,
): Result.Result<ArcanumActivity, DecodeFailure> {
  const envelope = decodeEnvelope(raw);
  if (!Result.isSuccess(envelope)) return Result.fail(envelope.failure);
  const rows = decodeArrayPayload(envelope.success.data);
  if (Exit.isFailure(rows)) return Result.fail(rows.cause);

  const kept: RawComment[] = [];
  for (const row of rows.value) {
    const entry = decodeCommentEntry(row);
    if (Exit.isFailure(entry)) continue;
    const comment = entry.value;
    if (trimmed(comment.deleted_at) !== null || comment.draft === true) continue;
    kept.push(comment);
  }

  const byId = new Map(kept.map((comment) => [String(comment.id), comment]));
  const rootIdOf = (comment: RawComment): string => {
    // Bounded by the number of comments read, so a reply cycle cannot spin here.
    let current = comment;
    for (let step = 0; step < byId.size; step += 1) {
      const parent =
        current.reply_to_id === null || current.reply_to_id === undefined
          ? undefined
          : byId.get(String(current.reply_to_id));
      if (parent === undefined) return String(current.id);
      current = parent;
    }
    return String(current.id);
  };

  const anchorOf = (comment: RawComment) => comment.anchor?.review_request?.diff?.file;

  const repliesByRoot = new Map<string, RawComment[]>();
  for (const comment of kept) {
    const rootId = rootIdOf(comment);
    const bucket = repliesByRoot.get(rootId);
    if (bucket === undefined) repliesByRoot.set(rootId, [comment]);
    else bucket.push(comment);
  }

  const toThreadComment = (comment: RawComment): PullRequestThreadComment => {
    const reactions =
      comment.reactions === null || comment.reactions === undefined
        ? undefined
        : toCommentReactions(comment.reactions);
    return {
      id: String(comment.id),
      author:
        comment.user === null || comment.user === undefined
          ? null
          : toActorFromLogin(trimmed(comment.user.name)),
      body: comment.content ?? "",
      createdAt: comment.created_at,
      // UNVERIFIED: whether Arcanum serves a per-comment anchor url; the pull request's own page
      // with the comment id as a fragment is the simplest address that lands near it.
      url: `${prUrl}#comment-${String(comment.id)}`,
      // Read-only: the reactions ride the payload whether or not the host takes new ones.
      ...(reactions === undefined ? {} : { reactions }),
    };
  };

  const comments: PullRequestComment[] = [];
  const reviewThreads: PullRequestReviewThread[] = [];
  for (const root of kept) {
    const rootId = String(root.id);
    if (rootIdOf(root) !== rootId) continue;
    const members = (repliesByRoot.get(rootId) ?? []).toSorted((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
    const file = anchorOf(root);
    if (file === null || file === undefined) {
      // A root without an anchor and every reply under it read as the flat timeline.
      for (const member of members) {
        comments.push({
          ...toThreadComment(member),
          kind: "issue-comment",
          path: null,
          reviewState: null,
        });
      }
      continue;
    }
    const side = file.position?.side?.trim().toLowerCase() === "old" ? "left" : "right";
    const path =
      side === "right"
        ? (trimmed(file.entry_id?.content_id_after?.path) ??
          trimmed(file.entry_id?.content_id_before?.path))
        : (trimmed(file.entry_id?.content_id_before?.path) ??
          trimmed(file.entry_id?.content_id_after?.path));
    if (path === null) continue;
    const rawLine = file.position?.line ?? null;
    const size = file.position?.size ?? 1;
    const line = rawLine === null || rawLine <= 0 ? null : rawLine + Math.max(0, size - 1);
    const issueStatus = trimmed(root.issue_status)?.toLowerCase() ?? null;
    reviewThreads.push({
      id: rootId,
      path,
      line,
      side,
      // `not_issue` leaves nothing to resolve either, so it reads as a settled thread.
      isResolved:
        issueStatus === "resolved" || issueStatus === "dropped" || issueStatus === "not_issue",
      // Arcanum reports nothing about a thread outliving the line it was written against.
      isOutdated: false,
      comments: members.map(toThreadComment),
    });
    // The same remarks read into the timeline as well, pinned to their file: the diff wants
    // whole threads and the conversation wants everything said, in one chronological stream.
    for (const member of members) {
      comments.push({
        ...toThreadComment(member),
        kind: "review-comment",
        path,
        reviewState: null,
      });
    }
  }

  return Result.succeed({
    // Anchored and plain remarks interleave by instant, not by which thread they came from.
    comments: comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    reviewThreads,
    commentCount: kept.length,
  });
}
