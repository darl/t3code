import * as ArcanumCli from "./ArcanumCli.ts";
import * as ArcanumSourceControlProvider from "./ArcanumSourceControlProvider.ts";
import * as ArcanumPullRequestApi from "../pullRequest/ArcanumPullRequestApi.ts";
import * as ArcanumPullRequestProvider from "../pullRequest/ArcanumPullRequestProvider.ts";
import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import {
  sourceControlDefinitions,
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
} from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("t3/sourceControl/builtInDrivers/SourceControlDrivers") {}

const make = Effect.gen(function* () {
  const drivers: Array<SourceControlDriverEntry> = yield* Effect.forEach(
    BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
    (driver) => driver.make.pipe(Effect.map((instance) => ({ driver, instance }))),
  );
  const definition = sourceControlDefinitions.get("arcanum");
  drivers.push({
    driver: { kind: definition.kind, definition },
    instance: {
      sourceControl: yield* ArcanumSourceControlProvider.make,
      pullRequests: yield* ArcanumPullRequestProvider.make,
      discovery: ArcanumSourceControlProvider.discovery,
    },
  });
  return drivers;
});

export const layer = Layer.effect(SourceControlDrivers, make).pipe(
  Layer.provide(ArcanumPullRequestApi.layer),
  Layer.provide(ArcanumCli.layer),
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
