// @effect-diagnostics nodeBuiltinImport:off
/**
 * ArcadiaWorkspaceEntries - Arcadia (arc VCS) backends for workspace search.
 *
 * The fff FileFinder index cannot scan an Arcadia workspace: arc working
 * copies are FUSE mounts of the whole monorepo (millions of lazily
 * materialized files), so the index scan always hits its deadline and the
 * file picker, content search and file browser stay broken. These backends
 * answer the same RPCs with Arcadia-native tools instead:
 *
 *   - searchEntries  -> `ya grep --remote` file-listing mode (Fast Code
 *     Search over trunk, ~1s for the whole tree), merged with locally
 *     changed files from `arc status` so uncommitted work is findable.
 *   - searchContents -> `ya grep --remote` content mode; locally modified
 *     files are re-grepped from the working copy so fresh edits win over
 *     the trunk index.
 *   - listEntries    -> budgeted breadth-first readdir of the mount itself.
 *
 * Never enumerate the full tree (e.g. `arc ls-files` at the mount root): it
 * runs for minutes and read-locks the arc daemon for its whole duration.
 * Fast Code Search queries and `arc status` do not touch the daemon's index
 * lock, and the readdir walk is bounded by entry and time budgets.
 */
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { isWholeWordRange, WorkspaceSearchIndexSearchFailed } from "./WorkspaceSearchIndex.ts";

const ARCADIA_MARKER_DIRECTORY = ".arc";
const YA_TOOL_FILENAME = "ya";

const FCS_TIMEOUT_MS = 20_000;
const ARC_STATUS_TIMEOUT_MS = 30_000;
const FCS_MAX_OUTPUT_BYTES = 4_000_000;
// Directory-kind results are derived from matched file paths, so the file
// fetch needs a healthy sample even when the caller's limit is small.
const FCS_FILE_FETCH_MIN = 200;
const CONTENT_OVERLAY_MAX_FILES = 200;
const CONTENT_OVERLAY_MAX_FILE_BYTES = 1_000_000;
const CONTENT_MAX_MATCHES_PER_FILE = 100;
const LIST_MAX_ENTRIES = 25_000;
const LIST_TIME_BUDGET_MS = 3_000;

// --- pure helpers (exported for tests) --------------------------------------

/**
 * Build a Fast Code Search path regexp from a picker query: literal
 * characters with case-insensitivity via character classes (FCS has no
 * case-insensitive flag for path matching), whitespace as a fuzzy gap.
 * The output is also a valid JavaScript regexp, so the same pattern filters
 * locally changed paths.
 */
export function fuzzyPathRegexp(query: string): string {
  let out = "";
  for (const character of query) {
    if (/\s/.test(character)) {
      if (!out.endsWith(".*")) out += ".*";
      continue;
    }
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    out +=
      lower === upper ? character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : `[${lower}${upper}]`;
  }
  return out;
}

export function escapeContentRegexp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `ya grep` ends its stdout with a `Total: N (revision: rX)` trailer; a `+`
 * after the count means the `-m` limit cut the result set short.
 */
const FCS_TOTAL_LINE = /^Total: \d+(\+?) \(revision: r\d+\)$/;

export function parseFcsFileListing(stdout: string): {
  readonly paths: string[];
  readonly hasMore: boolean;
} {
  const paths: string[] = [];
  let hasMore = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const total = FCS_TOTAL_LINE.exec(trimmed);
    if (total) {
      hasMore = total[1] === "+";
      break;
    }
    paths.push(trimmed);
  }
  return { paths, hasMore };
}

export interface FcsContentMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
}

const FCS_CONTENT_LINE = /^(.+?):(\d+):(.*)$/;

export function parseFcsContentMatches(stdout: string): {
  readonly matches: FcsContentMatch[];
  readonly hasMore: boolean;
} {
  const matches: FcsContentMatch[] = [];
  let hasMore = false;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const total = FCS_TOTAL_LINE.exec(line.trimEnd());
    if (total) {
      hasMore = total[1] === "+";
      break;
    }
    const match = FCS_CONTENT_LINE.exec(line);
    if (!match) continue;
    matches.push({
      path: match[1]!,
      lineNumber: Number.parseInt(match[2]!, 10),
      lineContent: match[3]!,
    });
  }
  return { matches, hasMore };
}

/**
 * `arc status --json` paths are Arcadia-root-relative regardless of cwd.
 * Re-root them to the workspace; entries outside the workspace are dropped.
 */
