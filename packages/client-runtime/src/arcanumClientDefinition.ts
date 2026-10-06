import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/source-control-core/client/definition";

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

export const arcanumClientDefinition = defineSourceControlClient({
  ...UNKNOWN_SOURCE_CONTROL_CLIENT,
  kind: KIND,
  label: "Arcanum",
  pickerLabel: "Arcanum",
  icon: "arcanum",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
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
  changeRequestUrlHost: () => "arcadia",
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
  isChangeRequestUrl: (reference) =>
    /^https?:/u.test(reference) && reviewNumber(reference) !== null,
});
