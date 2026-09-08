import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ArcanumCli from "./ArcanumCli.ts";

const CWD = "/w/arcadia";
const PR_URL = "https://a.yandex-team.ru/review/123456";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function prJson(overrides: Record<string, unknown> = {}): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify({
    id: 123456,
    url: PR_URL,
    summary: "paths: tighten the family engines",
    status: "open",
    from_branch: "users/alice/feature-x",
    to_branch: "trunk",
    ...overrides,
  });
}

const exitError = (failureKind: "not-found" | "rate-limited", detail: string) =>
  new VcsProcessExitError({
    operation: "ArcanumCli.execute",
    command: "arc",
    cwd: CWD,
    exitCode: 1,
    failureKind,
    detail,
  });

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

// ArcanumCli only reads the PR body file on create; the tests below never do.
const layer = ArcanumCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
  Layer.provide(FileSystem.layerNoop({})),
);

const argsOf = (call: unknown[]) => (call[0] as { args: ReadonlyArray<string> }).args;
const arcCalls = () => mockRun.mock.calls.map((call) => argsOf(call).join(" "));

/**
 * Routes each arc command to a canned answer, so a test states only what it cares about.
 * The route runs when the command executes, not when its effect is built, the way a real
 * process spawn would — the gate holds a built command back, and the counts must see that.
 */
function answer(
  routes: Record<string, () => Effect.Effect<VcsProcess.VcsProcessOutput, VcsProcessExitError>>,
) {
  mockRun.mockImplementation((input) =>
    Effect.suspend(() => {
      const key = input.args.slice(0, 2).join(" ");
      const route = routes[key] ?? routes[input.args.join(" ")];
      if (route === undefined) {
        return Effect.die(new Error(`unexpected arc command: ${input.args.join(" ")}`));
      }
      return route();
    }),
  );
}

afterEach(() => {
  mockRun.mockReset();
});

/** Lets every runnable fiber reach its next sleep or gate before the clock moves. */
const settle = Effect.forEach(Array.from({ length: 25 }), () => Effect.yieldNow, {
  discard: true,
});

/** Runs the lookups while the test clock steps through the pacing slots between arc calls. */
const paced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let step = 0; step < 60; step += 1) {
      yield* settle;
      yield* TestClock.adjust(`${ArcanumCli.MIN_API_SPACING_MS} millis`);
    }
    yield* settle;
    return yield* Fiber.join(fiber);
  });

