import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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
// The login never changes for the life of the server process; an hour keeps
// a token rotation from going unnoticed for long.
const LOGIN_TTL_MS = 60 * 60_000;
// Arcanum answers 429 to a second request inside roughly a second, and a
// burst keeps the limit tripped: of six parallel `arc pr status` calls one
// gets through. Reads are therefore spaced MIN_API_SPACING_MS apart, and a
// 429 pauses every reader for RATE_LIMIT_COOLDOWN_MS so the callers already
// queued retry after the limit clears instead of each burning a request
// against it.
export const MIN_API_SPACING_MS = 1_500;
export const RATE_LIMIT_COOLDOWN_MS = 10_000;

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

export class ArcanumCliUnavailableError extends Schema.TaggedError<ArcanumCliUnavailableError>()(
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

export class ArcanumCliAuthenticationError extends Schema.TaggedError<ArcanumCliAuthenticationError>()(
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

export class ArcanumCliRateLimitError extends Schema.TaggedError<ArcanumCliRateLimitError>()(
  "ArcanumCliRateLimitError",
  arcanumCliExecutionErrorContext,
) {
  get detail(): string {
    return "Arcanum API rate limit exceeded. Retry in a moment.";
  }

  override get message(): string {
    return `Arc CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ArcanumPullRequestNotFoundError extends Schema.TaggedError<ArcanumPullRequestNotFoundError>()(
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

export class ArcanumCliCommandError extends Schema.TaggedError<ArcanumCliCommandError>()(
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
          case "rate-limited":
            return new ArcanumCliRateLimitError({ ...context, cause });
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

export class ArcanumPullRequestDecodeError extends Schema.TaggedError<ArcanumPullRequestDecodeError>()(
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

export class ArcanumBodyFileReadError extends Schema.TaggedError<ArcanumBodyFileReadError>()(
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
  ArcanumCliRateLimitError,
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
      /** For output that can be legitimately large — a whole diff — rather than a status. */
      readonly maxOutputBytes?: number;
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
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
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

  // Every PR read below passes through this gate one at a time and no
  // sooner than the slot allows, so a server start that looks up dozens of
  // worktree branches at once queues its calls instead of bursting into
  // rate-limit failures that each back off for minutes.
  const apiGate = yield* Semaphore.make(1);
  const nextApiSlotMillis = yield* Ref.make(0);
  const holdApiSlot = (millis: number) =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(nextApiSlotMillis, now + millis)));
  const gated = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    apiGate.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const slot = yield* Ref.get(nextApiSlotMillis);
        if (slot > now) yield* Effect.sleep(Duration.millis(slot - now));
        return yield* effect.pipe(
          Effect.tap(() => holdApiSlot(MIN_API_SPACING_MS)),
          Effect.tapError((error) =>
            holdApiSlot(
              error._tag === "ArcanumCliRateLimitError"
                ? RATE_LIMIT_COOLDOWN_MS
                : MIN_API_SPACING_MS,
            ),
          ),
        );
      }),
    );

  const statusPullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly operation: "listPullRequests" | "getPullRequest";
  }) =>
    gated(
      executePullRequest({
        cwd: input.cwd,
        reference: input.reference,
        args: ["pr", "status", input.reference, "--json"],
      }),
    ).pipe(
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

  const loginCache = yield* SynchronizedRef.make<{
    readonly expiresAtMillis: number;
    readonly login: string | null;
  } | null>(null);

  // `arc user-info` asks the API too, so it is resolved once and shared by
  // every branch lookup rather than paid on each of them.
  const arcanumLogin = (cwd: string) =>
    SynchronizedRef.updateAndGetEffect(loginCache, (cached) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          cached !== null && cached.expiresAtMillis > now
            ? Effect.succeed(cached)
            : gated(execute({ cwd, args: ["user-info"] })).pipe(
                Effect.map((result) => ({
                  expiresAtMillis: now + LOGIN_TTL_MS,
                  login:
                    /Effective login:\s*(\S+)/iu.exec(result.stdout)?.[1] ??
                    /Token login:\s*(\S+)/iu.exec(result.stdout)?.[1] ??
                    null,
                })),
              ),
        ),
      ),
    ).pipe(Effect.map((cached) => cached?.login ?? null));

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
            : gated(
                execute({
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
                }),
              ).pipe(
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

  // Branches are published under users/<login>/, so a plain local name is
  // also tried in its users/-qualified form.
  const candidateBranches = (cwd: string, headBranch: string) =>
    headBranch.startsWith("users/")
      ? Effect.succeed<ReadonlyArray<string>>([headBranch])
      : arcanumLogin(cwd).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((login) =>
            login === null ? [headBranch] : [headBranch, `users/${login}/${headBranch}`],
          ),
        );

  // Which of the user's recent outgoing PRs sit on one of these branches.
  // One cached `arc pr list -o` answers every branch the poller asks about
  // within the TTL, so a server start with dozens of worktrees costs one API
  // call instead of two per worktree. This is also the only place a merged
  // or discarded PR keeps reporting its state: `arc pr status` resolves the
  // branch→PR mapping only while the PR is open.
  const sweepPullRequestsByBranch = (cwd: string, candidates: ReadonlyArray<string>) =>
    listOutgoingPullRequests(cwd).pipe(
      Effect.map((entries) => entries.filter((entry) => candidates.includes(entry.headRefName))),
    );

  // `arc pr status <branch>`: the direct probe. It finds PRs the sweep cannot
  // see — authored by someone else (arc pr checkout) or older than the sweep
  // window — but only while they are open; a miss is an empty list.
  const probePullRequestByBranch = (cwd: string, reference: string) =>
    statusPullRequest({ cwd, reference, operation: "listPullRequests" }).pipe(
      Effect.map((summary): ReadonlyArray<ArcanumPullRequestSummary> => [summary]),
      Effect.catchTag("ArcanumPullRequestNotFoundError", () =>
        Effect.succeed<ReadonlyArray<ArcanumPullRequestSummary>>([]),
      ),
    );

  return ArcanumCli.of({
    execute,
    // Arcanum has at most one PR per source branch. The cached sweep is
    // consulted first and the per-branch probe only when the sweep has
    // nothing for the branch, which keeps the steady-state Arcanum load at
    // about one call a minute regardless of how many worktrees are polled.
    listPullRequests: (input) =>
      Effect.gen(function* () {
        const candidates = yield* candidateBranches(input.cwd, input.headBranch);
        const swept = yield* sweepPullRequestsByBranch(input.cwd, candidates).pipe(
          // A throttled sweep must not fan out into per-branch probes that
          // would only deepen the throttle; any other sweep failure leaves
          // the probe to answer.
          Effect.catchIf(
            (error) => error._tag !== "ArcanumCliRateLimitError",
            () => Effect.succeed<ReadonlyArray<ArcanumPullRequestSummary>>([]),
          ),
        );
        if (swept.length > 0) {
          return swept.flatMap((entry) => filterByState(entry, input.state));
        }
        const [primary, ...fallbacks] = candidates;
        if (primary === undefined) return [];
        const found = yield* probePullRequestByBranch(input.cwd, primary);
        if (found.length > 0) {
          return found.flatMap((entry) => filterByState(entry, input.state));
        }
        for (const reference of fallbacks) {
          // The primary probe already answered "no PR"; a fallback failure
          // must not turn that into a poll error.
          const fallback = yield* probePullRequestByBranch(input.cwd, reference).pipe(
            Effect.orElseSucceed((): ReadonlyArray<ArcanumPullRequestSummary> => []),
          );
          if (fallback.length > 0) {
            return fallback.flatMap((entry) => filterByState(entry, input.state));
          }
        }
        return [];
      }),
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
