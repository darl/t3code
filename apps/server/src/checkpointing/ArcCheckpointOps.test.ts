// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as ArcCheckpointOps from "./ArcCheckpointOps.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const TestLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

const ARC_HEAD = "0123456789abcdef0123456789abcdef01234567";

/**
 * A fake arc mount: a temp dir carrying `.arc/HEAD` and no git anywhere, plus a probe whose
 * `arc status` / `arc show` answers the test sets by hand. Real git backs the shadow repo.
 */
function makeMount() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "arc-checkpoint-mount-" });
    const shadowRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "arc-checkpoint-shadow-",
    });
    yield* fileSystem.makeDirectory(NodePath.join(root, ".arc"), { recursive: true });
    yield* fileSystem.writeFileString(
      NodePath.join(root, ".arc", "HEAD"),
      "ref: refs/heads/trunk\n",
    );
    /** path → tracked, as `arc status` would report right now. */
    const status = new Map<string, boolean>();
    /** path → bytes at arc HEAD, as `arc show HEAD:path` would answer. */
    const pristine = new Map<string, string>();
    const pristineReads: string[] = [];
    const probeLayer = Layer.succeed(ArcCheckpointOps.ArcCheckpointProbe, {
      readChangedEntries: () =>
        Effect.succeed([...status.entries()].map(([path, tracked]) => ({ path, tracked }))),
      readHead: () => Effect.succeed(ARC_HEAD),
      readFileAtHead: ({ path }) =>
        Effect.sync(() => {
          pristineReads.push(path);
          const contents = pristine.get(path);
          return contents === undefined ? null : new TextEncoder().encode(contents);
        }),
    });
    const { ops } = yield* ArcCheckpointOps.make({ shadowRootDir: shadowRoot }).pipe(
      Effect.provide(probeLayer),
    );
    return {
      root,
      shadowRoot,
      ops,
      pristineReads,
      /** A tracked file with the given content at arc HEAD, now reported as changed. */
      track: (path: string, pristineContents: string) => {
        status.set(path, true);
        pristine.set(path, pristineContents);
      },
      /** An untracked or newly added file, which arc HEAD knows nothing about. */
      create: (path: string) => {
        status.set(path, false);
      },
      /** arc no longer reports anything changed. */
      clearStatus: () => {
        status.clear();
      },
      write: (relativePath: string, contents: string) =>
        fileSystem.writeFileString(NodePath.join(root, relativePath), contents),
      read: (relativePath: string) => fileSystem.readFileString(NodePath.join(root, relativePath)),
      exists: (relativePath: string) => fileSystem.exists(NodePath.join(root, relativePath)),
      remove: (relativePath: string) =>
        fileSystem.remove(NodePath.join(root, relativePath), { force: true }),
    };
  });
}

const threadId = ThreadId.make("thread-arc-checkpoints");
const turn = (count: number) => checkpointRefForThreadTurn(threadId, count);

