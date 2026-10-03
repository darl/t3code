import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("project:schedule");
const threadId = ThreadId.make("thread:schedule");
const timestamp = IsoDateTime.make("2026-10-03T09:00:00.000Z");
const modelSelection = { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:schedule"),
  threadId,
  providerSessionId: "session:schedule",
  providerInstanceId: modelSelection.providerInstanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function makeHarness(defaultBranch: string | null) {
  let stored: ScheduledTask | undefined;
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            id: threadId,
            projectId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        } as unknown as OrchestrationV2ThreadProjection),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Project",
            workspaceRoot: "/repo/apps/service",
            defaultModelSelection: null,
            scripts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolveDefaultBranchName: (cwd, remote) =>
        Effect.sync(() => {
          assert.equal(cwd, "/repo/apps/service");
          assert.equal(remote, "origin");
          return defaultBranch;
        }),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.sync(() => ({ tasks: stored ? [stored] : [] })),
      upsert: (input) =>
        Effect.sync(() => {
          stored = {
            ...input,
            id: input.id ?? ScheduledTaskId.make("schedule:task"),
            threadId: input.threadId ?? null,
            createdBy: input.createdBy ?? "agent",
            creationSource: input.creationSource ?? "mcp",
            createdAt: timestamp,
            updatedAt: timestamp,
            nextRunAt: null,
            lastRunAt: null,
            lastRunStatus: "never",
            lastRunError: null,
            runCount: 0,
          };
          return { task: stored };
        }),
    }),
  );
  return {
    layer: OrchestratorMcpService.layer.pipe(Layer.provide(dependencies)),
    task: () => stored,
  };
}

it.effect.each(["main", "master", "trunk"])(
  "uses %s for unbound schedules and rebinding",
  (baseRef) =>
    Effect.gen(function* () {
      const harness = makeHarness(baseRef);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const created = yield* service.scheduleTask(scope, {
          prompt: "Review changes",
          schedule: { type: "interval", everyMs: 60_000 },
          bindToCurrentThread: false,
        });
        assert.deepEqual(harness.task()?.workspaceStrategy, {
          type: "worktree",
          baseRef,
          startFromOrigin: true,
        });
        assert.isNull(created.boundThreadId);
        yield* service.updateScheduledTask(scope, {
          scheduledTaskId: created.scheduledTaskId,
          bindToCurrentThread: true,
        });
        assert.deepEqual(harness.task()?.workspaceStrategy, { type: "root" });
        yield* service.updateScheduledTask(scope, {
          scheduledTaskId: created.scheduledTaskId,
          bindToCurrentThread: false,
        });
        assert.deepEqual(harness.task()?.workspaceStrategy, {
          type: "worktree",
          baseRef,
          startFromOrigin: true,
        });
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps bound schedules usable without a default branch and rejects unbinding", () =>
  Effect.gen(function* () {
    const harness = makeHarness(null);
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const input = {
        prompt: "Review changes",
        schedule: { type: "interval", everyMs: 60_000 },
      } as const;
      const created = yield* service.scheduleTask(scope, input);
      assert.equal(created.boundThreadId, threadId);
      const failure = yield* service
        .scheduleTask(scope, { ...input, bindToCurrentThread: false })
        .pipe(Effect.flip);
      assert.equal(failure.code, "invalid_request");
      assert.include(failure.message, "default branch");
      const rebindFailure = yield* service
        .updateScheduledTask(scope, {
          scheduledTaskId: created.scheduledTaskId,
          bindToCurrentThread: false,
        })
        .pipe(Effect.flip);
      assert.equal(rebindFailure.code, "invalid_request");
      assert.equal(harness.task()?.threadId, threadId);
    }).pipe(Effect.provide(harness.layer));
  }),
);
