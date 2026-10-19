// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

function processOutput(stdout: string, code: number): ProcessRunner.ProcessRunOutput {
  return {
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

/** A working copy git knows nothing about, inside which `arc root` names the mount. */
const arcMountProcessRunnerLayer = Layer.mock(ProcessRunner.ProcessRunner)({
  run: (input) =>
    input.command === "git"
      ? Effect.succeed(processOutput("", 128))
      : input.command === "arc" && input.args?.[0] === "root"
        ? Effect.succeed(processOutput("/w/arcadia\n", 0))
        : Effect.succeed(processOutput("", 1)),
});

/**
 * A mount where a git shim (arc-git installed as `git`) answers the git probes itself, so the
 * `arc root` road is never taken and the arc remote arrives through `git remote -v`.
 */
const arcGitShimProcessRunnerLayer = Layer.mock(ProcessRunner.ProcessRunner)({
  run: (input) =>
    input.command === "git" && input.args?.includes("rev-parse")
      ? Effect.succeed(processOutput("/w/arcadia\n", 0))
      : input.command === "git" && input.args?.includes("remote")
        ? Effect.succeed(
            processOutput(
              "arcadia\tarc://arcadia/arcadia (fetch)\narcadia\tarc://arcadia/arcadia (push)\n",
              0,
            ),
          )
        : Effect.succeed(processOutput("", 1)),
});

/** The one identity every Arcadia checkout resolves to, whichever probe discovered it. */
const ARCADIA_IDENTITY = {
  canonicalKey: "arcadia/arcadia",
  locator: {
    source: "git-remote",
    remoteName: "arcadia",
    remoteUrl: "arc://arcadia/arcadia",
  },
  rootPath: "/w/arcadia",
  displayName: "arcadia",
  provider: "arcanum",
  owner: "arcadia",
  name: "arcadia",
};

it.effect("synthesizes the Arcadia identity where git answers nothing but arc names a root", () =>
  Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

    const identity = yield* resolver.resolve("/w/arcadia/project/lib");

    // One monorepo per mount: the canonical key's first segment is the host the
    // pull-requests page buckets by, and it is the host the shared remote detection reads
    // arc://arcadia/arcadia as — kind "arcanum".
    expect(identity).toEqual(ARCADIA_IDENTITY);
  }).pipe(
    Effect.provide(
      Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make({ cacheCapacity: 16 }),
      ).pipe(Layer.provide(arcMountProcessRunnerLayer)),
    ),
  ),
);

it.effect("resolves the same constant when a git shim reports the arc remote itself", () =>
  Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

    const identity = yield* resolver.resolve("/w/arcadia/project/lib");

    // normalizeGitRemoteUrl cannot read the arc:// scheme, so the shim's remote must not go
    // through it — both discovery roads converge on the identical constant, and the host
    // bucket stays "arcadia" rather than "arc:".
    expect(identity).toEqual(ARCADIA_IDENTITY);
  }).pipe(
    Effect.provide(
      Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make({ cacheCapacity: 16 }),
      ).pipe(Layer.provide(arcGitShimProcessRunnerLayer)),
    ),
  ),
);

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath matches git's long paths when Windows temp dirs use 8.3 names.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
      expect(yield* resolver.resolve(path.join(cwd, ".git"))).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-partial-clone-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", "git@github.com:T3Tools/push.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const remotes = yield* git(cwd, ["remote", "-v"]);
      expect(remotes.stdout).toContain("(fetch) [blob:none]");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@github.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["bare clone", "dot-bare"] as const)(
    "resolves a %s to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-checkout-",
        });
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-bare-",
        });
        const bareGitDir = layout === "dot-bare" ? path.join(root, ".bare") : root;

        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* git(root, ["init", "--bare", bareGitDir]);
        if (layout === "dot-bare") {
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
        }
        yield* git(root, [
          "--git-dir",
          bareGitDir,
          "remote",
          "add",
          "origin",
          "https://github.com/T3Tools/t3code.git",
        ]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const checkoutIdentity = yield* resolver.resolve(checkout);
        expect(checkoutIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        const resolvedBareGitDir = NodeFS.realpathSync.native(bareGitDir);
        const projectRoots = layout === "dot-bare" ? [root, bareGitDir] : [root];

        for (const projectRoot of projectRoots) {
          const identity = yield* resolver.resolve(projectRoot);
          const resolvedIdentityRoot =
            identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);

          expect(identity).not.toBeNull();
          expect(identity?.canonicalKey).toBe(checkoutIdentity?.canonicalKey);
          expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
            normalizeResolvedPath(resolvedBareGitDir),
          );
        }

        yield* git(root, ["--git-dir", bareGitDir, "remote", "remove", "origin"]);
        for (const projectRoot of projectRoots) {
          expect(yield* resolver.resolve(projectRoot, { refresh: true })).toBeNull();
        }
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        remoteUrl: "git@github.com:julius/t3code-fork.git",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
