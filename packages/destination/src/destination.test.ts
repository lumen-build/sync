import { CredentialProvider, bearerCredentialLayer } from "@lumen-build/sync-auth"
import type { CcusageDailyBatch, OtelLiveBatch } from "@lumen-build/sync-contracts"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { it } from "@effect/vitest"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { expect } from "vitest"

import {
  Destination,
  DestinationUnavailable,
  InvalidDestinationConfiguration,
  InvalidDestinationResponse,
  layer,
  make,
} from "./index.js"

const deviceId = "ec7100cb-d60f-479a-a136-85327ec03f8b"
const syncId = "11236047-7ee3-4238-8157-f189bbc16927"
const mismatchedSyncId = "ca5269c0-799d-4f59-a8eb-0180705f75d0"
const snapshot = {
  agent: "codex" as const,
  day: "2026-07-29",
  model: "gpt-test",
  provider: "openai",
  tokens: {
    cacheCreationInput: 0,
    cacheReadInput: 2,
    input: 11,
    output: 3,
    reasoningOutput: 1,
    tool: 0,
  },
}

const liveBatch: OtelLiveBatch = {
  source: "otel-live",
  capturedAt: "2026-07-29T10:00:00.000Z",
  costs: [],
  deviceId,
  snapshots: [{ ...snapshot, revision: 1 }],
}

const dailyBatch: CcusageDailyBatch = {
  source: "ccusage-daily",
  capturedAt: "2026-07-29T11:00:00.000Z",
  costs: [],
  deviceId,
  snapshots: [snapshot],
  sourceVersion: "20.0.19",
  syncId,
  timeZone: "UTC",
}

const server = Effect.acquireRelease(
  Effect.sync(() => {
    const current = setupServer()
    current.listen({ onUnhandledRequest: "error" })
    return current
  }),
  (current) => Effect.sync(() => current.close()),
)

it.effect("sends source-tagged batches to mocked lumen.build routes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* server
      const requests: Array<{ readonly authorization: string | null; readonly route: string }> = []
      const capture = ({ request }: { readonly request: Request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          route: `${request.method} ${new URL(request.url).pathname}`,
        })
      }

      current.use(
        http.put("https://usage.lumen.build/v1/usage/otel-snapshots", (context) => {
          capture(context)
          return HttpResponse.json({ accepted: 1 })
        }),
        http.put("https://usage.lumen.build/v1/usage-syncs/:syncId", (context) => {
          capture(context)
          return HttpResponse.json({ status: "pending", syncId: context.params.syncId })
        }),
        http.put("https://usage.lumen.build/v1/usage-syncs/:syncId/snapshots", (context) => {
          capture(context)
          return HttpResponse.json({ accepted: 1 })
        }),
        http.post("https://usage.lumen.build/v1/usage-syncs/:syncId/commit", (context) => {
          capture(context)
          return HttpResponse.json({ committed: 1 })
        }),
      )

      const destination = yield* Destination
      expect(yield* destination.putLive(liveBatch)).toBe(1)
      expect(yield* destination.syncDaily(dailyBatch)).toBe(1)
      expect(requests).toEqual([
        {
          authorization: "Bearer mocked-lumen-token",
          route: "PUT /v1/usage/otel-snapshots",
        },
        {
          authorization: "Bearer mocked-lumen-token",
          route: `PUT /v1/usage-syncs/${syncId}`,
        },
        {
          authorization: "Bearer mocked-lumen-token",
          route: `PUT /v1/usage-syncs/${syncId}/snapshots`,
        },
        {
          authorization: "Bearer mocked-lumen-token",
          route: `POST /v1/usage-syncs/${syncId}/commit`,
        },
      ])
    }).pipe(
      Effect.provide(layer({ baseUrl: "https://usage.lumen.build" })),
      Effect.provide(
        bearerCredentialLayer({
          token: Effect.succeed(Redacted.make("mocked-lumen-token")),
        }),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  ),
)

it.effect("rejects a mismatched start sync ID before uploading snapshots or committing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* server
      const requests: Array<string> = []
      const capture = ({ request }: { readonly request: Request }) => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`)
      }

      current.use(
        http.put("https://usage.lumen.build/v1/usage-syncs/:syncId", (context) => {
          capture(context)
          return HttpResponse.json({ status: "pending", syncId: mismatchedSyncId })
        }),
        http.put("https://usage.lumen.build/v1/usage-syncs/:syncId/snapshots", (context) => {
          capture(context)
          return HttpResponse.json({ accepted: 1 })
        }),
        http.post("https://usage.lumen.build/v1/usage-syncs/:syncId/commit", (context) => {
          capture(context)
          return HttpResponse.json({ committed: 1 })
        }),
      )

      const destination = yield* Destination
      const failure = yield* Effect.flip(destination.syncDaily(dailyBatch))

      expect(failure).toBeInstanceOf(InvalidDestinationResponse)
      expect(requests).toEqual([`PUT /v1/usage-syncs/${syncId}`])
    }).pipe(
      Effect.provide(layer({ baseUrl: "https://usage.lumen.build" })),
      Effect.provide(
        bearerCredentialLayer({
          token: Effect.succeed(Redacted.make("mocked-lumen-token")),
        }),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  ),
)

it.effect("rejects unsafe library base URLs before acquiring a bearer token", () =>
  Effect.gen(function* () {
    let tokenReads = 0
    const credentials = Layer.succeed(
      CredentialProvider,
      CredentialProvider.of({
        accessToken: () =>
          Effect.sync(() => {
            tokenReads += 1
            return Redacted.make("must-not-be-sent")
          }),
        login: () => Effect.void,
        logout: () => Effect.void,
      }),
    )
    const httpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unsafe destination must not execute a request")),
    )

    for (const baseUrl of [
      "http://usage.lumen.build",
      "https://user:password@usage.lumen.build",
      "https://usage.lumen.build?tenant=secret",
      "file:///tmp/receiver",
    ]) {
      const failure = yield* Effect.flip(
        make({ baseUrl }).pipe(Effect.provide(Layer.merge(credentials, httpClient))),
      )
      expect(failure).toBeInstanceOf(InvalidDestinationConfiguration)
    }
    expect(tokenReads).toBe(0)

    const local = yield* make({ baseUrl: "http://127.0.0.1:4318" }).pipe(
      Effect.provide(Layer.merge(credentials, httpClient)),
    )
    expect(local.baseUrl).toBe("http://127.0.0.1:4318")
    expect(tokenReads).toBe(0)
  }),
)

it.effect("times out while reading an incomplete successful response body", () =>
  Effect.gen(function* () {
    const destination = yield* Destination
    const fiber = yield* Effect.flip(destination.putLive(liveBatch)).pipe(Effect.forkChild)
    yield* TestClock.adjust("10 millis")
    const failure = yield* Fiber.join(fiber)
    expect(failure).toBeInstanceOf(DestinationUnavailable)
    if (!(failure instanceof DestinationUnavailable)) {
      throw new Error("expected DestinationUnavailable")
    }
    expect(failure.reason).toBe("request timed out")
  }).pipe(
    Effect.provide(layer({ baseUrl: "https://usage.lumen.build", timeout: "10 millis" })),
    Effect.provide(
      bearerCredentialLayer({
        token: Effect.succeed(Redacted.make("mocked-lumen-token")),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // Deliberately never close the body.
                },
              }),
              {
                headers: { "content-type": "application/json" },
                status: 200,
              },
            ),
          ),
        ),
      ),
    ),
  ),
)
