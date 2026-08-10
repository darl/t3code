import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as ArcanumCli from "../sourceControl/ArcanumCli.ts";
import * as ArcanumPullRequestApi from "./ArcanumPullRequestApi.ts";

const BASE = "https://arcanum.test.local/api";
const PR_URL = "https://a.yandex-team.ru/review/123456";
const BASE_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const DETAIL_FIELDS =
  "url,author,summary,description,approvers,assignees,tickets,vcs,created_at,updated_at,closed_at,status,labels,merge_allowed,attention_required";
const ENRICHMENT_FIELDS = "checks,status,active_diff_set(id,patch_stats(additions,deletions))";
const SEARCH_FIELDS =
  "review_requests(id,url,author(name),summary,vcs(from_branch,to_branch),created_at,updated_at,status,full_status,labels(name),assignees(user(name)),active_diff_set(patch_stats(additions,deletions)))";

const mockedExecute = vi.fn<ArcanumCli.ArcanumCli["Service"]["execute"]>();
const mockedHttp =
  vi.fn<
    (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
  >();

function makeLayer(env: Record<string, string>) {
  return ArcanumPullRequestApi.layer.pipe(
    Layer.provide(Layer.mock(ArcanumCli.ArcanumCli)({ execute: mockedExecute })),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => mockedHttp(request)),
      ),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provideMerge(NodeServices.layer),
  );
}

const layer = it.layer(makeLayer({ T3CODE_ARCANUM_API_BASE_URL: BASE, ARC_TOKEN: "test-token" }));

function output(stdout: string, stdoutTruncated = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
  };
}

