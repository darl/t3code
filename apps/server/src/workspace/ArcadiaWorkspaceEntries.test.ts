import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ArcadiaWorkspaceEntries from "./ArcadiaWorkspaceEntries.ts";

// --- pure helpers ------------------------------------------------------------

describe("fuzzyPathRegexp", () => {
  it("case-insensitive character classes for letters, escapes the rest", () => {
    expect(ArcadiaWorkspaceEntries.fuzzyPathRegexp("ab")).toBe("[aA][bB]");
    expect(ArcadiaWorkspaceEntries.fuzzyPathRegexp("a.c")).toBe("[aA]\\.[cC]");
    expect(ArcadiaWorkspaceEntries.fuzzyPathRegexp("f1")).toBe("[fF]1");
  });

  it("whitespace becomes a fuzzy gap", () => {
    expect(ArcadiaWorkspaceEntries.fuzzyPathRegexp("a b")).toBe("[aA].*[bB]");
    expect(ArcadiaWorkspaceEntries.fuzzyPathRegexp("a  b")).toBe("[aA].*[bB]");
  });

  it("output is a valid JavaScript regexp", () => {
    const pattern = new RegExp(ArcadiaWorkspaceEntries.fuzzyPathRegexp("Query TS"));
    expect(pattern.test("lib/query_utils.ts")).toBe(true);
    expect(pattern.test("lib/other.ts")).toBe(false);
  });
});

describe("parseFcsFileListing", () => {
  it("collects paths until the Total trailer", () => {
    const parsed = ArcadiaWorkspaceEntries.parseFcsFileListing(
      "a/b.ts\nc/d.py\nTotal: 2 (revision: r123)\n",
    );
    expect(parsed.paths).toEqual(["a/b.ts", "c/d.py"]);
    expect(parsed.hasMore).toBe(false);
  });

  it("a + after the count marks a truncated result set", () => {
    const parsed = ArcadiaWorkspaceEntries.parseFcsFileListing(
      "a/b.ts\nTotal: 1+ (revision: r123)\n",
    );
    expect(parsed.hasMore).toBe(true);
  });
});

describe("parseFcsContentMatches", () => {
  it("parses path:line:content, keeping colons inside the content", () => {
    const parsed = ArcadiaWorkspaceEntries.parseFcsContentMatches(
      "dir/f.py:12:hello: world\nTotal: 1 (revision: r1)\n",
    );
    expect(parsed.matches).toEqual([
      { path: "dir/f.py", lineNumber: 12, lineContent: "hello: world" },
    ]);
    expect(parsed.hasMore).toBe(false);
  });
});

describe("parseArcStatusEntries", () => {
  const statusJson = JSON.stringify({
    status: {
      changed: [{ status: "modified", type: "file", path: "junk/darl/mod.ts" }],
      untracked: [
        { status: "untracked", type: "directory", path: "junk/darl/newdir" },
        { status: "untracked", type: "file", path: "other/place.ts" },
      ],
    },
  });

  it("keeps arcadia-root-relative paths when the workspace is the root", () => {
    const entries = ArcadiaWorkspaceEntries.parseArcStatusEntries(statusJson, "");
    expect(entries).toEqual([
      { path: "junk/darl/mod.ts", kind: "file" },
      { path: "junk/darl/newdir", kind: "directory" },
      { path: "other/place.ts", kind: "file" },
    ]);
  });

  it("re-roots to a workspace subdirectory and drops entries outside it", () => {
    const entries = ArcadiaWorkspaceEntries.parseArcStatusEntries(statusJson, "junk/darl");
    expect(entries).toEqual([
      { path: "mod.ts", kind: "file" },
      { path: "newdir", kind: "directory" },
    ]);
  });

  it("returns empty for unparsable output", () => {
    expect(ArcadiaWorkspaceEntries.parseArcStatusEntries("not json", "")).toEqual([]);
  });
});

describe("ancestorDirectories", () => {
  it("derives unique ancestors in first-seen order", () => {
    expect(ArcadiaWorkspaceEntries.ancestorDirectories(["a/b/c.ts", "a/d.ts"])).toEqual([
      "a",
      "a/b",
    ]);
  });
});

