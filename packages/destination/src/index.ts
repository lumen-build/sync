import { CredentialProvider, type CredentialError } from "@lumen-build/sync-auth"
import { NetworkUrl } from "@lumen-build/sync-config"
import {
  type CcusageDailyBatch,
  DailySyncCommittedResponse,
  type DailySyncStartRequest,
  DailySyncStartedResponse,
  type DailySyncUploadRequest,
  type OtelLiveBatch,
  UsageAcceptedResponse,
} from "@lumen-build/sync-contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export class DestinationUnavailable extends Schema.TaggedError<DestinationUnavailable>()(
  "DestinationUnavailable",
  {
    reason: Schema.String,
  },
) {}

export class DestinationRejected extends Schema.TaggedError<DestinationRejected>()(
  "DestinationRejected",
  {
    status: Schema.Number,
  },
) {}

export class InvalidDestinationResponse extends Schema.TaggedError<InvalidDestinationResponse>()(
  "InvalidDestinationResponse",
  {
    reason: Schema.String,
  },
) {}

export class InvalidDestinationConfiguration extends Schema.TaggedError<InvalidDestinationConfiguration>()(
  "InvalidDestinationConfiguration",
  {
    reason: Schema.String,
  },
) {}

export type DestinationError =
  | CredentialError
  | DestinationRejected
  | DestinationUnavailable
  | InvalidDestinationResponse

export interface DestinationInterface {
  readonly baseUrl: string
  readonly putLive: (batch: OtelLiveBatch) => Effect.Effect<number, DestinationError>
  readonly syncDaily: (batch: CcusageDailyBatch) => Effect.Effect<number, DestinationError>
}

export class Destination extends Context.Service<Destination, DestinationInterface>()(
  "@lumen-build/sync/Destination",
) {}

export interface DestinationOptions {
  readonly baseUrl: string
  readonly timeout?: `${number} ${"millis" | "seconds"}`
}

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "")

const validateBaseUrl = Effect.fn("Destination.validateBaseUrl")(function* (baseUrl: string) {
  const decoded = yield* Schema.decodeUnknownEffect(NetworkUrl)(baseUrl).pipe(
    Effect.mapError(
      () =>
        new InvalidDestinationConfiguration({
          reason: "base URL must use HTTPS or HTTP loopback and must not contain credentials",
        }),
    ),
  )
  const url = new URL(decoded)
  if (url.search.length > 0 || url.hash.length > 0) {
    return yield* new InvalidDestinationConfiguration({
      reason: "base URL must not contain a query or fragment",
    })
  }
  return normalizeBaseUrl(url.toString())
})

const authenticated = (
  request: HttpClientRequest.HttpClientRequest,
  token: import("effect").Redacted.Redacted<string>,
) => HttpClientRequest.bearerToken(request, token)

export const make = Effect.fn("Destination.make")(function* ({
  baseUrl,
  timeout = "5 seconds",
}: DestinationOptions) {
  const origin = yield* validateBaseUrl(baseUrl)
  const client = yield* HttpClient.HttpClient
  const credentials = yield* CredentialProvider

  const execute = Effect.fn("Destination.execute")(function* <A>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, unknown, never, unknown>,
  ) {
    return yield* Effect.gen(function* () {
      const response = yield* client
        .execute(HttpClientRequest.acceptJson(request))
        .pipe(Effect.mapError(() => new DestinationUnavailable({ reason: "request failed" })))
      if (response.status < 200 || response.status >= 300) {
        return yield* new DestinationRejected({ status: response.status })
      }
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(
          (error) =>
            new InvalidDestinationResponse({
              reason: error.message,
            }),
        ),
      )
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new DestinationUnavailable({ reason: "request timed out" })),
      }),
    )
  })

  const withJsonBody = <A>(request: HttpClientRequest.HttpClientRequest, body: A) =>
    HttpClientRequest.bodyJson(request, body).pipe(
      Effect.mapError(
        (error) =>
          new InvalidDestinationResponse({
            reason: error.message,
          }),
      ),
    )

  const putLive = Effect.fn("Destination.putLive")(function* (batch: OtelLiveBatch) {
    const token = yield* credentials.accessToken()
    const request = yield* withJsonBody(
      authenticated(HttpClientRequest.put(`${origin}/v1/usage/otel-snapshots`), token),
      batch,
    )
    return (yield* execute(request, UsageAcceptedResponse)).accepted
  })

  const syncDaily = Effect.fn("Destination.syncDaily")(function* (batch: CcusageDailyBatch) {
    const token = yield* credentials.accessToken()
    const startBody = {
      capturedAt: batch.capturedAt,
      costSnapshotCount: batch.costs.length,
      deviceId: batch.deviceId,
      snapshotCount: batch.snapshots.length,
      source: batch.source,
      sourceVersion: batch.sourceVersion,
      timeZone: batch.timeZone,
    } satisfies DailySyncStartRequest
    const start = yield* withJsonBody(
      authenticated(HttpClientRequest.put(`${origin}/v1/usage-syncs/${batch.syncId}`), token),
      startBody,
    )
    const started = yield* execute(start, DailySyncStartedResponse)
    if (started.syncId !== batch.syncId) {
      return yield* new InvalidDestinationResponse({
        reason: "start response sync ID does not match request",
      })
    }

    const uploadBody = {
      costs: batch.costs,
      snapshots: batch.snapshots,
      source: batch.source,
    } satisfies DailySyncUploadRequest
    const snapshots = yield* withJsonBody(
      authenticated(
        HttpClientRequest.put(`${origin}/v1/usage-syncs/${batch.syncId}/snapshots`),
        token,
      ),
      uploadBody,
    )
    yield* execute(snapshots, UsageAcceptedResponse)

    return (yield* execute(
      authenticated(
        HttpClientRequest.post(`${origin}/v1/usage-syncs/${batch.syncId}/commit`),
        token,
      ),
      DailySyncCommittedResponse,
    )).committed
  })

  return Destination.of({
    baseUrl: origin,
    putLive,
    syncDaily,
  })
})

export const layer = (options: DestinationOptions) => Layer.effect(Destination, make(options))
