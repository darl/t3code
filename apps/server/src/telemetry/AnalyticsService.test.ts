import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("never sends product telemetry in this fork even when enabled", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      assert.isFalse(yield* analytics.record("test.fork-disabled", { model: "test" }));
      assert.isFalse(
        yield* analytics.record("agent.feedback", { subject: "test" }, { anonymous: true }),
      );
      yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
      yield* analytics.recordOwners([{ source: "device", ownerId: "b".repeat(64) }], "client");
      yield* analytics.flush;
      yield* TestClock.adjust("1 minute");
    }).pipe(
      Effect.provide(AnalyticsService.layer),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_TELEMETRY_HOST: "https://ingest.t3.codes",
          T3CODE_TELEMETRY_KEY: "test-key",
        }),
      ),
      Effect.scoped,
    );
    assert.deepEqual(requests, []);
  }),
);
