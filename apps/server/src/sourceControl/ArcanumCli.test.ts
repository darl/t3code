import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

/** Routes each arc command to a canned answer, so a test states only what it cares about. */
function answer(
  routes: Record<string, () => Effect.Effect<VcsProcess.VcsProcessOutput, VcsProcessExitError>>,
) {
  mockRun.mockImplementation((input) => {
    const key = input.args.slice(0, 2).join(" ");
    const route = routes[key] ?? routes[input.args.join(" ")];
    if (route === undefined) {
      return Effect.die(new Error(`unexpected arc command: ${input.args.join(" ")}`));
    }
    return route();
  });
}

afterEach(() => {
  mockRun.mockReset();
});

describe("ArcanumCli.listPullRequests", () => {
  it.effect("answers from the outgoing sweep without probing the branch", () =>
    Effect.gen(function* () {
      answer({
        "user-info": () => Effect.succeed(output("Login: alice\nEffective login: alice\n")),
        "pr list": () => Effect.succeed(output(`${prJson()}\n`)),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      const found = yield* arc.listPullRequests({
        cwd: CWD,
        headBranch: "feature-x",
        state: "all",
      });

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
      const results = yield* Effect.forEach(
        ["one", "two", "one"],
        (headBranch) => arc.listPullRequests({ cwd: CWD, headBranch, state: "all" }),
        { concurrency: "unbounded" },
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
      const found = yield* arc.listPullRequests({
        cwd: CWD,
        headBranch: "feature-x",
        state: "all",
      });

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
      const found = yield* arc.listPullRequests({
        cwd: CWD,
        headBranch: "users/bob/shared",
        state: "open",
      });

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
      const error = yield* arc
        .listPullRequests({ cwd: CWD, headBranch: "feature-x", state: "all" })
        .pipe(Effect.flip);

      expect(error._tag).toBe("ArcanumCliRateLimitError");
      expect(arcCalls().filter((call) => call.startsWith("pr status"))).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs Arcanum reads one at a time", () =>
    Effect.gen(function* () {
      let inFlight = 0;
      let peak = 0;
      answer({
        "user-info": () => Effect.succeed(output("Effective login: alice\n")),
        "pr list": () => Effect.succeed(output("")),
        "pr status": () =>
          Effect.gen(function* () {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            yield* Effect.yieldNow;
            inFlight -= 1;
            return yield* Effect.fail(exitError("not-found", "no pull request"));
          }),
      });

      const arc = yield* ArcanumCli.ArcanumCli;
      yield* Effect.forEach(
        ["a", "b", "c", "d"],
        (headBranch) => arc.listPullRequests({ cwd: CWD, headBranch, state: "all" }),
        { concurrency: "unbounded" },
      );

      expect(peak).toBe(1);
    }).pipe(Effect.provide(layer)),
  );
});
