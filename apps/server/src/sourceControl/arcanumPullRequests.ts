import type * as Cause from "effect/Cause";
import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedArcanumPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
}

// `arc pr status --json` shape. Arcanum reports no update timestamp, so
// updatedAt is always none.
const ArcanumPullRequestSchema = Schema.Struct({
  id: PositiveInt,
  url: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  from_branch: TrimmedNonEmptyString,
  to_branch: TrimmedNonEmptyString,
});

// Arcanum PR statuses are open | merged | discarded.
function normalizeArcanumPullRequestState(
  state: string | null | undefined,
): "open" | "closed" | "merged" {
  const normalized = state?.trim().toLowerCase();
  if (normalized === "merged") {
    return "merged";
  }
  if (normalized === "discarded") {
    return "closed";
  }
  return "open";
}

function normalizeArcanumPullRequestRecord(
  raw: Schema.Schema.Type<typeof ArcanumPullRequestSchema>,
): NormalizedArcanumPullRequestRecord {
  return {
    number: raw.id,
    title: raw.summary,
    url: raw.url,
    baseRefName: raw.to_branch,
    headRefName: raw.from_branch,
    state: normalizeArcanumPullRequestState(raw.status),
    updatedAt: Option.none(),
  };
}

const decodeArcanumPullRequest = decodeJsonResult(ArcanumPullRequestSchema);

export const formatArcanumJsonDecodeError = formatSchemaError;

export function decodeArcanumPullRequestJson(
  raw: string,
): Result.Result<NormalizedArcanumPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeArcanumPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeArcanumPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