describe("ArcanumCli.listPullRequests", () => {
  it.effect("answers from the outgoing sweep without probing the branch", () =>
    Effect.gen(function* () {
      answer({
        "user-info": () => Effect.succeed(output("Login: alice\nEffective login: alice\n")),
        "pr list": () => Effect.succeed(output(`${prJson()}\n`)),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const found = yield* paced(
        arc.listPullRequests({ cwd: CWD, headBranch: "feature-x", state: "all" }),
      );

      expect(found.map((pr) => pr.number)).toEqual([123456]);
      expect(arcCalls().filter((call) => call.startsWith("pr status"))).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shares one sweep and one login across many branches", () =>
    Effect.gen(function* () {
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () =>
          Effect.succeed(
            output(
              `${prJson({ from_branch: "users/alice/one" })}\n${prJson({ id: 7, from_branch: "users/alice/two", status: "merged" })}\n`,
            ),
          ),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const results = yield* paced(
        Effect.forEach(
          ["one", "two", "one"],
          (headBranch) => arc.listPullRequests({ cwd: CWD, headBranch, state: "all" }),
          { concurrency: "unbounded" },
        ),
      );

      expect(results.map((found) => found.map((pr) => [pr.number, pr.state]))).toEqual([
        [[123456, "open"]],
        [[7, "merged"]],
        [[123456, "open"]],
      ]);
      expect(arcCalls().filter((call) => call === "user-info")).toHaveLength(1);
      expect(arcCalls().filter((call) => call.startsWith("pr list"))).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("probes the branch, then its users/ form, when the sweep has nothing", () =>
    Effect.gen(function* () {
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () => Effect.succeed(output("")),
        "pr status": () => Effect.fail(exitError("not-found", "no pull request")),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const found = yield* paced(
        arc.listPullRequests({ cwd: CWD, headBranch: "feature-x", state: "all" }),
      );

      expect(found).toEqual([]);
      expect(arcCalls().filter((call) => call.startsWith("pr status"))).toEqual([
        "pr status feature-x --json",
        "pr status users/alice/feature-x --json",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a colleague's open PR through the probe", () =>
    Effect.gen(function* () {
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () => Effect.succeed(output("")),
        "pr status": () =>
          Effect.succeed(output(prJson({ id: 42, from_branch: "users/bob/shared" }))),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const found = yield* paced(
        arc.listPullRequests({ cwd: CWD, headBranch: "users/bob/shared", state: "open" }),
      );

      expect(found.map((pr) => pr.number)).toEqual([42]);
      expect(arcCalls().filter((call) => call.startsWith("pr status"))).toEqual([
        "pr status users/bob/shared --json",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a throttled sweep as a rate limit instead of probing", () =>
    Effect.gen(function* () {
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () => Effect.fail(exitError("rate-limited", "API rate limit exceeded.")),
        "pr status": () => Effect.succeed(output(prJson())),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const error = yield* paced(
        arc.listPullRequests({ cwd: CWD, headBranch: "feature-x", state: "all" }).pipe(Effect.flip),
      );

      expect(error._tag).toBe("ArcanumCliRateLimitError");
      expect(arcCalls().filter((call) => call.startsWith("pr status"))).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("spaces Arcanum reads apart instead of bursting", () =>
    Effect.gen(function* () {
      const startedAt: number[] = [];
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () => Effect.succeed(output("")),
        "pr status": () =>
          Effect.gen(function* () {
            startedAt.push(yield* Clock.currentTimeMillis);
            return yield* Effect.fail(exitError("not-found", "no pull request"));
          }),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      yield* paced(
        Effect.forEach(
          ["a", "b", "c"],
          (headBranch) => arc.listPullRequests({ cwd: CWD, headBranch, state: "all" }),
          { concurrency: "unbounded" },
        ),
      );

      expect(startedAt).toHaveLength(6);
      for (let index = 1; index < startedAt.length; index += 1) {
        expect(startedAt[index]! - startedAt[index - 1]!).toBeGreaterThanOrEqual(
          ArcanumCli.MIN_API_SPACING_MS,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pauses every reader after a 429 so queued lookups retry once the limit clears", () =>
    Effect.gen(function* () {
      let sweeps = 0;
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () => {
          sweeps += 1;
          return sweeps === 1
            ? Effect.fail(exitError("rate-limited", "API rate limit exceeded."))
            : Effect.succeed(output(`${prJson()}\n`));
        },
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const fiber = yield* Effect.forkChild(
        Effect.forEach(
          ["feature-x", "feature-x"],
          (headBranch) =>
            arc.listPullRequests({ cwd: CWD, headBranch, state: "all" }).pipe(
              Effect.map((found) => found.map((pr) => pr.number)),
              Effect.catchTag("ArcanumCliRateLimitError", () => Effect.succeed("rate-limited")),
            ),
          { concurrency: "unbounded" },
        ),
      );
      // login at once, then the first sweep a spacing later: it fails with a 429
      yield* settle;
      yield* TestClock.adjust(`${ArcanumCli.MIN_API_SPACING_MS} millis`);
      yield* settle;
      expect(sweeps).toBe(1);
      // the second caller waits out the cooldown rather than sweeping at once
      yield* TestClock.adjust(`${ArcanumCli.RATE_LIMIT_COOLDOWN_MS - 1} millis`);
      yield* settle;
      expect(sweeps).toBe(1);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      const results = yield* Fiber.join(fiber);

      expect(sweeps).toBe(2);
      expect(results).toEqual(["rate-limited", [123456]]);
    }).pipe(Effect.provide(layer)),
  );
});
