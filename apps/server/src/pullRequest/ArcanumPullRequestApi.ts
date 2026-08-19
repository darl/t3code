import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { NonNegativeInt } from "@t3tools/contracts";
import type {
  PullRequestCheck,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ArcanumCli from "../sourceControl/ArcanumCli.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";
import {
  decodeActiveDiffJson,
  decodeChangeRequestRowJson,
  decodeChangeRequestRowsJsonl,
  decodeChangelistJson,
  decodeCommentsJson,
  decodeDiffSetChecksJson,
  decodeErrorMessageJson,
  decodePullRequestDetailJson,
  decodePullRequestEnrichmentJson,
  decodeSearchRowsJson,
  type ArcanumActiveDiff,
  type ArcanumActivity,
  type ArcanumChangeRequestRow,
  type ArcanumChangelistEntry,
  type ArcanumPullRequestDetail,
  type ArcanumPullRequestEnrichment,
} from "./arcanumPullRequestJson.ts";

const DEFAULT_API_BASE_URL = "https://arcanum.yandex.net/api";
/** A response body past this is cut short, so one huge payload cannot exhaust the server. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The same ceilings the gh diff read uses; a whole diff is legitimately large. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;

const ArcanumApiEnvConfig = Config.all({
  baseUrl: Config.string("T3CODE_ARCANUM_API_BASE_URL").pipe(
    Config.withDefault(DEFAULT_API_BASE_URL),
  ),
  token: Config.string("ARC_TOKEN").pipe(Config.option),
  tokenPath: Config.string("ARC_TOKEN_PATH").pipe(Config.option),
  home: Config.string("HOME").pipe(Config.option),
});

/**
 * Every HTTP method fails with this while no token could be resolved, so the page reports the
 * account as signed out rather than each read failing its own way. Carries nothing but the
 * operation: the token is a secret, and even the paths it was looked for on stay out of errors.
 */
export class ArcanumTokenMissingError extends Schema.TaggedErrorClass<ArcanumTokenMissingError>()(
  "ArcanumTokenMissingError",
  {
    operation: Schema.String,
  },
) {
  get detail(): string {
    return "No Arcanum OAuth token was found. Run `arc token store` (or set ARC_TOKEN) and retry.";
  }

  override get message(): string {
    return `Arcanum API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumRequestError extends Schema.TaggedErrorClass<ArcanumRequestError>()(
  "ArcanumRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to send the Arcanum request.";
  }

  override get message(): string {
    return `Arcanum API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumResponseError extends Schema.TaggedErrorClass<ArcanumResponseError>()(
  "ArcanumResponseError",
  {
    operation: Schema.String,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    /**
     * The first message of the response's own errors envelope, e.g. "reviewRequest 999999999
     * not found" — bounded at decode, and never anything the request carried.
     */
    hostMessage: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return this.hostMessage === undefined
      ? `Arcanum returned HTTP ${this.status}.`
      : `Arcanum returned HTTP ${this.status}: ${this.hostMessage}`;
  }

  override get message(): string {
    return `Arcanum API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumResponseBodyReadError extends Schema.TaggedErrorClass<ArcanumResponseBodyReadError>()(
  "ArcanumResponseBodyReadError",
  {
    operation: Schema.String,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Arcanum returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Arcanum API failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumResponseDecodeError extends Schema.TaggedErrorClass<ArcanumResponseDecodeError>()(
  "ArcanumResponseDecodeError",
  {
    operation: Schema.String,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Arcanum returned invalid JSON for the requested resource.";
  }

  override get message(): string {
    return `Arcanum API failed in ${this.operation}: ${this.detail}`;
  }
}

/** Names the CLI read that produced unusable JSON, mirroring the Bitbucket read error. */
export class ArcanumCliDecodeError extends Schema.TaggedErrorClass<ArcanumCliDecodeError>()(
  "ArcanumCliDecodeError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Arc CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Arcanum API failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: arc answered, the account it answered for just has no login line. */
export class ArcanumViewerUnavailableError extends Schema.TaggedErrorClass<ArcanumViewerUnavailableError>()(
  "ArcanumViewerUnavailableError",
  {},
) {
  get detail(): string {
    return "Arc CLI reported no signed-in login for the configured credentials.";
  }

  override get message(): string {
    return `Arcanum API failed in getViewer: ${this.detail}`;
  }
}

/** Not a decode failure: the reader named a commit that is not a sha a repository could hold. */
export class ArcanumDiffCommitError extends Schema.TaggedErrorClass<ArcanumDiffCommitError>()(
  "ArcanumDiffCommitError",
  {},
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `Arcanum API failed in getDiff: ${this.detail}`;
  }
}

/** A review draft names a file the changelist does not hold, refused before anything posts. */
export class ArcanumReviewPathError extends Schema.TaggedErrorClass<ArcanumReviewPathError>()(
  "ArcanumReviewPathError",
  {
    path: Schema.String,
  },
) {
  get detail(): string {
    return `The review names ${this.path}, which is not in the change request's changelist.`;
  }

  override get message(): string {
    return `Arcanum API failed in submitReview: ${this.detail}`;
  }
}

/** The failures this file makes itself; the CLI errors keep the tags ArcanumCli gave them. */
export const ArcanumPullRequestHttpError = Schema.Union([
  ArcanumTokenMissingError,
  ArcanumRequestError,
  ArcanumResponseError,
  ArcanumResponseBodyReadError,
  ArcanumResponseDecodeError,
  ArcanumCliDecodeError,
  ArcanumViewerUnavailableError,
  ArcanumDiffCommitError,
  ArcanumReviewPathError,
]);
export type ArcanumPullRequestHttpError = typeof ArcanumPullRequestHttpError.Type;

export type ArcanumPullRequestApiError = ArcanumPullRequestHttpError | ArcanumCli.ArcanumCliError;

const isArcanumPullRequestHttpError = Schema.is(ArcanumPullRequestHttpError);

export function isArcanumPullRequestApiError(value: unknown): value is ArcanumPullRequestApiError {
  return isArcanumPullRequestHttpError(value) || ArcanumCli.isArcanumCliError(value);
}

/**
 * The v2 detail fields, verified against the live API + swagger (2026-08-10). Arcanum silently
 * ignores an unknown `fields` name — a 200 with the key absent, never a 4xx — so an unknown
 * name here can narrow the answer but cannot fail the read, and no fallback list is needed.
 */
const DETAIL_FIELDS =
  "url,author,summary,description,approvers,assignees,tickets,vcs,created_at,updated_at,closed_at,status,labels,merge_allowed,attention_required";

/**
 * The v1 entity fields carrying what v2 does not: the draft status, the line counts, and the
 * active diff set's id. The entity's own `checks` are NOT asked for — live-verified
 * (2026-08-11) to carry no `status` key at all; the statuses live on
 * `/diff-sets/{diffSetId}/checks`, which `getChecks` reads by that id.
 */
const ENRICHMENT_FIELDS = "status,active_diff_set(id,patch_stats(additions,deletions))";

/** The search listing's row fields, verified live (2026-08-10). */
const SEARCH_FIELDS =
  "review_requests(id,url,author(name),summary,vcs(from_branch,to_branch),created_at,updated_at,status,full_status,labels(name),assignees(user(name)),active_diff_set(patch_stats(additions,deletions)))";

export interface ArcanumPullRequestBatch {
  readonly items: ReadonlyArray<ArcanumChangeRequestRow>;
  readonly truncated: boolean;
  /**
   * Raw search rows consumed for this slice, malformed ones included, which is what an
   * offset-paged listing steps past. Absent on the CLI road, which no cursor continues.
   */
  readonly cursorAdvance?: number;
}

export class ArcanumPullRequestApi extends Context.Service<
  ArcanumPullRequestApi,
  {
    /** The signed-in login, which is what involvement filtering compares against. */
    readonly getViewer: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, ArcanumPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Where to carry on from; `delivered` is the search endpoint's offset. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<ArcanumPullRequestBatch, ArcanumPullRequestApiError>;

    /** `arc pr status <id> --json`: state, branches, url and title from the CLI's own answer. */
    readonly getPullRequestStatus: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<ArcanumChangeRequestRow, ArcanumPullRequestApiError>;

    /** The v2 detail: body, author, approvers, lifecycle, labels, branches, timestamps. */
    readonly getPullRequestDetail: (input: {
      readonly number: number;
    }) => Effect.Effect<ArcanumPullRequestDetail, ArcanumPullRequestApiError>;

    /** The v1 entity's draft status, line counts and diff set id, which v2 leaves out. */
    readonly getPullRequestEnrichment: (input: {
      readonly number: number;
    }) => Effect.Effect<ArcanumPullRequestEnrichment, ArcanumPullRequestApiError>;

    /** The active diff set's checks — the only place Arcanum reports their statuses. */
    readonly getChecks: (input: {
      readonly number: number;
      readonly diffSetId: string;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, ArcanumPullRequestApiError>;

    readonly getActiveDiff: (input: {
      readonly number: number;
    }) => Effect.Effect<ArcanumActiveDiff, ArcanumPullRequestApiError>;

    readonly getChangelist: (input: {
      readonly number: number;
      readonly diffId: string;
    }) => Effect.Effect<ReadonlyArray<ArcanumChangelistEntry>, ArcanumPullRequestApiError>;

    /** The conversation, threaded and flattened at once; `url` addresses the comments. */
    readonly listActivity: (input: {
      readonly number: number;
      readonly url: string;
    }) => Effect.Effect<ArcanumActivity, ArcanumPullRequestApiError>;

    /** The whole patch in one slice, produced by `arc diff` between the server revisions. */
    readonly getDiff: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      ArcanumPullRequestApiError
    >;

    readonly getDiffFileContents: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      ArcanumPullRequestApiError
    >;

    readonly discard: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<void, ArcanumPullRequestApiError>;

    readonly publish: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<void, ArcanumPullRequestApiError>;

    readonly comment: (input: {
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, ArcanumPullRequestApiError>;

    readonly submitReview: (input: {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, ArcanumPullRequestApiError>;

    readonly replyToThread: (input: {
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, ArcanumPullRequestApiError>;

    readonly setThreadResolution: (input: {
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, ArcanumPullRequestApiError>;
  }
>()("t3/pullRequest/ArcanumPullRequestApi") {}

/**
 * The search grammar's atoms, joined with ";" (AND). The verified vocabulary is author(x),
 * assignee(x), open(), draft(), published(), discarded(), label(x), path(x) — there is no
 * merged() atom and no free text, which is why the merged state keeps the CLI and
 * `capabilities.search` stays false.
 */
function searchAtoms(input: {
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  return [
    // "all" involvement is the whole-host feed, which no user atom narrows.
    ...(input.involvement === "authored"
      ? [`author(${input.viewer})`]
      : input.involvement === "reviewing"
        ? [`assignee(${input.viewer})`]
        : []),
    ...(input.state === "open" ? ["open()"] : input.state === "closed" ? ["discarded()"] : []),
  ];
}

function involvementArgs(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  switch (input.involvement) {
    case "authored":
      return ["-A", input.viewer];
    case "reviewing":
      return ["-R", input.viewer];
    case "all":
      return ["--all"];
  }
}

/** One diff coordinate as Arcanum spells it: a line number on the old or the new side. */
function arcanumReviewPosition(position: PullRequestReviewPosition): {
  readonly line: number;
  readonly side: "old" | "new";
} {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "new" };
    case "deleted":
      return { line: position.oldLine, side: "old" };
    case "context":
      return position.side === "left"
        ? { line: position.oldLine, side: "old" }
        : { line: position.newLine, side: "new" };
  }
}

export const make = Effect.gen(function* () {
  const config = yield* ArcanumApiEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const cli = yield* ArcanumCli.ArcanumCli;

  /**
   * THE TOKEN IS A SECRET. It lives in this closure, travels only inside the Authorization
   * header, and never reaches an error field, a log annotation, or a URL. Resolved once at
   * layer make: ARC_TOKEN, else the file ARC_TOKEN_PATH names, else `$HOME/.arc/token` — the
   * same order `arc` itself resolves it. An unreadable or empty file is an absent token.
   */
  const token: Option.Option<string> = yield* Effect.gen(function* () {
    const fromEnv = config.token.pipe(
      Option.map((value) => value.trim()),
      Option.filter((value) => value.length > 0),
    );
    if (Option.isSome(fromEnv)) return fromEnv;
    const path = Option.isSome(config.tokenPath)
      ? config.tokenPath.value
      : Option.isSome(config.home)
        ? `${config.home.value}/.arc/token`
        : null;
    if (path === null) return Option.none<string>();
    return yield* fileSystem.readFileString(path).pipe(
      Effect.map((contents) => {
        const trimmed = contents.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none<string>();
      }),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

  const apiUrl = (path: string) => `${config.baseUrl.replace(/\/+$/u, "")}${path}`;

  const responseError = (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<never, ArcanumPullRequestApiError> =>
    // Bounded like any other body. A failed response envelopes its own explanation as
    // {"errors":[{"status","message"}]}, and that message — never the request, never the
    // token — is worth carrying: "reviewRequest N not found" beats a bare 404.
    collectUint8StreamText({ stream: response.stream, maxBytes: MAX_RESPONSE_BYTES }).pipe(
      Effect.mapError(
        (cause) => new ArcanumResponseBodyReadError({ operation, status: response.status, cause }),
      ),
      Effect.flatMap((collected) => {
        const hostMessage = decodeErrorMessageJson(collected.text);
        return Effect.fail(
          new ArcanumResponseError({
            operation,
            status: response.status,
            responseBodyLength: collected.text.length,
            ...(hostMessage === null ? {} : { hostMessage }),
          }),
        );
      }),
    );

  /**
   * One authenticated request. Only paths onto the configured base are ever asked for —
   * nothing that came back inside a response body is fetched, so the token never travels
   * anywhere a payload pointed.
   *
   * Arcanum rate-limits at roughly one request a second (a 429 in the same errors envelope),
   * so callers composed of several reads run them sequentially rather than in a burst, and
   * the service's own caching is the main shield.
   */
  const request = (input: {
    readonly operation: string;
    readonly method: "GET" | "POST" | "PATCH";
    readonly path: string;
    readonly body?: string;
  }): Effect.Effect<
    { readonly status: number; readonly body: string },
    ArcanumPullRequestApiError
  > => {
    if (Option.isNone(token)) {
      return Effect.fail(new ArcanumTokenMissingError({ operation: input.operation }));
    }
    const url = apiUrl(input.path);
    const base =
      input.method === "GET"
        ? HttpClientRequest.get(url)
        : input.method === "POST"
          ? HttpClientRequest.post(url)
          : HttpClientRequest.make("PATCH")(url);
    const withBody =
      input.body === undefined
        ? base
        : base.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
    return httpClient
      .execute(withBody.pipe(HttpClientRequest.setHeader("authorization", `OAuth ${token.value}`)))
      .pipe(
        Effect.mapError(
          (cause): ArcanumPullRequestApiError =>
            new ArcanumRequestError({ operation: input.operation, cause }),
        ),
        Effect.flatMap((response) =>
          HttpClientResponse.matchStatus({
            "2xx": (success) =>
              collectUint8StreamText({ stream: success.stream, maxBytes: MAX_RESPONSE_BYTES }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ArcanumResponseBodyReadError({
                      operation: input.operation,
                      status: success.status,
                      cause,
                    }),
                ),
                Effect.map((collected) => ({ status: success.status, body: collected.text })),
              ),
            orElse: (failed) => responseError(input.operation, failed),
          })(response),
        ),
      );
  };

  const requestJson = <A>(input: {
    readonly operation: string;
    readonly method: "GET" | "POST" | "PATCH";
    readonly path: string;
    readonly body?: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, ArcanumPullRequestApiError> =>
    request(input).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new ArcanumResponseDecodeError({
                operation: input.operation,
                status: response.status,
                cause: decoded.failure,
              }),
            );
      }),
    );

  const getActiveDiff: ArcanumPullRequestApi["Service"]["getActiveDiff"] = (input) =>
    requestJson({
      operation: "getActiveDiff",
      method: "GET",
      path: `/v1/pull-requests/${input.number}/active-diff?fields=commit_ids(base,merge),id`,
      decode: decodeActiveDiffJson,
    });

  const getChangelist: ArcanumPullRequestApi["Service"]["getChangelist"] = (input) =>
    requestJson({
      operation: "getChangelist",
      method: "GET",
      path: `/v1/review-requests/${input.number}/diff-sets/${encodeURIComponent(
        input.diffId,
      )}/changelist?fields=path,entry_id,source(path)`,
      decode: decodeChangelistJson,
    });

  /**
   * A whole file at one server revision. A failure of the command itself is tolerated as an
   * empty file — the side a new or deleted file does not have, or a path arc cannot serve at
   * that revision — while a missing or signed-out arc still fails, because that is not a fact
   * about the file.
   */
  const showFile = (input: {
    readonly cwd: string;
    readonly revision: string;
    readonly path: string;
  }): Effect.Effect<string, ArcanumPullRequestApiError> =>
    cli
      .execute({
        cwd: input.cwd,
        args: ["show", `${input.revision}:${input.path}`],
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
        timeoutMs: DIFF_TIMEOUT_MS,
      })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.catchTag("ArcanumCliCommandError", () => Effect.succeed("")),
      );

  return ArcanumPullRequestApi.of({
    getViewer: (input) =>
      cli.execute({ cwd: input.cwd, args: ["user-info"] }).pipe(
        Effect.flatMap((result) => {
          // The same regexes ArcanumCli reads its own login with.
          const login =
            /Effective login:\s*(\S+)/iu.exec(result.stdout)?.[1] ??
            /Token login:\s*(\S+)/iu.exec(result.stdout)?.[1] ??
            null;
          return login === null
            ? Effect.fail(new ArcanumViewerUnavailableError())
            : Effect.succeed(login);
        }),
      ),

    listPullRequests: (input) => {
      // The search grammar has no merged() atom (live-verified 400 "bad filter"), so the one
      // state it cannot ask for keeps the CLI road, exactly as the listing always read.
      if (input.state === "merged") {
        return cli
          .execute({
            cwd: input.cwd,
            args: [
              "pr",
              "list",
              "--json",
              "--sort",
              "date",
              // One row past the page, which is the whole of how truncation is known: the CLI
              // reports no count and pages nothing.
              "-l",
              String(input.limit + 1),
              "-S",
              "merged",
              ...involvementArgs(input),
            ],
          })
          .pipe(
            Effect.map((result) => {
              const rows = decodeChangeRequestRowsJsonl(result.stdout);
              return { items: rows.slice(0, input.limit), truncated: rows.length > input.limit };
            }),
          );
      }
      const atoms = searchAtoms(input);
      // Offset paging: `delivered` counts every raw row already stepped past, and one row past
      // the page answers whether more remain. `order=-updated_at` is stable, so the same offset
      // means the same boundary next time.
      const offset = input.cursor?.delivered ?? 0;
      const query = atoms.length === 0 ? "" : `query=${encodeURIComponent(atoms.join(";"))}&`;
      return requestJson({
        operation: "listPullRequests",
        method: "GET",
        path: `/v1/review-requests?${query}fields=${SEARCH_FIELDS}&limit=${
          input.limit + 1
        }&offset=${offset}&order=-updated_at`,
        decode: decodeSearchRowsJson,
      }).pipe(
        Effect.map((entries) => {
          // Raw rows are consumed one by one — malformed ones included, because the offset has
          // to step past them too — until the page is filled or the answer runs out.
          const items: ArcanumChangeRequestRow[] = [];
          let consumed = 0;
          for (const entry of entries) {
            if (items.length === input.limit) break;
            consumed += 1;
            if (entry !== null) items.push(entry);
          }
          return { items, truncated: entries.length > consumed, cursorAdvance: consumed };
        }),
      );
    },

    getPullRequestStatus: (input) =>
      cli.execute({ cwd: input.cwd, args: ["pr", "status", String(input.number), "--json"] }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeChangeRequestRowJson(result.stdout);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new ArcanumCliDecodeError({
                  operation: "getPullRequestStatus",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    // One request with the whole verified list: Arcanum silently ignores an unknown `fields`
    // name rather than refusing it, so no fallback read exists to make.
    getPullRequestDetail: (input) =>
      requestJson({
        operation: "getPullRequestDetail",
        method: "GET",
        path: `/v2/pull-requests/${input.number}?fields=${DETAIL_FIELDS}`,
        decode: decodePullRequestDetailJson,
      }),

    getPullRequestEnrichment: (input) =>
      requestJson({
        operation: "getPullRequestEnrichment",
        method: "GET",
        path: `/v1/review-requests/${input.number}?fields=${ENRICHMENT_FIELDS}`,
        decode: decodePullRequestEnrichmentJson,
      }),

    getChecks: (input) =>
      requestJson({
        operation: "getChecks",
        method: "GET",
        path: `/v1/review-requests/${input.number}/diff-sets/${encodeURIComponent(
          input.diffSetId,
        )}/checks`,
        decode: decodeDiffSetChecksJson,
      }),

    getActiveDiff,

    getChangelist,

    listActivity: (input) =>
      requestJson({
        operation: "listActivity",
        method: "GET",
        path: `/v1/public/review-requests/${input.number}/comments`,
        decode: (body) => decodeCommentsJson(body, input.url),
      }),

    // `arc diff <base> <merge>` against the active diff's server revisions produces the same
    // unified patch the review shows; the ids were checked for sha shape as they decoded.
    getDiff: (input) =>
      getActiveDiff({ number: input.number }).pipe(
        Effect.flatMap((diff) =>
          cli.execute({
            cwd: input.cwd,
            args: ["diff", diff.base, diff.merge],
            maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
            timeoutMs: DIFF_TIMEOUT_MS,
          }),
        ),
        Effect.map((result) => ({ patch: result.stdout, truncated: result.stdoutTruncated })),
      ),

    getDiffFileContents: (input) =>
      getActiveDiff({ number: input.number }).pipe(
        Effect.flatMap((diff) =>
          Effect.all(
            [
              input.changeType === "new"
                ? Effect.succeed("")
                : showFile({ cwd: input.cwd, revision: diff.base, path: input.oldPath }),
              input.changeType === "deleted"
                ? Effect.succeed("")
                : showFile({ cwd: input.cwd, revision: diff.merge, path: input.newPath }),
            ],
            { concurrency: 2 },
          ),
        ),
        Effect.map(([oldContents, newContents]) => ({ oldContents, newContents })),
      ),

    discard: (input) =>
      cli
        .execute({ cwd: input.cwd, args: ["pr", "discard", String(input.number)] })
        .pipe(Effect.asVoid),

    publish: (input) =>
      cli
        .execute({ cwd: input.cwd, args: ["pr", "publish", String(input.number)] })
        .pipe(Effect.asVoid),

    comment: (input) =>
      request({
        operation: "comment",
        method: "POST",
        path: `/v1/review-requests/${input.number}/comments`,
        body: JSON.stringify({ content: input.body, draft: false }),
      }).pipe(Effect.asVoid),

    submitReview: (input) =>
      Effect.gen(function* () {
        const commentsPath = `/v1/review-requests/${input.number}/comments`;
        // Arcanum has no pending review, so a review is replayed as the requests it is made
        // of: the line comments, then the summary that carries the verdict's weight last — a
        // review that fails part-way is never left standing as a verdict. Request-changes IS
        // open issues here: that is Arcanum's own semantics for asking for changes.
        if (input.comments.length > 0) {
          const activeDiff = yield* getActiveDiff({ number: input.number });
          const changelist = yield* getChangelist({
            number: input.number,
            diffId: activeDiff.id,
          });
          const entryIdByPath = new Map(
            changelist.map((entry) => [entry.path, entry.entryId] as const),
          );
          // A copied or moved file also answers to the name it had before, which is what a
          // draft on a renamed file carries as `oldPath`.
          const entryIdBySourcePath = new Map(
            changelist.flatMap((entry) =>
              entry.sourcePath === null ? [] : [[entry.sourcePath, entry.entryId] as const],
            ),
          );
          // Every path is resolved before anything is posted, so a review that cannot land
          // whole is refused rather than half-written.
          const resolved: Array<{
            readonly draft: PullRequestReviewCommentDraft;
            readonly entryId: string | number;
          }> = [];
          for (const draft of input.comments) {
            const entryId =
              entryIdByPath.get(draft.path) ??
              (draft.oldPath === undefined
                ? undefined
                : (entryIdBySourcePath.get(draft.oldPath) ?? entryIdByPath.get(draft.oldPath)));
            if (entryId === undefined) {
              return yield* Effect.fail(new ArcanumReviewPathError({ path: draft.path }));
            }
            resolved.push({ draft, entryId });
          }
          yield* Effect.forEach(
            resolved,
            ({ draft, entryId }) => {
              const coordinates = arcanumReviewPosition(draft.position);
              return request({
                operation: "submitReview",
                method: "POST",
                path: commentsPath,
                body: JSON.stringify({
                  content: draft.body,
                  draft: false,
                  file_path: draft.path,
                  entry_id: entryId,
                  diff_line: coordinates.line,
                  diff_size: 1,
                  diff_set_xid: String(activeDiff.id),
                  diff_side: coordinates.side,
                  ...(input.verdict === "request-changes" ? { issue_status: "open" } : {}),
                }),
              });
            },
            { discard: true },
          );
        }
        if (input.body.trim().length > 0) {
          yield* request({
            operation: "submitReview",
            method: "POST",
            path: commentsPath,
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            body: JSON.stringify({
              content: input.body,
              draft: false,
              // With no line comment to carry an open issue, the summary carries it, so the
              // verdict exists on the host at all.
              ...(input.verdict === "request-changes" && input.comments.length === 0
                ? { issue_status: "open" }
                : {}),
            }),
          });
        }
      }),

    replyToThread: (input) =>
      request({
        operation: "replyToThread",
        method: "POST",
        // The thread id is the root comment's id, round-tripped opaquely from the listing.
        path: `/v1/public/review-requests-comments/${encodeURIComponent(input.threadId)}/replies`,
        body: JSON.stringify({ content: input.body, draft: false }),
      }).pipe(Effect.asVoid),

    setThreadResolution: (input) =>
      request({
        operation: "setThreadResolution",
        method: "PATCH",
        path: `/v1/public/review-requests-comments/${encodeURIComponent(input.threadId)}`,
        body: JSON.stringify({ issue_status: input.resolved ? "resolved" : "open" }),
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ArcanumPullRequestApi, make);
