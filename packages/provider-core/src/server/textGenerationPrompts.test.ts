import { describe, expect, it } from "vite-plus/test";

import { normalizeCliError } from "./textGenerationUtils.ts";
import { buildReviewGuidePrompt } from "./textGenerationPrompts.ts";

describe("buildReviewGuidePrompt", () => {
  const input = {
    number: 42,
    title: "Add search",
    description: "",
    baseBranch: "main",
    baseCommit: "abc123",
    settledReview: "",
  };

  it("uses prepared evidence without asking the sandbox to retrieve Git data", () => {
    const { prompt } = buildReviewGuidePrompt({
      ...input,
      preparedChange: {
        patchPath: "/tmp/review evidence/change.patch",
        filesPath: "/tmp/review evidence/files.json",
      },
      stack: [
        { number: 41, title: "Index", headSha: "aaa111", state: "merged" },
        { number: 42, title: "Search", headSha: "bbb222", state: "open" },
      ],
    });
    expect(prompt).toContain('"/tmp/review evidence/change.patch"');
    expect(prompt).toContain('"/tmp/review evidence/files.json"');
    expect(prompt).toContain("old/new hunk headers for excerpt coordinates");
    expect(prompt).toContain("every changed file");
    expect(prompt).not.toContain("git diff");
    expect(prompt).not.toContain("git log");
    expect(prompt).not.toContain("git show");
  });
});

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});
