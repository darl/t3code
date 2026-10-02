import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as ArcanumCli from "./ArcanumCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

const ARCANUM_HOST = "a.yandex-team.ru";

function toChangeRequest(summary: ArcanumCli.ArcanumPullRequestSummary): ChangeRequest {
  return {
    provider: "arcanum",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
  };
}

// The probe is `arc token show`: unlike `arc user-info` it works OUTSIDE a
// mounted working copy (the discovery probe runs in the server cwd, which
// is almost never an arc tree). Its stdout IS the secret, so this parser
// must never copy any output into the auth fields — only presence/absence
// of a token is reported, static strings otherwise.
function parseArcanumAuth(input: SourceControlAuthProbeInput) {
  if (input.exitCode === 0 && input.stdout.trim().length > 0) {
    return providerAuth({ status: "authenticated", host: ARCANUM_HOST });
  }

  return providerAuth({
    status: "unauthenticated",
    host: ARCANUM_HOST,
    detail: "Run `arc token store` on the server host to authenticate the arc CLI.",
  });
}

export const discovery = {
  type: "cli",
  kind: "arcanum",
  label: "Arcanum",
  executable: "arc",
  versionArgs: ["--version"],
  authArgs: ["token", "show"],
  parseAuth: parseArcanumAuth,
  installHint:
    "Install the arc command-line tool and run `arc token store` to authenticate with Arcanum.",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const arcanum = yield* ArcanumCli.ArcanumCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "arcanum",
    listChangeRequests: (input) =>
      arcanum
        .listPullRequests({
          cwd: input.cwd,
          headBranch: SourceControlProvider.sourceBranch(input),
          state: input.state,
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "arcanum",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    getChangeRequest: (input) =>
      arcanum.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "arcanum",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) =>
      arcanum
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.target?.refName ?? input.baseRefName,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "arcanum",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    // Arcadia is a single monorepo: repositories are never cloned or created
    // through the hosting provider, so both repository operations are
    // permanent, clean unsupported errors.
    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: "arcanum",
        operation: "getRepositoryCloneUrls",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: "Arcanum does not support repository lookup; Arcadia is mounted via arc.",
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: "arcanum",
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: "Arcanum does not support repository creation; Arcadia is mounted via arc.",
      }),
    getDefaultBranch: (input) =>
      arcanum.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "arcanum",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      arcanum.checkoutPullRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "arcanum",
              operation: "checkoutChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
