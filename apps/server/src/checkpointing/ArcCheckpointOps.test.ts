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
 * `arc status` answer the test sets by hand. Real git backs the shadow repository.
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
    const changed = new Set<string>();
    const probeLayer = Layer.succeed(ArcCheckpointOps.ArcCheckpointProbe, {
      readChangedPaths: () => Effect.succeed([...changed]),
      readHead: () => Effect.succeed(ARC_HEAD),
    });
    const { ops } = yield* ArcCheckpointOps.make({ shadowRootDir: shadowRoot }).pipe(
      Effect.provide(probeLayer),
    );
    const write = (relativePath: string, contents: string) =>
      fileSystem.writeFileString(NodePath.join(root, relativePath), contents);
    const read = (relativePath: string) =>
      fileSystem.readFileString(NodePath.join(root, relativePath));
    const exists = (relativePath: string) => fileSystem.exists(NodePath.join(root, relativePath));
    const remove = (relativePath: string) =>
      fileSystem.remove(NodePath.join(root, relativePath), { force: true });
    return { root, shadowRoot, changed, ops, write, read, exists, remove };
  });
}

const threadId = ThreadId.make("thread-arc-checkpoints");
const turn = (count: number) => checkpointRefForThreadTurn(threadId, count);

it.layer(TestLayer)("ArcCheckpointOps", (it) => {
  describe("parseArcStatusPaths", () => {
    it.effect("reads files from every status section, dropping directories and repeats", () =>
      Effect.sync(() => {
        const paths = ArcCheckpointOps.parseArcStatusPaths(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            status: {
              staged: [{ status: "new file", type: "file", path: "project/lib/new.ts" }],
              changed: [
                { status: "modified", type: "file", path: "project/lib/util.ts" },
                { status: "modified", type: "file", path: "project/lib/new.ts" },
              ],
              untracked: [
                { status: "untracked", type: "directory", path: "project/scratch" },
                { status: "untracked", type: "file", path: "project/scratch/notes.txt" },
              ],
            },
          }),
        );

        expect(paths).toEqual([
          "project/lib/new.ts",
          "project/lib/util.ts",
          "project/scratch/notes.txt",
        ]);
        expect(ArcCheckpointOps.parseArcStatusPaths("not json")).toEqual([]);
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
        mount.changed.add("a.txt");
        mount.changed.add("b.txt");
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
        mount.changed.add("a.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        // Back to its arc HEAD content: arc no longer lists it, but it is still on disk.
        yield* mount.write("a.txt", "one\n");
        mount.changed.clear();
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

    it.effect("reads a file removed from disk as a deletion", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("b.txt", "new\n");
        mount.changed.add("b.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        yield* mount.remove("b.txt");
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
        mount.changed.add("a.txt");
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

  describe("restoreCheckpoint", () => {
    it.effect("writes touched files back, removes later additions, leaves the rest alone", () =>
      Effect.gen(function* () {
        const mount = yield* makeMount();
        yield* mount.write("a.txt", "v1\n");
        yield* mount.write("u.txt", "keep\n");
        mount.changed.add("a.txt");
        yield* mount.ops.captureCheckpoint({ cwd: mount.root, checkpointRef: turn(1) });

        yield* mount.write("a.txt", "v2\n");
        yield* mount.write("c.txt", "later\n");
        mount.changed.add("c.txt");
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
        mount.changed.add("a.txt");

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
