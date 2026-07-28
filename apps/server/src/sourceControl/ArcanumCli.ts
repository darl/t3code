import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as DateTime from "effect/DateTime";
import type * as Option from "effect/Option";

import type { VcsError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { decodeArcanumPullRequestJson } from "./arcanumPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

// Arcanum's default (and only) target branch namespace root.
const ARCANUM_DEFAULT_BRANCH = "trunk";

// The merged/discarded sweep listing is user-scoped, not branch-scoped, so
// one `arc pr list -o` answer serves every branch the PR poller asks about
// within the TTL. A minute keeps the extra Arcanum API load at ≤1 call/min
// regardless of worktree count while staying well inside the poller's own
// 2-minute lookup cache.
const OUTGOING_PR_SWEEP_TTL_MS = 60_000;
const OUTGOING_PR_SWEEP_LIMIT = 100;

const arcanumCliExecutionErrorContext = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("arc"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

const arcanumCliDecodeErrorContext = {
  command: Schema.Literal("arc"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class ArcanumCliUnavailableError extends Schema.TaggedErrorClass<ArcanumCliUnavailableError>()(
  "ArcanumCliUnavailableError",
  arcanumCliExecutionErrorContext,
) {
  get detail(): string {
    return "Arc CLI (`arc`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumCliAuthenticationError extends Schema.TaggedErrorClass<ArcanumCliAuthenticationError>()(
  "ArcanumCliAuthenticationError",
  arcanumCliExecutionErrorContext,
) {
  get detail(): string {
    return "Arc CLI is not authenticated. Run `arc token` and retry.";
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumPullRequestNotFoundError extends Schema.TaggedErrorClass<ArcanumPullRequestNotFoundError>()(
  "ArcanumPullRequestNotFoundError",
  {
    ...arcanumCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Pull request ${this.reference} was not found. Check the PR number or branch and try again.`;
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "arc";
      readonly cwd: string;
      readonly reference: string;
    },
    error: VcsError,
  ): ArcanumCliError {
    if (error._tag === "VcsProcessExitError" && error.failureKind === "not-found") {
      return new ArcanumPullRequestNotFoundError({ ...context, cause: error });
    }

    return ArcanumCliCommandError.fromVcsError(
      {
        operation: context.operation,
        command: context.command,
        cwd: context.cwd,
      },
      error,
    );
  }
}

export class ArcanumCliCommandError extends Schema.TaggedErrorClass<ArcanumCliCommandError>()(
  "ArcanumCliCommandError",
  arcanumCliExecutionErrorContext,
) {
  get detail(): string {
    return "Arc CLI command failed.";
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "arc";
      readonly cwd: string;
    },
    error: VcsError,
  ): ArcanumCliError {
    return Match.valueTags(error, {
      VcsProcessSpawnError: (cause) => new ArcanumCliUnavailableError({ ...context, cause }),
      VcsProcessExitError: (cause) => {
        switch (cause.failureKind) {
          case "authentication":
            return new ArcanumCliAuthenticationError({ ...context, cause });
          case "not-found":
          case "command-failed":
          case undefined:
            return new ArcanumCliCommandError({ ...context, cause });
        }
      },
      VcsProcessTimeoutError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
      VcsProcessStdinWriteError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
      VcsProcessOutputReadError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
      VcsProcessOutputLimitError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
      VcsProcessMissingExitCodeError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
      VcsRepositoryDetectionError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
      VcsUnsupportedOperationError: (cause) => new ArcanumCliCommandError({ ...context, cause }),
    });
  }
}

export class ArcanumPullRequestDecodeError extends Schema.TaggedErrorClass<ArcanumPullRequestDecodeError>()(
  "ArcanumPullRequestDecodeError",
  {
    ...arcanumCliDecodeErrorContext,
    operation: Schema.Literals(["listPullRequests", "getPullRequest"]),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "Arc CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumBodyFileReadError extends Schema.TaggedErrorClass<ArcanumBodyFileReadError>()(
  "ArcanumBodyFileReadError",
  {
    ...arcanumCliDecodeErrorContext,
    operation: Schema.Literal("createPullRequest"),
    bodyFile: Schema.String,
  },
) {
  get detail(): string {
    return "Failed to read the pull request body file.";
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const ArcanumCliError = Schema.Union([
  ArcanumCliUnavailableError,
  ArcanumCliAuthenticationError,
  ArcanumPullRequestNotFoundError,
  ArcanumCliCommandError,
  ArcanumPullRequestDecodeError,
  ArcanumBodyFileReadError,
]);
export type ArcanumCliError = typeof ArcanumCliError.Type;
export const isArcanumCliError = Schema.is(ArcanumCliError);

export interface ArcanumPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
}

export class ArcanumCli extends Context.Service<
  ArcanumCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, ArcanumCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headBranch: string;
      readonly state: "open" | "closed" | "merged" | "all";
    }) => Effect.Effect<ReadonlyArray<ArcanumPullRequestSummary>, ArcanumCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<ArcanumPullRequestSummary, ArcanumCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, ArcanumCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, ArcanumCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, ArcanumCliError>;
  }
>()("t3/sourceControl/ArcanumCli") {}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;

  const run = (
    input: Parameters<ArcanumCli["Service"]["execute"]>[0],
    mapError: (error: VcsError) => ArcanumCliError,
  ) =>
    process
      .run({
        operation: "ArcanumCli.execute",
        command: "arc",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError(mapError));

  const execute: ArcanumCli["Service"]["execute"] = (input) =>
    run(input, (error) =>
      ArcanumCliCommandError.fromVcsError(
        { operation: "execute", command: "arc", cwd: input.cwd },
        error,
      ),
    );

  const executePullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    run(input, (error) =>
      ArcanumPullRequestNotFoundError.fromVcsError(
        {
          operation: "execute",
          command: "arc",
          cwd: input.cwd,
          reference: input.reference,
        },
        error,
      ),
    );

  const statusPullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly operation: "listPullRequests" | "getPullRequest";
  }) =>
    executePullRequest({
      cwd: input.cwd,
      reference: input.reference,
      args: ["pr", "status", input.reference, "--json"],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        Effect.sync(() => decodeArcanumPullRequestJson(raw)).pipe(
          Effect.flatMap((decoded) => {
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new ArcanumPullRequestDecodeError({
                  operation: input.operation,
                  command: "arc",
                  cwd: input.cwd,
                  reference: input.reference,
                  cause: decoded.failure,
                }),
              );
            }

            return Effect.succeed(decoded.success);
          }),
        ),
      ),
    );

  const filterByState = (
    summary: ArcanumPullRequestSummary,
    state: "open" | "closed" | "merged" | "all",
  ): ReadonlyArray<ArcanumPullRequestSummary> =>
    state === "all" || summary.state === state ? [summary] : [];

  const arcanumLogin = (cwd: string) =>
    execute({ cwd, args: ["user-info"] }).pipe(
      Effect.map(
        (result) =>
          /Effective login:\s*(\S+)/iu.exec(result.stdout)?.[1] ??
          /Token login:\s*(\S+)/iu.exec(result.stdout)?.[1] ??
          null,
      ),
    );

  const outgoingPrSweepCache = yield* SynchronizedRef.make<{
    readonly expiresAtMillis: number;
    readonly entries: ReadonlyArray<ArcanumPullRequestSummary>;
  } | null>(null);

  // SynchronizedRef serializes the refresh: concurrent cache misses wait for
  // one `arc pr list` call instead of racing their own. A failed refresh
  // leaves the previous entry in place and surfaces the error to that caller
  // only.
  const listOutgoingPullRequests = (cwd: string) =>
    SynchronizedRef.updateAndGetEffect(outgoingPrSweepCache, (cached) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          cached !== null && cached.expiresAtMillis > now
            ? Effect.succeed(cached)
            : execute({
                cwd,
                args: [
                  "pr",
                  "list",
                  "-o",
                  "-S",
                  "all",
                  "--sort",
                  "date",
                  "--desc",
                  "--limit",
                  String(OUTGOING_PR_SWEEP_LIMIT),
                  "--json",
                ],
              }).pipe(
                Effect.map((result) => ({
                  expiresAtMillis: now + OUTGOING_PR_SWEEP_TTL_MS,
                  // jsonl: one PR object per line; undecodable lines are
                  // skipped rather than failing the sweep.
                  entries: result.stdout
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0)
                    .flatMap((line) => {
                      const decoded = decodeArcanumPullRequestJson(line);
                      return Result.isSuccess(decoded) ? [decoded.success] : [];
                    }),
                })),
              ),
        ),
      ),
    ).pipe(Effect.map((cached) => cached?.entries ?? []));

  // `arc pr status <branch>` resolves the branch→PR mapping only while the
  // PR is open — it answers "no pull request" the moment the PR merges or
  // is discarded. Non-open lookups therefore fall back to sweeping the
  // user's own PRs (t3code only polls branches it published as this user)
  // and matching on the source branch. Bounded to the newest
  // OUTGOING_PR_SWEEP_LIMIT PRs — plenty for catching a recent merge, which
  // is all the poller needs.
  const sweepPullRequestsByBranch = (input: {
    readonly cwd: string;
    readonly headBranch: string;
    readonly state: "open" | "closed" | "merged" | "all";
  }) =>
    (input.headBranch.startsWith("users/")
      ? Effect.succeed<ReadonlyArray<string>>([input.headBranch])
      : arcanumLogin(input.cwd).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((login) =>
            login === null
              ? [input.headBranch]
              : [input.headBranch, `users/${login}/${input.headBranch}`],
          ),
        )
    ).pipe(
      Effect.flatMap((candidateBranches) =>
        listOutgoingPullRequests(input.cwd).pipe(
          Effect.map((entries) =>
            entries
              .filter((entry) => candidateBranches.includes(entry.headRefName))
              .flatMap((entry) => filterByState(entry, input.state)),
          ),
        ),
      ),
    );

  return ArcanumCli.of({
    execute,
    // Arcanum has at most one PR per source branch, so "list by head branch"
    // is a single `arc pr status <branch>` probe; a missing PR is an empty
    // list, not an error. Branches are published under users/<login>/, so a
    // miss on the plain local name retries the users/-qualified form. The
    // probe only resolves OPEN PRs, so when non-open states are wanted and
    // the probe found nothing, the cached outgoing-PR sweep gets the last
    // word — that is how a merged/discarded PR keeps reporting its state.
    listPullRequests: (input) =>
      statusPullRequest({
        cwd: input.cwd,
        reference: input.headBranch,
        operation: "listPullRequests",
      }).pipe(
        Effect.map((summary) => filterByState(summary, input.state)),
        Effect.catchTag("ArcanumPullRequestNotFoundError", () =>
          input.headBranch.startsWith("users/")
            ? Effect.succeed<ReadonlyArray<ArcanumPullRequestSummary>>([])
            : arcanumLogin(input.cwd).pipe(
                Effect.flatMap((login) =>
                  login === null
                    ? Effect.succeed<ReadonlyArray<ArcanumPullRequestSummary>>([])
                    : statusPullRequest({
                        cwd: input.cwd,
                        reference: `users/${login}/${input.headBranch}`,
                        operation: "listPullRequests",
                      }).pipe(Effect.map((summary) => filterByState(summary, input.state))),
                ),
                // The primary lookup already answered "no PR"; fallback
                // failures must not turn that into a poll error.
                Effect.orElseSucceed((): ReadonlyArray<ArcanumPullRequestSummary> => []),
              ),
        ),
        Effect.flatMap((found) =>
          found.length > 0 || input.state === "open"
            ? Effect.succeed(found)
            : sweepPullRequestsByBranch(input).pipe(
                // Same contract as above: the probe already gave a valid
                // "no open PR" answer, so a sweep failure falls back to it.
                Effect.orElseSucceed(() => found),
              ),
        ),
      ),
    getPullRequest: (input) =>
      statusPullRequest({
        cwd: input.cwd,
        reference: input.reference,
        operation: "getPullRequest",
      }),
    createPullRequest: (input) =>
      fileSystem.readFileString(input.bodyFile).pipe(
        Effect.mapError(
          (cause) =>
            new ArcanumBodyFileReadError({
              operation: "createPullRequest",
              command: "arc",
              cwd: input.cwd,
              bodyFile: input.bodyFile,
              cause,
            }),
        ),
        Effect.flatMap((body) => {
          // Arcanum takes one message: first line becomes the PR summary,
          // the rest the description. `--push` is arc's default; --no-edit
          // keeps it from opening an editor on the server.
          const trimmedBody = body.trim();
          const message = trimmedBody.length > 0 ? `${input.title}\n\n${trimmedBody}` : input.title;
          return execute({
            cwd: input.cwd,
            args: ["pr", "create", "--no-edit", "-m", message, "--to", input.baseBranch],
          });
        }),
        Effect.asVoid,
      ),
    // Arcadia's default branch is always trunk; arc has no remote query for it.
    getDefaultBranch: () => Effect.succeed(ARCANUM_DEFAULT_BRANCH),
    checkoutPullRequest: (input) =>
      executePullRequest({
        cwd: input.cwd,
        reference: input.reference,
        args: ["pr", "checkout", ...(input.force ? ["--force"] : []), input.reference],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ArcanumCli, make);
