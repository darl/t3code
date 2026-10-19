import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
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

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out and puts the user's instructions above the limits", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
        instructions: "Prefix every title with the team name.",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
      expect(prompt).not.toContain("fewer than 40 characters");
      expect(prompt).toContain("Title instructions from the user:\nPrefix every title");
    }
    expect(buildThreadTitlePrompt({ message: "Fix login", instructions: " " }).prompt).toContain(
      "3-8 words, fewer than 40 characters.",
    );
  });
});
