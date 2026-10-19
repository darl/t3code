import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Always false: this fork does not queue product telemetry. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      options?: { readonly anonymous?: boolean },
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

// Keep callers compatible with upstream without collecting identities or sending events.
export const layer = Layer.succeed(AnalyticsService, {
  record: Effect.fn("AnalyticsService.record")(() => Effect.succeed(false)),
  flush: Effect.void,
  recordOwners: Effect.fn("AnalyticsService.recordOwners")(() => Effect.void),
});
