import { describe, expect, it } from "vite-plus/test";

import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("Arcanum client", () => {
  it("recognizes review URLs and keeps arc checkout commands", () => {
    const client = sourceControlClients.get("arcanum");
    expect(client.label).toBe("Arcanum");
    expect(
      client.changeRequestUrl({ host: "a.yandex-team.ru", repository: "arcadia", number: 42 }),
    ).toBe("https://a.yandex-team.ru/review/42");
    expect(
      sourceControlClients.findByChangeRequestUrl("https://a.yandex-team.ru/review/42/diff")?.kind,
    ).toBe("arcanum");
    expect(client.isChangeRequestReference("https://example.com/review/42")).toBe(false);
    expect(client.checkoutCommand({ number: 42, headBranch: "feature" })).toBe(
      "arc pr checkout 42",
    );
    expect(client.checkoutCommandArgument("arc pr checkout 42")).toBe("42");
    expect(client.checkoutCommandArgument("gh pr checkout 42")).toBeNull();
    const link = parseChangeRequestUrl("https://a.yandex-team.ru/review/42")!;
    const identity = {
      canonicalKey: "arcadia/arcadia",
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "arcadia" },
      displayName: "arcadia",
    };
    expect(client.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(client.canReadChangeRequestOnHost(identity, link)).toBe(true);
    expect(client.checkoutChangeRequestHost(identity)).toBe("arcadia");
    expect(client.changeRequestUrlHost(new URL("https://a.yandex-team.ru/review/42"))).toBe(
      "arcadia",
    );
    expect(client.isChangeRequestInRepository(identity, { ...link, host: "github.com" })).toBe(
      false,
    );
  });
});