describe("computeMatchRanges", () => {
  it("returns every occurrence with string indexes", () => {
    expect(ArcadiaWorkspaceEntries.computeMatchRanges("foo Foo", /foo/gi, false)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it("whole-word filtering drops embedded occurrences", () => {
    expect(ArcadiaWorkspaceEntries.computeMatchRanges("xfoo foo", /foo/g, true)).toEqual([
      { start: 5, end: 8 },
    ]);
  });
});

// --- effectful backends ------------------------------------------------------

interface CannedReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

const cannedReplies = new Map<string, CannedReply>();
const recordedRuns: string[] = [];

function replyKey(command: string, args: ReadonlyArray<string>): string {
  const commandName = command.split("/").at(-1)!;
  return `${commandName} ${args.join(" ")}`;
}

const stubVcsProcessLayer = Layer.succeed(
  VcsProcess.VcsProcess,
  VcsProcess.VcsProcess.of({
    run: (input) =>
      Effect.sync(() => {
        const key = replyKey(input.command, input.args);
        recordedRuns.push(key);
        const reply = cannedReplies.get(key);
        if (!reply) {
          throw new Error(`No canned VcsProcess reply for: ${key}`);
        }
        return {
          exitCode: (reply.exitCode ?? 0) as ChildProcessSpawner.ExitCode,
          stdout: reply.stdout ?? "",
          stderr: reply.stderr ?? "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  }),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(stubVcsProcessLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeArcadiaMount = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-arcadia-test-" });
  yield* fileSystem.makeDirectory(path.join(root, ".arc"));
  yield* fileSystem.writeFileString(path.join(root, "ya"), "");
  return root;
});

const writeTextFile = (root: string, relativePath: string, contents = "") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

const QUERY_PATTERN = "[qQ][uU][eE][rR][yY]";

const arcStatusReply = (entries: {
  readonly changed?: ReadonlyArray<{ type: string; path: string }>;
  readonly untracked?: ReadonlyArray<{ type: string; path: string }>;
}) => ({
  stdout: JSON.stringify({
    status: {
      changed: (entries.changed ?? []).map((entry) => ({ status: "modified", ...entry })),
      untracked: (entries.untracked ?? []).map((entry) => ({ status: "untracked", ...entry })),
    },
  }),
});

it.layer(TestLayer, { excludeTestServices: true })("ArcadiaWorkspaceEntries", (it) => {
  beforeEach(() => {
    cannedReplies.clear();
    recordedRuns.length = 0;
  });

  describe("detectRoot", () => {
    it.effect("walks up from a workspace subdirectory to the mount root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;
        const workspace = path.join(root, "junk", "darl", "proj");
        yield* fileSystem.makeDirectory(workspace, { recursive: true });

        expect(yield* arcadia.detectRoot(workspace)).toBe(root);
        expect(yield* arcadia.detectRoot(root)).toBe(root);
      }),
    );

    it.effect("returns null outside an arc mount", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const plainDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-plain-" });
        expect(yield* arcadia.detectRoot(plainDir)).toBe(null);
      }),
    );
  });

  describe("search", () => {
    it.effect("merges local arc status entries with trunk file listing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;
        const workspace = path.join(root, "junk", "darl");
        yield* fileSystem.makeDirectory(workspace, { recursive: true });

        cannedReplies.set(
          "arc status --json",
          arcStatusReply({
            changed: [{ type: "file", path: "junk/darl/newfile_query.ts" }],
            untracked: [
              { type: "directory", path: "junk/darl/somedir" },
              { type: "file", path: "other/place.ts" },
            ],
          }),
        );
        cannedReplies.set(`ya grep --remote --no-colors -f ${QUERY_PATTERN} -m 200`, {
          stdout: "lib/query_utils.ts\ndocs/query.md\nTotal: 2 (revision: r5)\n",
        });

        const result = yield* arcadia.search({
          cwd: workspace,
          root,
          query: "query",
          limit: 10,
          kind: "file",
        });

        expect(result.entries).toEqual([
          { path: "newfile_query.ts", kind: "file" },
          { path: "lib/query_utils.ts", kind: "file" },
          { path: "docs/query.md", kind: "file" },
        ]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("empty query returns locally changed entries without querying FCS", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;

        cannedReplies.set(
          "arc status --json",
          arcStatusReply({
            changed: [{ type: "file", path: "mod.ts" }],
            untracked: [{ type: "directory", path: "newdir" }],
          }),
        );

        const result = yield* arcadia.search({ cwd: root, root, query: "", limit: 10 });

        expect(result.entries).toEqual([
          { path: "mod.ts", kind: "file" },
          { path: "newdir", kind: "directory" },
        ]);
        expect(recordedRuns.some((key) => key.startsWith("ya "))).toBe(false);
      }),
    );

    it.effect("directory kind derives matching ancestors from trunk file paths", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;

        cannedReplies.set("arc status --json", arcStatusReply({}));
        cannedReplies.set(`ya grep --remote --no-colors -f ${QUERY_PATTERN} -m 200`, {
          stdout: "lib/query/a.ts\nlib/query/b.ts\nTotal: 2 (revision: r5)\n",
        });

        const result = yield* arcadia.search({
          cwd: root,
          root,
          query: "query",
          limit: 10,
          kind: "directory",
        });

        expect(result.entries).toEqual([{ path: "lib/query", kind: "directory" }]);
      }),
    );

    it.effect("reports truncation when FCS cuts the listing short", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;

        cannedReplies.set("arc status --json", arcStatusReply({}));
        cannedReplies.set(`ya grep --remote --no-colors -f ${QUERY_PATTERN} -m 200`, {
          stdout: "lib/query_utils.ts\nTotal: 1+ (revision: r5)\n",
        });

        const result = yield* arcadia.search({
          cwd: root,
          root,
          query: "query",
          limit: 10,
          kind: "file",
        });

        expect(result.truncated).toBe(true);
      }),
    );
  });

  describe("searchContents", () => {
    it.effect("locally modified files are re-grepped and replace stale trunk matches", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;
        yield* writeTextFile(root, "mod.ts", "local needle here\nno match\n");

        cannedReplies.set(
          "arc status --json",
          arcStatusReply({ changed: [{ type: "file", path: "mod.ts" }] }),
        );
        cannedReplies.set("ya grep --remote --no-colors -i -m 50 needle", {
          stdout: "mod.ts:9:trunk needle stale\nother.ts:3:a needle b\nTotal: 2 (revision: r7)\n",
        });

        const result = yield* arcadia.searchContents({
          cwd: root,
          root,
          input: {
            query: "needle",
            limit: 50,
            caseSensitive: false,
            wholeWord: false,
            useRegex: false,
          },
        });

        expect(result.matches).toEqual([
          {
            path: "mod.ts",
            lineNumber: 1,
            lineContent: "local needle here",
            matchRanges: [{ start: 6, end: 12 }],
          },
          {
            path: "other.ts",
            lineNumber: 3,
            lineContent: "a needle b",
            matchRanges: [{ start: 2, end: 8 }],
          },
        ]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("maps case-sensitivity and whole-word flags onto ya grep arguments", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;

        cannedReplies.set("arc status --json", arcStatusReply({}));
        cannedReplies.set("ya grep --remote --no-colors -w -m 10 Needle", {
          stdout: "a.ts:1:a Needle b\nTotal: 1 (revision: r7)\n",
        });

        const result = yield* arcadia.searchContents({
          cwd: root,
          root,
          input: {
            query: "Needle",
            limit: 10,
            caseSensitive: true,
            wholeWord: true,
            useRegex: false,
          },
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]!.matchRanges).toEqual([{ start: 2, end: 8 }]);
      }),
    );

    it.effect("an FCS-rejected regex surfaces as regexFallbackError, not a failed RPC", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;

        cannedReplies.set("ya grep --remote --no-colors -i -m 10 a(?<=b)", {
          exitCode: 1,
          stderr: "error: unsupported regex\n",
        });

        const result = yield* arcadia.searchContents({
          cwd: root,
          root,
          input: {
            query: "a(?<=b)",
            limit: 10,
            caseSensitive: false,
            wholeWord: false,
            useRegex: true,
          },
        });

        expect(result.matches).toEqual([]);
        expect(result.regexFallbackError).toBeDefined();
      }),
    );
  });

  describe("list", () => {
    it.effect("breadth-first listing of the mount, skipping dot directories", () =>
      Effect.gen(function* () {
        const arcadia = yield* ArcadiaWorkspaceEntries.make;
        const root = yield* makeArcadiaMount;
        yield* writeTextFile(root, "a/b.txt");
        yield* writeTextFile(root, "a/c/d.txt");

        const result = yield* arcadia.list(root);

        expect(result.entries).toEqual([
          { path: "a", kind: "directory" },
          { path: "a/b.txt", kind: "file" },
          { path: "a/c", kind: "directory" },
          { path: "a/c/d.txt", kind: "file" },
          { path: "ya", kind: "file" },
        ]);
        expect(result.entries.some((entry) => entry.path.startsWith(".arc"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );
  });
});
