import { timingSafeEqual } from "node:crypto"

import { OtelLiveBatch, SyncId } from "@lumen-build/sync/contracts"
import { Effect, Schema, Scope } from "effect"

import { DailyStart, DailyUpload } from "./protocol.js"
import { makeReceiverStore, type ReceiverSnapshot, type ReceiverStore } from "./store.js"

export interface ReferenceReceiver {
  readonly snapshot: Effect.Effect<ReceiverSnapshot>
  readonly url: string
}

export interface ReferenceReceiverOptions {
  readonly bearerToken: string
  readonly port?: number
}

export class ReferenceReceiverError extends Schema.TaggedError<ReferenceReceiverError>()(
  "ReferenceReceiverError",
  {
    reason: Schema.String,
  },
) {}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

const authorized = (request: Request, expectedToken: Buffer): boolean => {
  const authorization = request.headers.get("authorization")
  if (authorization === null || !authorization.startsWith("Bearer ")) return false
  const actual = Buffer.from(authorization.slice("Bearer ".length))
  return actual.byteLength === expectedToken.byteLength && timingSafeEqual(actual, expectedToken)
}

const decodeBody = <A>(request: Request, schema: Schema.Codec<A, unknown, never, unknown>) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new ReferenceReceiverError({ reason: "request body is not valid JSON" }),
  }).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(schema, {
        onExcessProperty: "error",
      }),
    ),
  )

const makeHandler = (
  bearerToken: string,
  store: ReceiverStore,
): ((request: Request) => Promise<Response>) => {
  const expectedToken = Buffer.from(bearerToken)
  const handle = Effect.fn("ReferenceReceiver.handle")(function* (request: Request) {
    if (!authorized(request, expectedToken)) return json({ error: "unauthorized" }, 401)

    const url = new URL(request.url)
    if (request.method === "PUT" && url.pathname === "/v1/usage/otel-snapshots") {
      const decoded = yield* Effect.result(decodeBody(request, OtelLiveBatch))
      if (decoded._tag === "Failure") return json({ error: "invalid live batch" }, 400)
      return json({ accepted: yield* store.putLive(decoded.success) })
    }

    const match = /^\/v1\/usage-syncs\/([^/]+)(?:\/(snapshots|commit))?$/.exec(url.pathname)
    const syncId = match?.[1]
    const action = match?.[2]
    if (syncId === undefined || !Schema.is(SyncId)(syncId)) {
      return json({ error: "not found" }, 404)
    }

    if (request.method === "PUT" && action === undefined) {
      const decoded = yield* Effect.result(decodeBody(request, DailyStart))
      if (decoded._tag === "Failure") return json({ error: "invalid daily start" }, 400)
      return (yield* store.startDaily(syncId, decoded.success)) === "conflict"
        ? json({ error: "sync ID already has different metadata" }, 409)
        : json({ status: "pending", syncId })
    }

    if (request.method === "PUT" && action === "snapshots") {
      const decoded = yield* Effect.result(decodeBody(request, DailyUpload))
      if (decoded._tag === "Failure") return json({ error: "invalid daily upload" }, 400)
      const status = yield* store.uploadDaily(syncId, decoded.success)
      if (status === "missing") return json({ error: "daily sync has not been started" }, 404)
      return status === "conflict"
        ? json({ error: "sync ID already has different records" }, 409)
        : json({ accepted: decoded.success.snapshots.length })
    }

    if (request.method === "POST" && action === "commit") {
      const result = yield* store.commitDaily(syncId)
      return result.kind === "missing"
        ? json({ error: "daily sync has no staged records" }, 409)
        : json({ committed: result.committed })
    }

    return json({ error: "not found" }, 404)
  })

  return (request) =>
    Effect.runPromise(
      handle(request).pipe(
        Effect.catchCause(() => Effect.succeed(json({ error: "internal error" }, 500))),
      ),
    )
}

export const makeReferenceReceiver = ({
  bearerToken,
  port = 0,
}: ReferenceReceiverOptions): Effect.Effect<
  ReferenceReceiver,
  ReferenceReceiverError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (bearerToken.length === 0) {
        return yield* new ReferenceReceiverError({ reason: "bearer token must not be empty" })
      }
      const store = yield* makeReceiverStore
      const server = yield* Effect.try({
        try: () =>
          Bun.serve({
            fetch: makeHandler(bearerToken, store),
            hostname: "127.0.0.1",
            port,
          }),
        catch: (cause) =>
          new ReferenceReceiverError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      return {
        server,
        value: {
          snapshot: store.snapshot,
          url: `http://127.0.0.1:${server.port}`,
        } satisfies ReferenceReceiver,
      }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map(({ value }) => value))