export function parseArcStatusEntries(stdoutJson: string, workspacePrefix: string): ProjectEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutJson);
  } catch {
    return [];
  }
  const status = (parsed as { status?: Record<string, unknown> } | null)?.status;
  if (!status || typeof status !== "object") return [];

  const entries: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const section of Object.values(status)) {
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      const rootRelativePath = (item as { path?: unknown } | null)?.path;
      const type = (item as { type?: unknown } | null)?.type;
      if (typeof rootRelativePath !== "string" || !rootRelativePath) continue;
      const workspaceRelative = toWorkspaceRelative(rootRelativePath, workspacePrefix);
      if (workspaceRelative === null || seen.has(workspaceRelative)) continue;
      seen.add(workspaceRelative);
      entries.push({
        path: workspaceRelative,
        kind: type === "directory" ? "directory" : "file",
      });
    }
  }
  return entries;
}

function toWorkspaceRelative(rootRelativePath: string, workspacePrefix: string): string | null {
  if (workspacePrefix === "") return rootRelativePath;
  return rootRelativePath.startsWith(`${workspacePrefix}/`)
    ? rootRelativePath.slice(workspacePrefix.length + 1)
    : null;
}

export function ancestorDirectories(filePaths: ReadonlyArray<string>): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    let separatorIndex = filePath.indexOf("/");
    while (separatorIndex !== -1) {
      const directory = filePath.slice(0, separatorIndex);
      if (!seen.has(directory)) {
        seen.add(directory);
        directories.push(directory);
      }
      separatorIndex = filePath.indexOf("/", separatorIndex + 1);
    }
  }
  return directories;
}

export function computeMatchRanges(
  lineContent: string,
  matcher: RegExp,
  wholeWord: boolean,
): Array<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  matcher.lastIndex = 0;
  let match = matcher.exec(lineContent);
  while (match !== null && ranges.length < CONTENT_MAX_MATCHES_PER_FILE) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
    } else {
      const range = { start: match.index, end: match.index + match[0].length };
      if (!wholeWord || isWholeWordRange(lineContent, range)) ranges.push(range);
    }
    match = matcher.exec(lineContent);
  }
  return ranges;
}

// --- service ----------------------------------------------------------------

export interface ArcadiaSearchInput {
  readonly cwd: string;
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly kind?: ProjectEntryKind;
}

export interface ArcadiaSearchContentsInput {
  readonly cwd: string;
  readonly root: string;
  readonly input: Omit<ProjectSearchContentsInput, "cwd">;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const arcadiaRootCache = new Map<string, string | null>();

