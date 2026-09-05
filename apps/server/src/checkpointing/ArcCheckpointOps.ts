/**
 * ArcCheckpointOps - Checkpoints for arc (Arcadia) mounts, backed by a shadow git repository.
 *
 * An arc mount has no git object database, so the upstream capture (read-tree, add -A,
 * write-tree, commit-tree in a temporary index) cannot run there. Instead every mount root
 * gets one private bare git repository under the server's state directory, and each
 * snapshot is a tree of the thread's touched files only, written into that shadow repo with
 * GIT_WORK_TREE pointing at the mount.
 *
 * Two rules keep this safe on a deployment where `git` on PATH is the arc-git shim:
 * - Every git command runs with cwd = the shadow repository directory, never a path inside
 *   the mount. Outside an arc tree the shim passes straight through to real git.
 * - The mount is never scanned through git. The changed set comes from `arc status --json`,
 *   and only paths in the thread's touched set are ever added.
 *
 * A tracked file touched for the first time in a turn was pristine in every earlier snapshot
 * of the thread, but none of them held it. Its pristine bytes are fetched once from arc and
 * seeded into those earlier snapshots, so the turn's diff is a hunk (or a deletion) rather
 * than a whole-file add — or, for a deletion, nothing at all.
 *
 * @module ArcCheckpointOps
 */
import * as NodeCrypto from "node:crypto";

import { VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

/** The marker every arc mount root carries; the same one the arc-git shim keys on. */
const ARC_MARKER_PATH = [".arc", "HEAD"] as const;
const ARC_STATUS_TIMEOUT_MS = 60_000;
const ARC_STATUS_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The well-known id of git's empty tree, the "nothing touched yet" snapshot. */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** One entry of `arc status`: where it is, and whether arc HEAD holds a version of it. */
export interface ArcChangedEntry {
  readonly path: string;
  /** False for an untracked or newly added file, which has no pristine copy to seed. */
  readonly tracked: boolean;
}

/**
 * What the arc side of a checkpoint needs to know about the mount. A service so tests can
 * answer arc without running it, while real git backs the shadow repository.
 */
export class ArcCheckpointProbe extends Context.Service<
  ArcCheckpointProbe,
  {
    /** Every changed, staged or untracked file in the mount, root-relative. */
    readonly readChangedEntries: (
      mountRoot: string,
    ) => Effect.Effect<ReadonlyArray<ArcChangedEntry>, VcsError>;
    /** The arc commit the mount is at, or null when arc cannot say. */
    readonly readHead: (mountRoot: string) => Effect.Effect<string | null>;
    /** A file's bytes at an arc commit, or null when that commit has no such file. */
    readonly readFileAtHead: (input: {
      readonly mountRoot: string;
      readonly head: string;
      readonly path: string;
    }) => Effect.Effect<Uint8Array | null>;
  }
>()("t3/checkpointing/ArcCheckpointOps/ArcCheckpointProbe") {}

/** Statuses arc gives a file that arc HEAD does not hold. */
const UNTRACKED_STATUSES = new Set(["untracked", "new file"]);

/**
 * The `arc status --json` shape: `{"status": {"changed"|"staged"|"untracked": [{status, type,
 * path}]}}`, paths relative to the mount root. arc never reports renames, so a moved file
 * arrives as one deleted and one new entry already. Only files are returned; a directory
 * entry (arc lists untracked directories) is not something a tree can hold. A path is tracked
 * only when no section calls it new or untracked.
 */
export function parseArcStatusEntries(stdoutJson: string): ReadonlyArray<ArcChangedEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutJson);
  } catch {
    return [];
  }
  const status = (parsed as { status?: Record<string, unknown> } | null)?.status;
  if (!status || typeof status !== "object") return [];
  const trackedByPath = new Map<string, boolean>();
  for (const section of Object.values(status)) {
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      const entry = item as { path?: unknown; type?: unknown; status?: unknown } | null;
      if (typeof entry?.path !== "string" || entry.path.length === 0) continue;
      if (entry.type === "directory") continue;
      const tracked =
        typeof entry.status === "string" ? !UNTRACKED_STATUSES.has(entry.status) : true;
      trackedByPath.set(entry.path, (trackedByPath.get(entry.path) ?? true) && tracked);
    }
  }
  return [...trackedByPath.entries()]
    .map(([path, tracked]) => ({ path, tracked }))
    .toSorted((left, right) => (left.path < right.path ? -1 : 1));
}

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const probeLayer = Layer.effect(
  ArcCheckpointProbe,
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ArcCheckpointProbe.of({
      readChangedEntries: (mountRoot) =>
        vcsProcess
          .run({
            operation: "ArcCheckpointOps.arcStatus",
            command: "arc",
            args: ["status", "--json", "-u", "all"],
            cwd: mountRoot,
            timeoutMs: ARC_STATUS_TIMEOUT_MS,
            maxOutputBytes: ARC_STATUS_MAX_OUTPUT_BYTES,
          })
          .pipe(Effect.map((output) => parseArcStatusEntries(output.stdout))),
      readHead: (mountRoot) =>
        vcsProcess
          .run({
            operation: "ArcCheckpointOps.arcHead",
            command: "arc",
            args: ["info", "--json"],
            cwd: mountRoot,
            timeoutMs: 10_000,
          })
          .pipe(
            Effect.map((output) => {
              try {
                const hash = (JSON.parse(output.stdout) as { hash?: unknown } | null)?.hash;
                return typeof hash === "string" && hash.length > 0 ? hash : null;
              } catch {
                return null;
              }
            }),
            Effect.orElseSucceed(() => null),
          ),
      // Straight through the spawner rather than the text-decoding process runner: the
      // bytes go into git as they are, which is what keeps a binary file intact.
      readFileAtHead: (input) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make("arc", ["show", `${input.head}:${input.path}`], {
              cwd: input.mountRoot,
            }),
          );
          const chunks = yield* Stream.runCollect(child.stdout);
          const exitCode = yield* child.exitCode;
          return exitCode === 0 ? concatBytes(chunks) : null;
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);

interface ThreadSnapshot {
  readonly ref: string;
  readonly turn: number;
  readonly commit: string;
}

/** `refs/t3/checkpoints/<thread>/turn/<n>` → the part every turn of that thread shares. */
function threadRefPrefix(checkpointRef: string): string {
  const marker = "/turn/";
  const index = checkpointRef.lastIndexOf(marker);
  if (index === -1) {
    const slash = checkpointRef.lastIndexOf("/");
    return slash === -1 ? checkpointRef : checkpointRef.slice(0, slash + 1);
  }
  return checkpointRef.slice(0, index + marker.length);
}

function turnOf(ref: string, prefix: string): number {
  const parsed = Number.parseInt(ref.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function splitNul(stdout: string): ReadonlyArray<string> {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

export interface ArcCheckpointOpsInput {
  /** Where the per-mount shadow repositories live, e.g. `<stateDir>/checkpoints/arc`. */
  readonly shadowRootDir: string;
}

export const make = Effect.fn("ArcCheckpointOps.make")(function* (input: ArcCheckpointOpsInput) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const probe = yield* ArcCheckpointProbe;

  const mountRootCache = new Map<string, string | null>();

  /** Walk up from cwd to the arc mount root, or null outside any mount. */
  const detectMountRoot = Effect.fn("ArcCheckpointOps.detectMountRoot")(function* (cwd: string) {
    const cached = mountRootCache.get(cwd);
    if (cached !== undefined) return cached;
    let directory = cwd;
    let root: string | null = null;
    for (;;) {
      const marked = yield* fileSystem
        .exists(path.join(directory, ...ARC_MARKER_PATH))
        .pipe(Effect.orElseSucceed(() => false));
      if (marked) {
        root = directory;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    mountRootCache.set(cwd, root);
    return root;
  });

  const requireMountRoot = (operation: string, cwd: string) =>
    detectMountRoot(cwd).pipe(
      Effect.flatMap((root) =>
        root === null
          ? new VcsProcessExitError({
              operation,
              command: "arc",
              cwd,
              exitCode: 1,
              detail: "Not inside an arc mount.",
            })
          : Effect.succeed(root),
      ),
    );

  const shadowDirFor = (mountRoot: string) =>
    path.join(
      input.shadowRootDir,
      NodeCrypto.createHash("sha256").update(mountRoot).digest("hex").slice(0, 16),
    );

  /** One git command against the shadow repository. cwd is the shadow dir, never the mount. */
  const shadowGit = (
    operation: string,
    shadowDir: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly stdin?: string;
      readonly allowNonZeroExit?: boolean;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    } = {},
  ) =>
    vcsProcess.run({
      operation,
      command: "git",
      cwd: shadowDir,
      args,
      env: { GIT_DIR: shadowDir, ...options.env },
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      timeoutMs: 60_000,
    });

  /** The shadow repository for a mount, created bare on first use. */
  const ensureShadow = Effect.fn("ArcCheckpointOps.ensureShadow")(function* (mountRoot: string) {
    const shadowDir = shadowDirFor(mountRoot);
    const initialized = yield* fileSystem
      .exists(path.join(shadowDir, "HEAD"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!initialized) {
      yield* fileSystem.makeDirectory(shadowDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation: "ArcCheckpointOps.ensureShadow",
              command: "git init",
              cwd: shadowDir,
              exitCode: 1,
              detail: `Could not create the shadow repository directory: ${cause.message}`,
            }),
        ),
      );
      yield* vcsProcess.run({
        operation: "ArcCheckpointOps.ensureShadow",
        command: "git",
        cwd: input.shadowRootDir,
        args: ["init", "--quiet", "--bare", shadowDir],
        timeoutMs: 30_000,
      });
    }
    return shadowDir;
  });

  const commitEnv = (): NodeJS.ProcessEnv => ({
    GIT_AUTHOR_NAME: "T3 Code",
    GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
    GIT_COMMITTER_NAME: "T3 Code",
    GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
  });

  const resolveObject = (shadowDir: string, revision: string) =>
    shadowGit(
      "ArcCheckpointOps.resolveObject",
      shadowDir,
      ["rev-parse", "--verify", "--quiet", revision],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) return null;
        const oid = result.stdout.trim();
        return oid.length > 0 ? oid : null;
      }),
    );

  const resolveCommit = (shadowDir: string, ref: string) =>
    resolveObject(shadowDir, `${ref}^{commit}`);

  /** Every earlier snapshot of the thread a ref belongs to, oldest turn first. */
  const listThreadSnapshots = Effect.fn("ArcCheckpointOps.listThreadSnapshots")(function* (
    shadowDir: string,
    checkpointRef: string,
  ) {
    const prefix = threadRefPrefix(checkpointRef);
    const result = yield* shadowGit("ArcCheckpointOps.listThreadSnapshots", shadowDir, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      prefix,
    ]);
    const snapshots: ThreadSnapshot[] = [];
    for (const line of result.stdout.split("\n")) {
      const [ref, commit] = line.split("\0");
      if (!ref || !commit) continue;
      snapshots.push({ ref, turn: turnOf(ref, prefix), commit });
    }
    return snapshots.toSorted((left, right) => left.turn - right.turn);
  });

  const treePaths = (shadowDir: string, treeish: string) =>
    shadowGit("ArcCheckpointOps.treePaths", shadowDir, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      treeish,
    ]).pipe(Effect.map((result) => splitNul(result.stdout)));

  /** Every path any of the given snapshots holds. */
  const snapshotPaths = Effect.fn("ArcCheckpointOps.snapshotPaths")(function* (
    shadowDir: string,
    snapshots: ReadonlyArray<ThreadSnapshot>,
  ) {
    const paths = new Set<string>();
    for (const snapshot of snapshots) {
      for (const treePath of yield* treePaths(shadowDir, snapshot.commit)) {
        paths.add(treePath);
      }
    }
    return paths;
  });

  const isFileOnDisk = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const withTempFile = <A, E>(
    shadowDir: string,
    prefix: string,
    use: (tempPath: string) => Effect.Effect<A, E>,
  ) => {
    const tempPath = path.join(shadowDir, `${prefix}-${NodeCrypto.randomUUID()}`);
    return use(tempPath).pipe(
      Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
  };

  const withTempIndex = <A, E>(
    shadowDir: string,
    use: (tempIndexPath: string) => Effect.Effect<A, E>,
  ) => withTempFile(shadowDir, "t3-checkpoint-index", use);

  /**
   * A tree of the touched paths as they are on disk right now. A touched path missing from
   * disk is left out, which the diff reads as a deletion. Only the named paths are ever
   * added, forced past ignore rules, and read through GIT_WORK_TREE — nothing scans the mount.
   */
  const snapshotTree = Effect.fn("ArcCheckpointOps.snapshotTree")(function* (
    operation: string,
    shadowDir: string,
    mountRoot: string,
    touched: ReadonlyArray<string>,
  ) {
    const present: string[] = [];
    for (const touchedPath of touched) {
      if (yield* isFileOnDisk(path.join(mountRoot, touchedPath))) {
        present.push(touchedPath);
      }
    }
    if (present.length === 0) {
      return EMPTY_TREE_OID;
    }
    return yield* withTempIndex(shadowDir, (tempIndexPath) =>
      Effect.gen(function* () {
        const indexEnv = { GIT_INDEX_FILE: tempIndexPath, GIT_WORK_TREE: mountRoot };
        yield* shadowGit(
          operation,
          shadowDir,
          ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { env: indexEnv, stdin: `${present.join("\0")}\0` },
        );
        const writeTree = yield* shadowGit(operation, shadowDir, ["write-tree"], {
          env: { GIT_INDEX_FILE: tempIndexPath },
        });
        const treeOid = writeTree.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: shadowDir,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }
        return treeOid;
      }),
    );
  });

  const commitMessageOf = (shadowDir: string, commit: string) =>
    shadowGit("ArcCheckpointOps.commitMessage", shadowDir, ["show", "-s", "--format=%B", commit], {
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );

  const recordedHeadOf = (shadowDir: string, commit: string) =>
    commitMessageOf(shadowDir, commit).pipe(
      Effect.map((message) => /arc-head=(\S+)/.exec(message)?.[1] ?? null),
    );

  /** Stores bytes as a blob in the shadow repository; the file route keeps them byte-exact. */
  const storeBlob = (operation: string, shadowDir: string, bytes: Uint8Array) =>
    withTempFile(shadowDir, "t3-seed", (tempPath) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFile(tempPath, bytes).pipe(
          Effect.mapError(
            (cause) =>
              new VcsProcessExitError({
                operation,
                command: "git hash-object",
                cwd: shadowDir,
                exitCode: 1,
                detail: `Could not stage a pristine blob: ${cause.message}`,
              }),
          ),
        );
        const result = yield* shadowGit(operation, shadowDir, [
          "hash-object",
          "-w",
          "--",
          tempPath,
        ]);
        return result.stdout.trim();
      }),
    );

  /**
   * Pristine blobs for tracked paths the thread touches for the first time this turn, read
   * once from arc at the head the previous snapshot recorded. A path arc has no copy of at
   * that head — or one arc cannot read — is simply not seeded.
   */
  const pristineSeeds = Effect.fn("ArcCheckpointOps.pristineSeeds")(function* (
    operation: string,
    shadowDir: string,
    mountRoot: string,
    entries: ReadonlyArray<ArcChangedEntry>,
    snapshots: ReadonlyArray<ThreadSnapshot>,
    earlierPaths: ReadonlySet<string>,
  ) {
    const seeds = new Map<string, string>();
    const previous = snapshots.at(-1);
    if (previous === undefined) return seeds;
    const newlyTouched = entries.filter((entry) => entry.tracked && !earlierPaths.has(entry.path));
    if (newlyTouched.length === 0) return seeds;
    const head =
      (yield* recordedHeadOf(shadowDir, previous.commit)) ?? (yield* probe.readHead(mountRoot));
    if (head === null) return seeds;
    for (const entry of newlyTouched) {
      const bytes = yield* probe.readFileAtHead({ mountRoot, head, path: entry.path });
      if (bytes === null) continue;
      seeds.set(entry.path, yield* storeBlob(operation, shadowDir, bytes));
    }
    return seeds;
  });

  /**
   * Writes the seeded blobs into every earlier snapshot of the thread, which is where the
   * files stood pristine all along. Each rewritten snapshot keeps its message and is
   * re-parented onto the rewritten one before it, so the chain stays one thread.
   */
  const seedEarlierSnapshots = Effect.fn("ArcCheckpointOps.seedEarlierSnapshots")(function* (
    operation: string,
    shadowDir: string,
    snapshots: ReadonlyArray<ThreadSnapshot>,
    seeds: ReadonlyMap<string, string>,
  ) {
    const rewritten: ThreadSnapshot[] = [];
    let previousCommit: string | null = null;
    for (const snapshot of snapshots) {
      const originalTree = yield* resolveObject(shadowDir, `${snapshot.commit}^{tree}`);
      const originalParent = yield* resolveObject(shadowDir, `${snapshot.commit}^1`);
      const seededTree = yield* withTempIndex(shadowDir, (tempIndexPath) =>
        Effect.gen(function* () {
          const indexEnv = { GIT_INDEX_FILE: tempIndexPath };
          yield* shadowGit(operation, shadowDir, ["read-tree", snapshot.commit], { env: indexEnv });
          for (const [seedPath, blob] of seeds) {
            yield* shadowGit(
              operation,
              shadowDir,
              ["update-index", "--add", "--cacheinfo", `100644,${blob},${seedPath}`],
              { env: indexEnv },
            );
          }
          const writeTree = yield* shadowGit(operation, shadowDir, ["write-tree"], {
            env: indexEnv,
          });
          return writeTree.stdout.trim();
        }),
      );
      let commit = snapshot.commit;
      if (seededTree !== originalTree || previousCommit !== originalParent) {
        const message = yield* commitMessageOf(shadowDir, snapshot.commit);
        const commitTree = yield* shadowGit(
          operation,
          shadowDir,
          [
            "commit-tree",
            seededTree,
            ...(previousCommit === null ? [] : ["-p", previousCommit]),
            "-m",
            message,
          ],
          { env: commitEnv() },
        );
        commit = commitTree.stdout.trim();
        yield* shadowGit(operation, shadowDir, ["update-ref", snapshot.ref, commit]);
      }
      rewritten.push({ ...snapshot, commit });
      previousCommit = commit;
    }
    return rewritten;
  });

  const captureCheckpoint: VcsCheckpointOps["captureCheckpoint"] = Effect.fn(
    "ArcCheckpointOps.captureCheckpoint",
  )(function* (input) {
    const operation = "ArcCheckpointOps.captureCheckpoint";
    const mountRoot = yield* requireMountRoot(operation, input.cwd);
    const shadowDir = yield* ensureShadow(mountRoot);
    const entries = yield* probe.readChangedEntries(mountRoot);
    let snapshots = yield* listThreadSnapshots(shadowDir, input.checkpointRef);
    const earlierPaths = yield* snapshotPaths(shadowDir, snapshots);

    const seeds = yield* pristineSeeds(
      operation,
      shadowDir,
      mountRoot,
      entries,
      snapshots,
      earlierPaths,
    );
    if (seeds.size > 0) {
      snapshots = yield* seedEarlierSnapshots(operation, shadowDir, snapshots, seeds);
    }

    // The thread's touched set: what arc reports changed now, plus every path any earlier
    // snapshot held. A file put back to its pristine content still exists on disk, so
    // carrying it forward makes a revert read as a change back rather than a deletion.
    const touched = [...new Set([...entries.map((entry) => entry.path), ...earlierPaths])].sort();
    const treeOid = yield* snapshotTree(operation, shadowDir, mountRoot, touched);
    const arcHead = (yield* probe.readHead(mountRoot)) ?? "unknown";
    // The previous turn's snapshot is the parent, so the shadow history reads as the thread.
    const parent = snapshots.at(-1);
    const message = `t3 checkpoint ref=${input.checkpointRef} arc-head=${arcHead}`;
    const commitTree = yield* shadowGit(
      operation,
      shadowDir,
      ["commit-tree", treeOid, ...(parent ? ["-p", parent.commit] : []), "-m", message],
      { env: commitEnv() },
    );
    const commitOid = commitTree.stdout.trim();
    if (commitOid.length === 0) {
      return yield* new VcsProcessExitError({
        operation,
        command: "git commit-tree",
        cwd: shadowDir,
        exitCode: 0,
        detail: "git commit-tree returned an empty commit oid.",
      });
    }
    yield* shadowGit(operation, shadowDir, ["update-ref", input.checkpointRef, commitOid]);
  });

  const hasCheckpointRef: VcsCheckpointOps["hasCheckpointRef"] = Effect.fn(
    "ArcCheckpointOps.hasCheckpointRef",
  )(function* (input) {
    const mountRoot = yield* requireMountRoot("ArcCheckpointOps.hasCheckpointRef", input.cwd);
    const shadowDir = yield* ensureShadow(mountRoot);
    return (yield* resolveCommit(shadowDir, input.checkpointRef)) !== null;
  });

  /**
   * Puts the touched files back as the target snapshot had them: a throwaway tree of the
   * present state says which paths exist now, the target tree is checked out over the mount
   * through GIT_WORK_TREE, and paths present now but absent from the target are removed.
   * Nothing outside the touched set is read or written.
   */
  const restoreCheckpoint: VcsCheckpointOps["restoreCheckpoint"] = Effect.fn(
    "ArcCheckpointOps.restoreCheckpoint",
  )(function* (input) {
    const operation = "ArcCheckpointOps.restoreCheckpoint";
    const mountRoot = yield* requireMountRoot(operation, input.cwd);
    const shadowDir = yield* ensureShadow(mountRoot);
    const targetCommit = yield* resolveCommit(shadowDir, input.checkpointRef);
    // There is no HEAD to fall back to: the pristine content of a touched file lives in arc,
    // which the shadow repository only ever reads for seeding. A missing ref is not restored.
    if (targetCommit === null) {
      return false;
    }

    const entries = yield* probe.readChangedEntries(mountRoot);
    const snapshots = yield* listThreadSnapshots(shadowDir, input.checkpointRef);
    const earlierPaths = yield* snapshotPaths(shadowDir, snapshots);
    const touched = [...new Set([...entries.map((entry) => entry.path), ...earlierPaths])].sort();
    const nowTree = yield* snapshotTree(operation, shadowDir, mountRoot, touched);
    const nowPaths = new Set(yield* treePaths(shadowDir, nowTree));
    const targetPaths = new Set(yield* treePaths(shadowDir, targetCommit));

    const recordedHead = yield* recordedHeadOf(shadowDir, targetCommit);
    const currentHead = yield* probe.readHead(mountRoot);
    if (recordedHead !== null && currentHead !== null && recordedHead !== currentHead) {
      yield* Effect.logWarning(
        "Restoring an arc checkpoint recorded at a different arc head; touched files are written back as snapshotted.",
        { mountRoot, recordedHead, currentHead },
      );
    }

    if (targetPaths.size > 0) {
      yield* withTempIndex(shadowDir, (tempIndexPath) =>
        Effect.gen(function* () {
          yield* shadowGit(operation, shadowDir, ["read-tree", targetCommit], {
            env: { GIT_INDEX_FILE: tempIndexPath },
          });
          yield* shadowGit(operation, shadowDir, ["checkout-index", "-f", "-a"], {
            env: { GIT_INDEX_FILE: tempIndexPath, GIT_WORK_TREE: mountRoot },
          });
        }),
      );
    }
    for (const nowPath of nowPaths) {
      if (targetPaths.has(nowPath)) continue;
      yield* fileSystem.remove(path.join(mountRoot, nowPath), { force: true }).pipe(Effect.ignore);
    }
    return true;
  });

  const diffCheckpoints: VcsCheckpointOps["diffCheckpoints"] = Effect.fn(
    "ArcCheckpointOps.diffCheckpoints",
  )(function* (input) {
    const operation = "ArcCheckpointOps.diffCheckpoints";
    const mountRoot = yield* requireMountRoot(operation, input.cwd);
    const shadowDir = yield* ensureShadow(mountRoot);

    let fromRevision: string = `${input.fromCheckpointRef}^{commit}`;
    if (input.fallbackFromToHead === true) {
      const fromCommit = yield* resolveCommit(shadowDir, input.fromCheckpointRef);
      if (fromCommit !== null) {
        fromRevision = fromCommit;
      } else {
        // The nearest thing to "before any change" the shadow repository holds: the thread's
        // earliest snapshot, or the empty tree when there is none.
        const snapshots = yield* listThreadSnapshots(shadowDir, input.fromCheckpointRef);
        fromRevision = snapshots[0]?.commit ?? EMPTY_TREE_OID;
      }
    }

    const result = yield* shadowGit(
      operation,
      shadowDir,
      [
        "diff",
        ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...PATCH_RENDER_PREFIX_ARGS,
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        fromRevision,
        `${input.toCheckpointRef}^{commit}`,
      ],
      {
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      },
    );
    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation,
        command: "git diff",
        cwd: shadowDir,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
      });
    }
    return result.stdout;
  });

  const deleteCheckpointRefs: VcsCheckpointOps["deleteCheckpointRefs"] = Effect.fn(
    "ArcCheckpointOps.deleteCheckpointRefs",
  )(function* (input) {
    const mountRoot = yield* requireMountRoot("ArcCheckpointOps.deleteCheckpointRefs", input.cwd);
    const shadowDir = yield* ensureShadow(mountRoot);
    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        shadowGit(
          "ArcCheckpointOps.deleteCheckpointRefs",
          shadowDir,
          ["update-ref", "-d", checkpointRef],
          { allowNonZeroExit: true },
        ),
      { discard: true },
    );
  });

  const ops: VcsCheckpointOps = {
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  };

  return { detectMountRoot, ops };
});
