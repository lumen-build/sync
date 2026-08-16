import type {
  CcusageDailyBatch,
  OtelLiveBatch,
  OtelUsageSnapshot,
} from "@lumen-build/sync-contracts"
import {
  CcusageDailyBatch as CcusageDailyBatchSchema,
  OtelLiveBatch as OtelLiveBatchSchema,
  usageSnapshotKey,
} from "@lumen-build/sync-contracts"
import { Effect, Queue, Ref, Schema } from "effect"

export class MockDestinationError extends Schema.TaggedError<MockDestinationError>()(
  "MockDestinationError",
  {
    reason: Schema.String,
  },
) {}

export interface CapturedRequest {
  readonly authorization: string | null
  readonly body: unknown
  readonly method: string
  readonly path: string
  readonly status: number
}

export interface MockDestination {
  readonly canonicalSnapshots: Effect.Effect<ReadonlyArray<OtelUsageSnapshot>>
  readonly dailyBatches: Effect.Effect<ReadonlyArray<CcusageDailyBatch>>
  readonly failNextDailyCommit: (count?: number) => Effect.Effect<void>
  readonly failNextLive: (count?: number) => Effect.Effect<void>
  readonly liveBatches: Effect.Effect<ReadonlyArray<OtelLiveBatch>>
  readonly requests: Effect.Effect<ReadonlyArray<CapturedRequest>>
  readonly takeLive: Effect.Effect<OtelLiveBatch, MockDestinationError>
  readonly url: string
}

const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { status })

export const mockDestination = Effect.acquireRelease(
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<CapturedRequest>>([])
    const batches = yield* Ref.make<ReadonlyArray<OtelLiveBatch>>([])
    const canonical = yield* Ref.make<ReadonlyMap<string, OtelUsageSnapshot>>(new Map())
    const dailyBatches = yield* Ref.make<ReadonlyArray<CcusageDailyBatch>>([])
    const dailyStarts = yield* Ref.make<ReadonlyMap<string, unknown>>(new Map())
    const failDailyCommit = yield* Ref.make(0)
    const failLive = yield* Ref.make(0)
    const accepted = yield* Queue.unbounded<OtelLiveBatch>()

    const server = Bun.serve({
      fetch: async (request) => {
        const url = new URL(request.url)
        const body = await request.json().catch(() => undefined)
        let status = 404
        let response: Response

        if (request.method === "PUT" && url.pathname === "/v1/usage/otel-snapshots") {
          const remaining = await Effect.runPromise(
            Ref.getAndUpdate(failLive, (count) => Math.max(0, count - 1)),
          )
          if (remaining > 0) {
            status = 503
            response = jsonResponse({ error: "temporarily unavailable" }, status)
          } else {
            const batch = await Effect.runPromise(
              Schema.decodeUnknownEffect(OtelLiveBatchSchema)(body).pipe(
                Effect.mapError((cause) => new MockDestinationError({ reason: cause.message })),
              ),
            )
            await Effect.runPromise(
              Ref.update(canonical, (current) => {
                const next = new Map(current)
                for (const snapshot of batch.snapshots) {
                  const key = usageSnapshotKey(snapshot)
                  const previous = next.get(key)
                  if (previous === undefined || snapshot.revision >= previous.revision) {
                    next.set(key, snapshot)
                  }
                }
                return next
              }),
            )
            await Effect.runPromise(Ref.update(batches, (values) => [...values, batch]))
            await Effect.runPromise(Queue.offer(accepted, batch))
            status = 200
            response = jsonResponse({ accepted: batch.snapshots.length })
          }
        } else {
          const dailyRoute = /^\/v1\/usage-syncs\/([^/]+)(?:\/(snapshots|commit))?$/.exec(
            url.pathname,
          )
          const syncId = dailyRoute?.[1]
          const action = dailyRoute?.[2]
          if (syncId !== undefined && request.method === "PUT" && action === undefined) {
            await Effect.runPromise(
              Ref.update(dailyStarts, (current) => new Map(current).set(syncId, body)),
            )
            status = 200
            response = jsonResponse({ status: "pending", syncId })
          } else if (syncId !== undefined && request.method === "PUT" && action === "snapshots") {
            const start = await Effect.runPromise(Ref.get(dailyStarts)).then((values) =>
              values.get(syncId),
            )
            const batch = await Effect.runPromise(
              Schema.decodeUnknownEffect(CcusageDailyBatchSchema)({
                ...(typeof start === "object" && start !== null ? start : {}),
                ...(typeof body === "object" && body !== null ? body : {}),
                syncId,
              }).pipe(
                Effect.mapError((cause) => new MockDestinationError({ reason: cause.message })),
              ),
            )
            await Effect.runPromise(Ref.update(dailyBatches, (values) => [...values, batch]))
            status = 200
            response = jsonResponse({ accepted: batch.snapshots.length })
          } else if (syncId !== undefined && request.method === "POST" && action === "commit") {
            const remaining = await Effect.runPromise(
              Ref.getAndUpdate(failDailyCommit, (count) => Math.max(0, count - 1)),
            )
            const batch = (await Effect.runPromise(Ref.get(dailyBatches))).findLast(
              (candidate) => candidate.syncId === syncId,
            )
            status = 200
            response =
              remaining > 0
                ? jsonResponse({ error: "commit response lost" })
                : jsonResponse({ committed: batch?.snapshots.length ?? 0 })
          } else {
            response = jsonResponse({ error: "not found" }, status)
          }
        }

        await Effect.runPromise(
          Ref.update(requests, (values) => [
            ...values,
            {
              authorization: request.headers.get("authorization"),
              body,
              method: request.method,
              path: url.pathname,
              status,
            },
          ]),
        )
        return response
      },
      hostname: "127.0.0.1",
      port: 0,
    })

    return {
      public: {
        canonicalSnapshots: Ref.get(canonical).pipe(Effect.map((values) => [...values.values()])),
        dailyBatches: Ref.get(dailyBatches),
        failNextDailyCommit: (count = 1) => Ref.set(failDailyCommit, count),
        failNextLive: (count = 1) => Ref.set(failLive, count),
        liveBatches: Ref.get(batches),
        requests: Ref.get(requests),
        takeLive: Queue.take(accepted).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () =>
              Effect.fail(new MockDestinationError({ reason: "timed out waiting for live batch" })),
          }),
        ),
        url: `http://${server.hostname}:${server.port}`,
      } satisfies MockDestination,
      shutdown: Effect.sync(() => server.stop(true)),
    }
  }),
  ({ shutdown }) => shutdown,
).pipe(Effect.map(({ public: value }) => value))