  /** Walk up from the workspace root to the arc mount root (`.arc` marker). */
  const detectRoot = Effect.fn("ArcadiaWorkspaceEntries.detectRoot")(function* (cwd: string) {
    const cached = arcadiaRootCache.get(cwd);
    if (cached !== undefined) return cached;
    let directory = cwd;
    let root: string | null = null;
    for (;;) {
      const markerExists = yield* fileSystem
        .exists(path.join(directory, ARCADIA_MARKER_DIRECTORY))
        .pipe(Effect.orElseSucceed(() => false));
      if (markerExists) {
        root = directory;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    arcadiaRootCache.set(cwd, root);
    return root;
  });

  const searchFailure = (input: {
    readonly cwd: string;
    readonly queryLength: number;
    readonly pageSize: number;
    readonly reason: string;
    readonly cause?: unknown;
  }) => new WorkspaceSearchIndexSearchFailed(input);

  const runYaGrep = Effect.fn("ArcadiaWorkspaceEntries.runYaGrep")(function* (input: {
    readonly cwd: string;
    readonly root: string;
    readonly args: ReadonlyArray<string>;
    readonly queryLength: number;
    readonly pageSize: number;
  }) {
    return yield* vcsProcess
      .run({
        operation: "ArcadiaWorkspaceEntries.yaGrep",
        command: path.join(input.root, YA_TOOL_FILENAME),
        args: ["grep", "--remote", "--no-colors", ...input.args],
        cwd: input.cwd,
        allowNonZeroExit: true,
        timeoutMs: FCS_TIMEOUT_MS,
        maxOutputBytes: FCS_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError((cause) =>
          searchFailure({
            cwd: input.cwd,
            queryLength: input.queryLength,
            pageSize: input.pageSize,
            reason: "ya grep --remote failed to run.",
            cause,
          }),
        ),
      );
  });

  /** Locally changed/untracked entries; degrades to empty on any failure. */
  const arcStatusEntries = Effect.fn("ArcadiaWorkspaceEntries.arcStatusEntries")(function* (
    cwd: string,
    root: string,
  ) {
    const workspacePrefix = path.relative(root, cwd).replaceAll("\\", "/");
    return yield* vcsProcess
      .run({
        operation: "ArcadiaWorkspaceEntries.arcStatus",
        command: "arc",
        args: ["status", "--json"],
        cwd,
        timeoutMs: ARC_STATUS_TIMEOUT_MS,
        maxOutputBytes: FCS_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.map((output) => parseArcStatusEntries(output.stdout, workspacePrefix)),
        Effect.tapCause((cause) =>
          Effect.logWarning("arc status failed; skipping local entries overlay", { cwd, cause }),
        ),
        Effect.orElseSucceed((): ProjectEntry[] => []),
      );
  });

  const search = Effect.fn("ArcadiaWorkspaceEntries.search")(function* (
    input: ArcadiaSearchInput,
  ): Effect.fn.Return<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed> {
    const localEntries = yield* arcStatusEntries(input.cwd, input.root);

    // Empty query: the picker's initial view. There is no frecency index for
    // Arcadia, so locally changed files are the "recent files" stand-in.
    if (input.query === "") {
      const entries = filterEntriesByKind(localEntries, input.kind).slice(0, input.limit);
      return { entries, truncated: false };
    }

    const pattern = fuzzyPathRegexp(input.query);
    const matcher = new RegExp(pattern);
    const fetchLimit = Math.max(input.limit + 1, FCS_FILE_FETCH_MIN);
    const output = yield* runYaGrep({
      cwd: input.cwd,
      root: input.root,
      args: ["-f", pattern, "-m", String(fetchLimit)],
      queryLength: input.query.length,
      pageSize: input.limit,
    });
    const listing = parseFcsFileListing(output.stdout);
    if (output.exitCode !== 0 && listing.paths.length === 0 && !/Total:/.test(output.stdout)) {
      return yield* searchFailure({
        cwd: input.cwd,
        queryLength: input.query.length,
        pageSize: input.limit,
        reason: `ya grep --remote exited with code ${output.exitCode}: ${firstLine(output.stderr)}`,
      });
    }

    const matchingLocal = localEntries.filter((entry) => matcher.test(entry.path));
    const localPaths = new Set(matchingLocal.map((entry) => entry.path));
    const trunkFiles: ProjectEntry[] = listing.paths
      .filter((filePath) => !localPaths.has(filePath))
      .map((filePath) => ({ path: filePath, kind: "file" }));

    const files = [...matchingLocal.filter((entry) => entry.kind === "file"), ...trunkFiles];
    const directories = [
      ...matchingLocal.filter((entry) => entry.kind === "directory"),
      ...ancestorDirectories(listing.paths)
        .filter((directory) => !localPaths.has(directory) && matcher.test(directory))
        .map((directory): ProjectEntry => ({ path: directory, kind: "directory" })),
    ];

    const candidates =
      input.kind === "file"
        ? files
        : input.kind === "directory"
          ? directories
          : [...files, ...directories];
    return {
      entries: candidates.slice(0, input.limit),
      truncated: listing.hasMore || candidates.length > input.limit,
    };
  });

  const grepLocalFile = Effect.fn("ArcadiaWorkspaceEntries.grepLocalFile")(function* (
    cwd: string,
    relativePath: string,
    matcher: RegExp,
    wholeWord: boolean,
  ) {
    const stat = yield* fileSystem.stat(path.join(cwd, relativePath));
    if (stat.type !== "File" || stat.size > BigInt(CONTENT_OVERLAY_MAX_FILE_BYTES)) return [];
    const contents = yield* fileSystem.readFileString(path.join(cwd, relativePath));
    if (contents.includes("\0")) return [];
    const matches: ProjectSearchContentsResult["matches"][number][] = [];
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lineContent = lines[index]!.replace(/\r$/, "");
      const matchRanges = computeMatchRanges(lineContent, matcher, wholeWord);
      if (matchRanges.length === 0) continue;
      matches.push({ path: relativePath, lineNumber: index + 1, lineContent, matchRanges });
      if (matches.length >= CONTENT_MAX_MATCHES_PER_FILE) break;
    }
    return matches;
  });

  const searchContents = Effect.fn("ArcadiaWorkspaceEntries.searchContents")(function* ({
    cwd,
    root,
    input,
  }: ArcadiaSearchContentsInput): Effect.fn.Return<
    ProjectSearchContentsResult,
    WorkspaceSearchIndexSearchFailed
  > {
    const pattern = input.useRegex ? input.query : escapeContentRegexp(input.query);
    const built = buildContentMatcher(pattern, input.caseSensitive);
    const matcher = built.matcher;
    const regexFallbackError = built.error;

    const output = yield* runYaGrep({
      cwd,
      root,
      args: [
        ...(input.caseSensitive ? [] : ["-i"]),
        ...(input.wholeWord ? ["-w"] : []),
        "-m",
        String(input.limit),
        pattern,
      ],
      queryLength: input.query.length,
      pageSize: input.limit,
    });
    const parsed = parseFcsContentMatches(output.stdout);
    if (output.exitCode !== 0 && parsed.matches.length === 0 && !/Total:/.test(output.stdout)) {
      // Fast Code Search rejected the pattern (typically an unsupported
      // regex). Surface it the way the fff backend does: no matches plus a
      // regex fallback error, rather than a failed RPC.
      if (input.useRegex) {
        return {
          matches: [],
          truncated: false,
          regexFallbackError: regexFallbackError ?? firstLine(output.stderr),
        };
      }
      return yield* searchFailure({
        cwd,
        queryLength: input.query.length,
        pageSize: input.limit,
        reason: `ya grep --remote exited with code ${output.exitCode}: ${firstLine(output.stderr)}`,
      });
    }

    // The trunk index is stale for locally modified files; re-grep those from
    // the working copy and let the local matches replace the trunk ones.
    const localEntries = yield* arcStatusEntries(cwd, root);
    const localFilePaths = localEntries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path)
      .slice(0, CONTENT_OVERLAY_MAX_FILES);
    const localFileSet = new Set(localFilePaths);

    const localMatches: ProjectSearchContentsResult["matches"][number][] = [];
    if (matcher !== null) {
      for (const relativePath of localFilePaths) {
        const fileMatches = yield* grepLocalFile(cwd, relativePath, matcher, input.wholeWord).pipe(
          Effect.orElseSucceed((): ProjectSearchContentsResult["matches"][number][] => []),
        );
        localMatches.push(...fileMatches);
        if (localMatches.length >= input.limit) break;
      }
    }

    const lineMatcher = matcher;
    const trunkMatches = parsed.matches
      .filter((match) => !localFileSet.has(match.path))
      .map((match) => ({
        path: match.path,
        lineNumber: match.lineNumber,
        lineContent: match.lineContent,
        matchRanges:
          lineMatcher === null
            ? [{ start: 0, end: match.lineContent.length }]
            : computeMatchRanges(match.lineContent, lineMatcher, input.wholeWord),
      }))
      .filter((match) => match.matchRanges.length > 0);

    const combined = [...localMatches, ...trunkMatches];
    return {
      matches: combined.slice(0, input.limit),
      truncated: parsed.hasMore || combined.length > input.limit,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  });

  /**
   * Bounded breadth-first walk of the mount for the file browser: the top of
   * the tree completes within the budgets; deeper levels are reported as
   * truncated instead of scanning millions of virtual files.
   */
  const list = Effect.fn("ArcadiaWorkspaceEntries.list")(function* (
    cwd: string,
  ): Effect.fn.Return<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed> {
    const deadline = performance.now() + LIST_TIME_BUDGET_MS;
    const entries: ProjectEntry[] = [];
    const queue: string[] = [""];
    let truncated = false;

    while (queue.length > 0) {
      if (entries.length >= LIST_MAX_ENTRIES || performance.now() >= deadline) {
        truncated = true;
        break;
      }
      const relativeDirectory = queue.shift()!;
      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(path.join(cwd, relativeDirectory), { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceSearchIndexSearchFailed({
            cwd,
            queryLength: 0,
            pageSize: LIST_MAX_ENTRIES,
            reason: `Failed to read workspace directory '${relativeDirectory}'.`,
            cause,
          }),
      }).pipe(Effect.orElseSucceed(() => []));

      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${dirent.name}`
          : dirent.name;
        if (dirent.isDirectory()) {
          entries.push({ path: relativePath, kind: "directory" });
          queue.push(relativePath);
        } else {
          entries.push({ path: relativePath, kind: "file" });
        }
        if (entries.length >= LIST_MAX_ENTRIES) break;
      }
    }

    return {
      entries: entries.toSorted((left, right) => left.path.localeCompare(right.path)),
      truncated,
    };
  });

  return { detectRoot, list, search, searchContents };
});

function buildContentMatcher(
  pattern: string,
  caseSensitive: boolean,
): { readonly matcher: RegExp | null; readonly error?: string } {
  try {
    return { matcher: new RegExp(pattern, caseSensitive ? "g" : "gi") };
  } catch (error) {
    return { matcher: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function filterEntriesByKind(
  entries: ReadonlyArray<ProjectEntry>,
  kind: ProjectEntryKind | undefined,
): ProjectEntry[] {
  return kind === undefined ? [...entries] : entries.filter((entry) => entry.kind === kind);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