function json(request: HttpClientRequest.HttpClientRequest, payload: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Answers by path, so a test states what each endpoint says rather than a call order. */
function respondByUrl(routes: ReadonlyArray<readonly [match: string, payload: unknown]>) {
  mockedHttp.mockImplementation((request) => {
    const route = routes.find(([match]) => request.url.includes(match));
    return Effect.succeed(json(request, route === undefined ? { data: {} } : route[1]));
  });
}

function cliCallAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

function httpCallAt(index: number) {
  const call = mockedHttp.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

/** The JSON document a request carried, read back out of its encoded body. */
function bodyOfCall(index: number): unknown {
  const body = httpCallAt(index).body;
  if (body._tag !== "Uint8Array") {
    return assert.fail(`expected an encoded body, got ${body._tag}`);
  }
  return JSON.parse(new TextDecoder().decode(body.body));
}

function listRow(overrides: Record<string, unknown> = {}): string {
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

/** One search-endpoint row with the fields the listing asks for. */
function searchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    url: PR_URL,
    summary: "paths: tighten the family engines",
    author: { name: "alice" },
    vcs: { from_branch: "users/alice/feature-x", to_branch: "trunk" },
    status: "published",
    full_status: "open",
    ...overrides,
  };
}

function searchPage(entries: ReadonlyArray<unknown>): unknown {
  return { data: { review_requests: entries } };
}

afterEach(() => {
  mockedExecute.mockReset();
  mockedHttp.mockReset();
});

layer("ArcanumPullRequestApi.layer", (it) => {
  it.effect("reads the viewer from arc user-info's effective login", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("Login: alice\nEffective login: alice\nToken login: bob\n")),
      );
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const viewer = yield* api.getViewer({ cwd: "/w/arcadia" });

      assert.strictEqual(viewer, "alice");
      expect(cliCallAt(0)).toMatchObject({ cwd: "/w/arcadia" });
      expect(cliCallAt(0).args).toEqual(["user-info"]);
    }),
  );

  it.effect("falls back to the token login where no effective login is printed", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("Token login: bob\n")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      assert.strictEqual(yield* api.getViewer({ cwd: "/w/arcadia" }), "bob");
    }),
  );

  it.effect("fails when arc names no login at all", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("nothing useful\n")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const error = yield* Effect.flip(api.getViewer({ cwd: "/w/arcadia" }));

      assert.strictEqual(error._tag, "ArcanumViewerUnavailableError");
    }),
  );

  it.effect("lists authored open pull requests through the search endpoint", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/v1/review-requests?", searchPage([searchRow(), searchRow({ id: 123457 })])],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const batch = yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "open",
        involvement: "authored",
        viewer: "alice",
        limit: 30,
      });

      assert.strictEqual(batch.items.length, 2);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 2);
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
      // Atoms join with ";" (AND); one row past the page answers whether more remain.
      assert.strictEqual(
        httpCallAt(0).url,
        `${BASE}/v1/review-requests?query=${encodeURIComponent(
          "author(alice);open()",
        )}&fields=${SEARCH_FIELDS}&limit=31&offset=0&order=-updated_at`,
      );
    }),
  );

  it.effect("asks for discarded pull requests on the closed tab, assigned to the reviewer", () =>
    Effect.gen(function* () {
      respondByUrl([["/v1/review-requests?", searchPage([])]]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "closed",
        involvement: "reviewing",
        viewer: "bob",
        limit: 20,
      });

      assert.strictEqual(
        httpCallAt(0).url,
        `${BASE}/v1/review-requests?query=${encodeURIComponent(
          "assignee(bob);discarded()",
        )}&fields=${SEARCH_FIELDS}&limit=21&offset=0&order=-updated_at`,
      );
    }),
  );

  it.effect("asks the whole-host feed with no query atom at all on All/all", () =>
    Effect.gen(function* () {
      respondByUrl([["/v1/review-requests?", searchPage([])]]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "all",
        involvement: "all",
        viewer: "alice",
        limit: 20,
      });

      // No state atom spans the states, and no user atom is the whole-host feed.
      assert.strictEqual(
        httpCallAt(0).url,
        `${BASE}/v1/review-requests?fields=${SEARCH_FIELDS}&limit=21&offset=0&order=-updated_at`,
      );
    }),
  );

  it.effect("keeps the CLI road for merged, which the search grammar has no atom for", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`${listRow({ status: "merged" })}\n`)),
      );
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const batch = yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "merged",
        involvement: "authored",
        viewer: "alice",
        limit: 20,
      });

      assert.strictEqual(batch.items.length, 1);
      assert.strictEqual(batch.cursorAdvance, undefined);
      assert.strictEqual(mockedHttp.mock.calls.length, 0);
      expect(cliCallAt(0)).toMatchObject({ cwd: "/w/arcadia" });
      expect(cliCallAt(0).args).toEqual([
        "pr",
        "list",
        "--json",
        "--sort",
        "date",
        "-l",
        "21",
        "-S",
        "merged",
        "-A",
        "alice",
      ]);
    }),
  );

  it.effect("carries on from a cursor by asking the search endpoint at its offset", () =>
    Effect.gen(function* () {
      respondByUrl([
        [
          "/v1/review-requests?",
          searchPage(Array.from({ length: 3 }, (_, index) => searchRow({ id: 123460 + index }))),
        ],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const batch = yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 2,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 40 },
      });

      expect(httpCallAt(0).url).toContain("&limit=3&offset=40&");
      assert.strictEqual(batch.items.length, 2);
      // The extra row is more results; the offset advances by the rows consumed, not asked.
      assert.isTrue(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 2);
    }),
  );

  it.effect("steps the offset past a malformed row rather than re-reading it forever", () =>
    Effect.gen(function* () {
      respondByUrl([
        [
          "/v1/review-requests?",
          searchPage([{ id: "nope" }, searchRow(), searchRow({ id: 123457 })]),
        ],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const batch = yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([123456, 123457]);
      // Three raw rows were consumed to deliver two, and the cursor has to step past all three.
      assert.strictEqual(batch.cursorAdvance, 3);
      assert.isFalse(batch.truncated);
    }),
  );

  it.effect("skips an undecodable JSONL line on the merged road rather than failing it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`garbage\n${listRow({ status: "merged" })}\n`)),
      );
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const batch = yield* api.listPullRequests({
        cwd: "/w/arcadia",
        state: "merged",
        involvement: "all",
        viewer: "alice",
        limit: 20,
      });

      expect(batch.items.map((item) => item.number)).toEqual([123456]);
    }),
  );

  it.effect("reads one pull request's status by number", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(`${listRow()}\n`)));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const status = yield* api.getPullRequestStatus({ cwd: "/w/arcadia", number: 123456 });

      assert.strictEqual(status.number, 123456);
      expect(cliCallAt(0).args).toEqual(["pr", "status", "123456", "--json"]);
    }),
  );

  it.effect("fails the status read when arc answers with something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not json")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const error = yield* Effect.flip(
        api.getPullRequestStatus({ cwd: "/w/arcadia", number: 123456 }),
      );

      assert.strictEqual(error._tag, "ArcanumCliDecodeError");
    }),
  );

  it.effect("reads the detail once, with the verified field list and an OAuth header", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/v2/pull-requests/", { data: { description: "Body.", author: { name: "alice" } } }],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const detail = yield* api.getPullRequestDetail({ number: 123456 });

      assert.strictEqual(detail.body, "Body.");
      // One request and no fallback: Arcanum silently ignores unknown field names.
      assert.strictEqual(mockedHttp.mock.calls.length, 1);
      const request = httpCallAt(0);
      assert.strictEqual(request.method, "GET");
      assert.strictEqual(request.url, `${BASE}/v2/pull-requests/123456?fields=${DETAIL_FIELDS}`);
      // Presence only: the token itself never appears in an assertion, an error, or a log.
      assert.isDefined(request.headers.authorization);
    }),
  );

  it.effect("reads the enrichment from the v1 entity by its exact path", () =>
    Effect.gen(function* () {
      respondByUrl([
        [
          "/v1/review-requests/123456?",
          {
            data: {
              status: "draft",
              checks: [{ system: "CI", type: "build", status: "success" }],
              active_diff_set: { id: 777, patch_stats: { additions: 5, deletions: 1 } },
            },
          },
        ],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const enrichment = yield* api.getPullRequestEnrichment({ number: 123456 });

      expect(enrichment).toMatchObject({ isDraft: true, additions: 5, deletions: 1 });
      expect(enrichment.checks.map((check) => [check.name, check.status])).toEqual([
        ["build", "success"],
      ]);
      assert.strictEqual(
        httpCallAt(0).url,
        `${BASE}/v1/review-requests/123456?fields=${ENRICHMENT_FIELDS}`,
      );
    }),
  );

  it.effect("carries the host's own message on a refusal, and never the token", () =>
    Effect.gen(function* () {
      mockedHttp.mockImplementationOnce((request) =>
        Effect.succeed(
          json(
            request,
            { errors: [{ status: "404", message: "reviewRequest 123456 not found" }] },
            404,
          ),
        ),
      );
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const error = yield* Effect.flip(api.getPullRequestDetail({ number: 123456 }));

      if (error._tag !== "ArcanumResponseError") {
        return assert.fail(`expected an ArcanumResponseError, got ${error._tag}`);
      }
      assert.strictEqual(error.status, 404);
      assert.strictEqual(error.detail, "Arcanum returned HTTP 404: reviewRequest 123456 not found");
      expect(error.message).not.toContain("test-token");
    }),
  );

  it.effect("reports a failure whose body is not the errors shape by its status alone", () =>
    Effect.gen(function* () {
      mockedHttp.mockImplementationOnce((request) => Effect.succeed(json(request, {}, 500)));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const error = yield* Effect.flip(api.getPullRequestDetail({ number: 123456 }));

      if (error._tag !== "ArcanumResponseError") {
        return assert.fail(`expected an ArcanumResponseError, got ${error._tag}`);
      }
      assert.strictEqual(error.status, 500);
      assert.strictEqual(error.detail, "Arcanum returned HTTP 500.");
      assert.strictEqual(mockedHttp.mock.calls.length, 1);
      expect(error.message).not.toContain("test-token");
    }),
  );

  it.effect("reads the active diff and the changelist by their exact paths", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
        ["/changelist", { data: [{ path: "project/lib/util.ts", entry_id: 41 }] }],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const diff = yield* api.getActiveDiff({ number: 123456 });
      const changelist = yield* api.getChangelist({ number: 123456, diffId: diff.id });

      expect(diff).toEqual({ id: "777", base: BASE_SHA, merge: MERGE_SHA });
      expect(changelist).toEqual([{ path: "project/lib/util.ts", entryId: 41, sourcePath: null }]);
      expect(httpCallAt(0).url).toBe(
        `${BASE}/v1/pull-requests/123456/active-diff?fields=commit_ids(base,merge),id`,
      );
      expect(httpCallAt(1).url).toBe(
        `${BASE}/v1/review-requests/123456/diff-sets/777/changelist?fields=path,entry_id,source(path)`,
      );
    }),
  );

  it.effect("reads the conversation from the public comments endpoint", () =>
    Effect.gen(function* () {
      respondByUrl([
        [
          "/comments",
          { data: [{ id: 10, content: "Looks close.", created_at: "2026-07-01T10:00:00Z" }] },
        ],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const activity = yield* api.listActivity({ number: 123456, url: PR_URL });

      assert.strictEqual(activity.commentCount, 1);
      expect(httpCallAt(0).url).toBe(`${BASE}/v1/public/review-requests/123456/comments`);
    }),
  );

  it.effect("diffs the active diff's server revisions with arc, bounded like a diff", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
      ]);
      const patch = "--- project/lib/util.ts\n+++ project/lib/util.ts\n@@ -1 +1 @@\n-a\n+b\n";
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(patch, true)));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const diff = yield* api.getDiff({ cwd: "/w/arcadia", number: 123456 });

      assert.strictEqual(diff.patch, patch);
      // The truncation flag is the process runner's own, which is the only honest one here.
      assert.isTrue(diff.truncated);
      expect(cliCallAt(0)).toMatchObject({ cwd: "/w/arcadia", maxOutputBytes: 8 * 1024 * 1024 });
      expect(cliCallAt(0).args).toEqual(["diff", BASE_SHA, MERGE_SHA]);
    }),
  );

  it.effect("shows both sides of a changed file at the server revisions", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
      ]);
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(output(`contents of ${input.args[1] ?? ""}`)),
      );
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const contents = yield* api.getDiffFileContents({
        cwd: "/w/arcadia",
        number: 123456,
        changeType: "change",
        oldPath: "project/lib/util.ts",
        newPath: "project/lib/util.ts",
      });

      expect(contents).toEqual({
        oldContents: `contents of ${BASE_SHA}:project/lib/util.ts`,
        newContents: `contents of ${MERGE_SHA}:project/lib/util.ts`,
      });
      const argvs = mockedExecute.mock.calls.map((call) => call[0].args);
      expect(argvs).toContainEqual(["show", `${BASE_SHA}:project/lib/util.ts`]);
      expect(argvs).toContainEqual(["show", `${MERGE_SHA}:project/lib/util.ts`]);
    }),
  );

  it.effect("never asks for the side a new file does not have", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
      ]);
      mockedExecute.mockImplementation(() => Effect.succeed(output("new contents")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const contents = yield* api.getDiffFileContents({
        cwd: "/w/arcadia",
        number: 123456,
        changeType: "new",
        oldPath: "project/lib/util.ts",
        newPath: "project/lib/util.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "new contents" });
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(cliCallAt(0).args).toEqual(["show", `${MERGE_SHA}:project/lib/util.ts`]);
    }),
  );

  it.effect("tolerates arc show failing on a side and answers it as empty", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
      ]);
      mockedExecute
        .mockReturnValueOnce(
          Effect.fail(
            new ArcanumCli.ArcanumCliCommandError({
              operation: "execute",
              command: "arc",
              cwd: "/w/arcadia",
              cause: new Error("no such path at revision"),
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("new contents")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const contents = yield* api.getDiffFileContents({
        cwd: "/w/arcadia",
        number: 123456,
        changeType: "change",
        oldPath: "project/lib/util.ts",
        newPath: "project/lib/util.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "new contents" });
    }),
  );

  it.effect("discards by number, which is how Arcanum closes", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.discard({ cwd: "/w/arcadia", number: 123456 });

      expect(cliCallAt(0).args).toEqual(["pr", "discard", "123456"]);
    }),
  );

  it.effect("publishes a draft by number", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.publish({ cwd: "/w/arcadia", number: 123456 });

      expect(cliCallAt(0).args).toEqual(["pr", "publish", "123456"]);
    }),
  );

  it.effect("posts a comment as a published, non-draft document", () =>
    Effect.gen(function* () {
      respondByUrl([]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.comment({ number: 123456, body: "Ship note." });

      const request = httpCallAt(0);
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, `${BASE}/v1/review-requests/123456/comments`);
      expect(bodyOfCall(0)).toEqual({ content: "Ship note.", draft: false });
    }),
  );

  it.effect("replies to a thread by the root comment's own id", () =>
    Effect.gen(function* () {
      respondByUrl([]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.replyToThread({ threadId: "9001", body: "Fixed." });

      const request = httpCallAt(0);
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, `${BASE}/v1/public/review-requests-comments/9001/replies`);
      expect(bodyOfCall(0)).toEqual({ content: "Fixed.", draft: false });
    }),
  );

  it.effect("resolves and reopens a thread by patching its issue status", () =>
    Effect.gen(function* () {
      respondByUrl([]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.setThreadResolution({ threadId: "9001", resolved: true });
      yield* api.setThreadResolution({ threadId: "9001", resolved: false });

      assert.strictEqual(httpCallAt(0).method, "PATCH");
      assert.strictEqual(httpCallAt(0).url, `${BASE}/v1/public/review-requests-comments/9001`);
      expect(bodyOfCall(0)).toEqual({ issue_status: "resolved" });
      expect(bodyOfCall(1)).toEqual({ issue_status: "open" });
    }),
  );

  it.effect("replays a review as line comments first and the verdict-bearing summary last", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
        ["/changelist", { data: [{ path: "project/lib/util.ts", entry_id: 41 }] }],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.submitReview({
        number: 123456,
        verdict: "request-changes",
        body: "Overall notes.",
        comments: [{ path: "project/lib/util.ts", line: 12, side: "right", body: "tighten this" }],
      });

      const urls = mockedHttp.mock.calls.map((call) => call[0].url);
      expect(urls).toEqual([
        `${BASE}/v1/pull-requests/123456/active-diff?fields=commit_ids(base,merge),id`,
        `${BASE}/v1/review-requests/123456/diff-sets/777/changelist?fields=path,entry_id,source(path)`,
        `${BASE}/v1/review-requests/123456/comments`,
        `${BASE}/v1/review-requests/123456/comments`,
      ]);
      // Request-changes IS open issues on Arcanum, so the line comment carries one.
      expect(bodyOfCall(2)).toEqual({
        content: "tighten this",
        draft: false,
        file_path: "project/lib/util.ts",
        entry_id: 41,
        diff_line: 12,
        diff_size: 1,
        diff_set_xid: "777",
        diff_side: "new",
        issue_status: "open",
      });
      // The summary goes last, so a review that failed part-way never stands as a verdict —
      // and with a line comment carrying the issue, the summary carries none of its own.
      expect(bodyOfCall(3)).toEqual({ content: "Overall notes.", draft: false });
    }),
  );

  it.effect("writes a comment-verdict review with no issue status anywhere", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
        ["/changelist", { data: [{ path: "project/lib/util.ts", entry_id: "41" }] }],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.submitReview({
        number: 123456,
        verdict: "comment",
        body: "",
        comments: [{ path: "project/lib/util.ts", line: 3, side: "left", body: "why remove?" }],
      });

      // A blank summary posts nothing of its own.
      assert.strictEqual(mockedHttp.mock.calls.length, 3);
      expect(bodyOfCall(2)).toEqual({
        content: "why remove?",
        draft: false,
        file_path: "project/lib/util.ts",
        // The entry id round-trips exactly as the changelist spelled it.
        entry_id: "41",
        diff_line: 3,
        diff_size: 1,
        diff_set_xid: "777",
        diff_side: "old",
      });
    }),
  );

  it.effect("resolves a moved file through the changelist's source path", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
        [
          "/changelist",
          {
            data: [
              {
                path: "project/lib/moved.ts",
                entry_id: 43,
                change_type: "move",
                source: { path: "project/lib/before.ts" },
              },
            ],
          },
        ],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.submitReview({
        number: 123456,
        verdict: "comment",
        body: "",
        comments: [
          {
            // A draft whose paths came from a differently spelled diff still lands: its old
            // name matches the entry's source.path.
            path: "project/lib/after.ts",
            oldPath: "project/lib/before.ts",
            line: 5,
            side: "right",
            body: "carried over?",
          },
        ],
      });

      expect(bodyOfCall(2)).toMatchObject({
        file_path: "project/lib/after.ts",
        entry_id: 43,
      });
    }),
  );

  it.effect("refuses the whole review before posting anything when a path is unknown", () =>
    Effect.gen(function* () {
      respondByUrl([
        ["/active-diff", { data: { id: 777, commit_ids: { base: BASE_SHA, merge: MERGE_SHA } } }],
        ["/changelist", { data: [{ path: "project/lib/other.ts", entry_id: 44 }] }],
      ]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      const error = yield* Effect.flip(
        api.submitReview({
          number: 123456,
          verdict: "comment",
          body: "Notes that must not post.",
          comments: [
            { path: "project/lib/util.ts", line: 12, side: "right", body: "tighten this" },
          ],
        }),
      );

      if (error._tag !== "ArcanumReviewPathError") {
        return assert.fail(`expected an ArcanumReviewPathError, got ${error._tag}`);
      }
      expect(error.detail).toContain("project/lib/util.ts");
      // The two reads happened; nothing was written.
      const methods = mockedHttp.mock.calls.map((call) => call[0].method);
      expect(methods).toEqual(["GET", "GET"]);
    }),
  );

  it.effect("hangs the verdict on the summary when a review has no line comments", () =>
    Effect.gen(function* () {
      respondByUrl([]);
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;

      yield* api.submitReview({
        number: 123456,
        verdict: "request-changes",
        body: "Please split this up.",
        comments: [],
      });

      // No line comments means no active-diff or changelist read either.
      assert.strictEqual(mockedHttp.mock.calls.length, 1);
      expect(bodyOfCall(0)).toEqual({
        content: "Please split this up.",
        draft: false,
        issue_status: "open",
      });
    }),
  );
});