it.layer(TestLayer)("ArcCheckpointOps", (it) => {
  describe("parseArcStatusEntries", () => {
    it.effect("reads files from every section, marking new and untracked ones as such", () =>
      Effect.sync(() => {
        const entries = ArcCheckpointOps.parseArcStatusEntries(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            status: {
              staged: [{ status: "new file", type: "file", path: "project/lib/new.ts" }],
              changed: [
                { status: "modified", type: "file", path: "project/lib/util.ts" },
                { status: "modified", type: "file", path: "project/lib/new.ts" },
                { status: "deleted", type: "file", path: "project/lib/old.ts" },
              ],
              untracked: [
                { status: "untracked", type: "directory", path: "project/scratch" },
                { status: "untracked", type: "file", path: "project/scratch/notes.txt" },
              ],
            },
          }),
        );

        expect(entries).toEqual([
          // Staged as new, so arc HEAD has no copy even though it is also modified.
          { path: "project/lib/new.ts", tracked: false },
          { path: "project/lib/old.ts", tracked: true },
          { path: "project/lib/util.ts", tracked: true },
          { path: "project/scratch/notes.txt", tracked: false },
        ]);
        expect(ArcCheckpointOps.parseArcStatusEntries("not json")).toEqual([]);
      }),
    );
  });

  describe("captureCheckpoint / diffCheckpoints", () => {
    it.effect("snapshots only the touched set, never scanning the mount", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "one\n");
        yield* mount.write("other.txt", "never touched\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(0) });

        yield* mount.write("a.txt", "two\n");
        yield* mount.write("b.txt", "new\n");
        mount.track("a.txt", "one\n");
        mount.create("b.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(0),
          toCheckpointRef: turn(1),
          ignoreWhitespace: false,
        });
        const numstat = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(0),
          toCheckpointRef: turn(1),
          ignoreWhitespace: false,
          format: "numstat",
        });

        expect(patch).toContain("diff --git a/a.txt b/a.txt");
        expect(patch).toContain("-one");
        expect(patch).toContain("+two");
        expect(patch).toContain("diff --git a/b.txt b/b.txt");
        expect(patch).toContain("new file mode");
        expect(numstat).toContain("a.txt");
        expect(numstat).toContain("b.txt");
        expect(numstat).not.toContain("other.txt");
        // The mount stays git-free; the shadow repository lives elsewhere.
        expect(yield* mount.exists(".git")).toBe(false);
        const fileSystem = yield* FileSystem.FileSystem;
        expect((yield* fileSystem.readDirectory(mount.shadowRoot)).length).toBe(1);
      }),
    );

    it.effect("reads a file put back to pristine as a change back, not a deletion", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "two\n");
        mount.track("a.txt", "one\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        // Back to its arc HEAD content: arc no longer lists it, but it is still on disk.
        yield* mount.write("a.txt", "one\n");
        mount.clearStatus();
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(1),
          toCheckpointRef: turn(2),
          ignoreWhitespace: false,
        });

        expect(patch).toContain("-two");
        expect(patch).toContain("+one");
        expect(patch).not.toContain("deleted file mode");
      }),
    );

    it.effect("reads a new file removed from disk as a deletion", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("b.txt", "new\n");
        mount.create("b.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        yield* mount.remove("b.txt");
        mount.clearStatus();
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(1),
          toCheckpointRef: turn(2),
          ignoreWhitespace: false,
        });

        expect(patch).toContain("deleted file mode");
        expect(patch).toContain("-new");
      }),
    );

    it.effect("falls back to the thread's earliest snapshot when the from ref is missing", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "one\n");
        mount.create("a.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(3) });
        yield* mount.write("a.txt", "two\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(4) });

        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(0),
          toCheckpointRef: turn(4),
          fallbackFromToHead: true,
          ignoreWhitespace: false,
        });

        expect(patch).toContain("-one");
        expect(patch).toContain("+two");
      }),
    );
  });

  describe("pristine seeding", () => {
    it.effect("a tracked file first modified in a turn diffs as a hunk, not a whole-file add", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "one\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        yield* mount.write("a.txt", "two\n");
        mount.track("a.txt", "one\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

        const numstat = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(1),
          toCheckpointRef: turn(2),
          ignoreWhitespace: false,
          format: "numstat",
        });
        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(1),
          toCheckpointRef: turn(2),
          ignoreWhitespace: false,
        });

        // One line replaced one line: the pristine copy was seeded into turn 1.
        expect(numstat).toContain("1\t1\t");
        expect(patch).toContain("-one");
        expect(patch).toContain("+two");
        expect(patch).not.toContain("new file mode");
        expect(mount.pristineReads).toEqual(["a.txt"]);
      }),
    );

    it.effect("a tracked file first deleted in a turn shows as a deletion", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        // Gone from disk; arc reports it as a tracked deletion.
        mount.track("gone.txt", "gone\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(1),
          toCheckpointRef: turn(2),
          ignoreWhitespace: false,
        });

        expect(patch).toContain("deleted file mode");
        expect(patch).toContain("-gone");
      }),
    );

    it.effect("an untracked new file is not seeded and still reads as an add", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        yield* mount.write("n.txt", "fresh\n");
        mount.create("n.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

        const patch = yield* mount.ops.diffCheckpoints({
          cwd: mount.root,
          fromCheckpointRef: turn(1),
          toCheckpointRef: turn(2),
          ignoreWhitespace: false,
        });

        expect(patch).toContain("new file mode");
        expect(patch).toContain("+fresh");
        expect(mount.pristineReads).toEqual([]);
      }),
    );

    it.effect(
      "seeds every earlier snapshot, so restoring to one writes the pristine file back",
      () =>
        Effect.gen(function* () {
          const mount = yield* makeMount();
          yield* mount.write("a.txt", "one\n");
          yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });
          yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

          yield* mount.write("a.txt", "three\n");
          mount.track("a.txt", "one\n");
          yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(3) });

          // Turns 1 and 2 both hold the pristine copy now: nothing changed between them, and
          // the first touch reads as a hunk from either.
          expect(
            yield* mount.ops.diffCheckpoints({
              cwd: mount.root,
              fromCheckpointRef: turn(1),
              toCheckpointRef: turn(2),
              ignoreWhitespace: false,
            }),
          ).toBe("");
          const patch = yield* mount.ops.diffCheckpoints({
            cwd: mount.root,
            fromCheckpointRef: turn(1),
            toCheckpointRef: turn(3),
            ignoreWhitespace: false,
          });
          expect(patch).toContain("-one");
          expect(patch).toContain("+three");
          // Only one arc read for the whole thread, whatever the number of earlier turns.
          expect(mount.pristineReads).toEqual(["a.txt"]);

          // Restoring to turn 1 used to delete the file; now it puts the pristine bytes back.
          const restored = yield* mount.ops.restoreCheckpoint({
            cwd: mount.root,
            checkpointRef: turn(1),
          });
          expect(restored).toBe(true);
          expect(yield* mount.read("a.txt")).toBe("one\n");
          expect(
            yield* mount.ops.hasCheckpointRef({ cwd: mount.root, checkpointRef: turn(2) }),
          ).toBe(true);
        }),
    );
  });

  describe("restoreCheckpoint", () => {
    it.effect("writes touched files back, removes later additions, leaves the rest alone", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "v1\n");
        yield* mount.write("u.txt", "keep\n");
        mount.track("a.txt", "v0\n");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        yield* mount.write("a.txt", "v2\n");
        yield* mount.write("c.txt", "later\n");
        mount.create("c.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(2) });

        const restored = yield* mount.ops.restoreCheckpoint({
          cwd: mount.root,
          checkpointRef: turn(1),
        });

        expect(restored).toBe(true);
        expect(yield* mount.read("a.txt")).toBe("v1\n");
        expect(yield* mount.exists("c.txt")).toBe(false);
        expect(yield* mount.read("u.txt")).toBe("keep\n");
      }),
    );

    it.effect("answers false for a missing ref and touches nothing", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "v1\n");
        mount.track("a.txt", "v0\n");

        const restored = yield* mount.ops.restoreCheckpoint({
          cwd: mount.root,
          checkpointRef: turn(9),
          fallbackToHead: true,
        });

        expect(restored).toBe(false);
        expect(yield* mount.read("a.txt")).toBe("v1\n");
      }),
    );
  });

  describe("hasCheckpointRef / deleteCheckpointRefs", () => {
    it.effect(
      "answers for refs in the shadow repository and tolerates deleting a missing one",
      () =>
        Effect.gen(function* () {
          const mount = yield* makeMount();
          yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

          expect(
            yield* mount.ops.hasCheckpointRef({ cwd: mount.root, checkpointRef: turn(1) }),
          ).toBe(true);
          expect(
            yield* mount.ops.hasCheckpointRef({ cwd: mount.root, checkpointRef: turn(7) }),
          ).toBe(false);

          yield* mount.ops.deleteCheckpointRefs({
            cwd: mount.root,
            checkpointRefs: [turn(1), turn(7)],
          });

          expect(
            yield* mount.ops.hasCheckpointRef({ cwd: mount.root, checkpointRef: turn(1) }),
          ).toBe(false);
        }),
    );

    it.effect("refuses a cwd outside any arc mount", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        const fileSystem = yield* FileSystem.FileSystem;
        const elsewhere = yield* fileSystem.makeTempDirectoryScoped({ prefix: "not-a-mount-" });

        const error = yield* Effect.flip(
          mount.ops.hasCheckpointRef({ cwd: elsewhere, checkpointRef: turn(1) }),
        );

        expect(error._tag).toBe("VcsProcessExitError");
      }),
    );
  });
});
