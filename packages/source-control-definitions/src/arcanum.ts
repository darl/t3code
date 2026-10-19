import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/source-control-core/shared/definition";

const HOST = "a.yandex-team.ru";
const KIND = SourceControlProviderKind.make("arcanum");

function reviewNumber(reference: string): string | null {
  const input = reference.trim();
  if (/^\d+$/u.test(input)) return input;
  try {
    const url = new URL(input);
    return url.hostname === HOST
      ? (/^\/review\/(\d+)(?:\/.*)?$/u.exec(url.pathname)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

export const arcanumDefinition = defineSourceControl({
  ...UNKNOWN_SOURCE_CONTROL_CLIENT,
  kind: KIND,
  label: "Arcanum",
  pickerLabel: "Arcanum",
  icon: null,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "arcadia",
  publicHost: "arcadia",
  publishDescription: HOST,
  publishHost: () => HOST,
  changeRequestUrl: ({ number }) => `https://${HOST}/review/${number}`,
  changeRequestActions: new Set(["close", "ready"] as const),
  checkoutCommand: ({ number }) => `arc pr checkout ${number}`,
  checkoutCommandArgument: (input) =>
    /^arc\s+pr\s+checkout\s+(.+)$/u.exec(input.trim())?.[1]?.trim() ?? null,
  isChangeRequestReference: (reference) => reviewNumber(reference) !== null,
  parseChangeRequestUrl: (url) => {
    const number = reviewNumber(url.toString());
    return number === null
      ? null
      : {
          host: "arcadia",
          repository: "arcadia",
          number: Number(number),
          repositoryUrl: "arc://arcadia/arcadia",
        };
  },
  recognizeRemote: ({ hostname }) =>
    hostname === "arcadia" || hostname === HOST || hostname.includes("arcanum")
      ? { kind: KIND, name: "Arcanum", baseUrl: `https://${HOST}` }
      : null,
  canonicalRepositoryKey: (key) =>
    key === "arcadia/arcadia" || key === `${HOST}/arcadia` ? "arcadia/arcadia" : null,
  repositoryKeyFromRemote: (remote) =>
    remote === "arc://arcadia/arcadia" ? "arcadia/arcadia" : null,
  changeRequestHost: () => "arcadia",
  checkoutChangeRequestHost: (identity) =>
    identity.canonicalKey === "arcadia/arcadia" ? "arcadia" : null,
  isChangeRequestInRepository: (identity, link) =>
    identity.canonicalKey === "arcadia/arcadia" &&
    link.host === "arcadia" &&
    link.repository === "arcadia",
  canReadChangeRequestOnHost: (identity, link) =>
    identity.canonicalKey === "arcadia/arcadia" &&
    link.host === "arcadia" &&
    link.repository === "arcadia",
});