/** A scoped home directory whose `.arc/token` holds exactly `contents`, or nothing at all. */
const temporaryHome = (contents: string | null) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-arcanum-home-" });
    if (contents !== null) {
      yield* fileSystem.makeDirectory(path.join(home, ".arc"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(home, ".arc", "token"), contents);
    }
    return home;
  });

it.effect("fails every HTTP method while no token could be resolved, without a request", () =>
  Effect.gen(function* () {
    const home = yield* temporaryHome(null);
    const error = yield* Effect.gen(function* () {
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;
      return yield* Effect.flip(api.getPullRequestDetail({ number: 123456 }));
      // No ARC_TOKEN, no ARC_TOKEN_PATH, and a HOME with no ~/.arc/token to read.
    }).pipe(Effect.provide(makeLayer({ T3CODE_ARCANUM_API_BASE_URL: BASE, HOME: home })));

    assert.strictEqual(error._tag, "ArcanumTokenMissingError");
    assert.strictEqual(mockedHttp.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("treats an empty token file as an absent token", () =>
  Effect.gen(function* () {
    const home = yield* temporaryHome("   \n");
    const error = yield* Effect.gen(function* () {
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;
      return yield* Effect.flip(api.getPullRequestDetail({ number: 123456 }));
    }).pipe(Effect.provide(makeLayer({ T3CODE_ARCANUM_API_BASE_URL: BASE, HOME: home })));

    assert.strictEqual(error._tag, "ArcanumTokenMissingError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads the token from $HOME/.arc/token when ARC_TOKEN is unset", () =>
  Effect.gen(function* () {
    const home = yield* temporaryHome("file-token\n");
    mockedHttp.mockImplementation((request) => Effect.succeed(json(request, { data: {} })));
    yield* Effect.gen(function* () {
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;
      yield* api.getPullRequestDetail({ number: 123456 });
    }).pipe(Effect.provide(makeLayer({ T3CODE_ARCANUM_API_BASE_URL: BASE, HOME: home })));

    // Presence only, as everywhere: the header exists, and its value stays out of assertions.
    assert.isDefined(mockedHttp.mock.calls[0]?.[0].headers.authorization);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("prefers the file ARC_TOKEN_PATH names over the home fallback", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-arcanum-path-" });
    const tokenPath = path.join(dir, "named-token");
    yield* fileSystem.writeFileString(tokenPath, "named-file-token\n");
    mockedHttp.mockImplementation((request) => Effect.succeed(json(request, { data: {} })));
    yield* Effect.gen(function* () {
      const api = yield* ArcanumPullRequestApi.ArcanumPullRequestApi;
      yield* api.getPullRequestDetail({ number: 123456 });
    }).pipe(
      Effect.provide(makeLayer({ T3CODE_ARCANUM_API_BASE_URL: BASE, ARC_TOKEN_PATH: tokenPath })),
    );

    assert.isDefined(mockedHttp.mock.calls[0]?.[0].headers.authorization);
  }).pipe(Effect.provide(NodeServices.layer)),
);
