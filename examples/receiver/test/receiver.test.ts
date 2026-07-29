import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { expect, test } from "bun:test"
import { Effect } from "effect"

import { makeReferenceReceiver } from "../src/receiver.js"

interface Exchange {
  readonly name: string
  readonly request: {
    readonly body: unknown
    readonly headers: Readonly<Record<string, string>>
    readonly method: string
    readonly path: string
  }
  readonly response: {
    readonly body: unknown
    readonly status: number
  }
}

interface Conformance {
  readonly exchanges: ReadonlyArray<Exchange>
}

const loadConformance = async (): Promise<Conformance> =>
  JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../../../docs/destination-conformance.json"),
      "utf8",
    ),
  ) as Conformance

const execute = (baseUrl: string, exchange: Exchange, body = exchange.request.body) =>
  fetch(`${baseUrl}${exchange.request.path}`, {
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    headers: exchange.request.headers,
    method: exchange.request.method,
  })

test("implements every conformance exchange and preserves exact token values", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* makeReferenceReceiver({
          bearerToken: "mocked-lumen-token",
        })
        const conformance = yield* Effect.promise(loadConformance)

        const assertConformancePass = Effect.fn("ReceiverExample.assertConformancePass")(function* (
          prefix: string,
        ) {
          for (const exchange of conformance.exchanges) {
            const label = `${prefix}${exchange.name}`
            const response = yield* Effect.promise(() => execute(receiver.url, exchange))
            expect(response.status, label).toBe(exchange.response.status)
            expect(yield* Effect.promise(() => response.json()), label).toEqual(
              exchange.response.body,
            )
          }
        })
        for (const prefix of ["", "replay "]) {
          yield* assertConformancePass(prefix)
        }

        const snapshot = yield* receiver.snapshot
        expect(snapshot.liveUsage).toHaveLength(1)
        expect(snapshot.liveUsage[0]?.tokens.input).toBe(11)
        expect(snapshot.liveUsage[0]?.tokens.output).toBe(3)
        expect(snapshot.committedDaily).toHaveLength(1)
        expect(snapshot.committedDaily[0]?.snapshots[0]?.tokens.input).toBe(11)
        expect(snapshot.committedDaily[0]?.snapshots[0]?.tokens.output).toBe(3)

        const live = conformance.exchanges.find(
          (exchange) => exchange.name === "put-live-snapshots",
        )
        if (live === undefined || typeof live.request.body !== "object") {
          throw new Error("live conformance exchange is missing")
        }
        const newerLiveBody = structuredClone(live.request.body) as {
          costs: Array<{
            estimatedCostNanoUsd: number
            revision: number
          }>
          snapshots: Array<{
            revision: number
            tokens: { input: number; output: number }
          }>
        }
        const newerSnapshot = newerLiveBody.snapshots[0]
        if (newerSnapshot === undefined) throw new Error("live exchange contains no snapshots")
        newerSnapshot.revision = 2
        newerSnapshot.tokens.input = 20
        newerSnapshot.tokens.output = 6
        const newerCost = newerLiveBody.costs[0]
        if (newerCost === undefined) throw new Error("live exchange contains no costs")
        newerCost.estimatedCostNanoUsd = 250_000_000
        newerCost.revision = 2
        expect(
          (yield* Effect.promise(() => execute(receiver.url, live, newerLiveBody))).status,
        ).toBe(200)
        expect((yield* Effect.promise(() => execute(receiver.url, live))).status).toBe(200)
        const revised = yield* receiver.snapshot
        expect(revised.liveUsage).toHaveLength(1)
        expect(revised.liveUsage[0]?.revision).toBe(2)
        expect(revised.liveUsage[0]?.tokens.input).toBe(20)
        expect(revised.liveUsage[0]?.tokens.output).toBe(6)
        expect(revised.liveCosts).toHaveLength(1)
        expect(revised.liveCosts[0]?.revision).toBe(2)
        expect(revised.liveCosts[0]?.estimatedCostNanoUsd).toBe(250_000_000)

        const upload = conformance.exchanges.find(
          (exchange) => exchange.name === "put-daily-snapshots",
        )
        if (upload === undefined || typeof upload.request.body !== "object") {
          throw new Error("daily upload conformance exchange is missing")
        }
        const conflictingBody = structuredClone(upload.request.body) as {
          snapshots: Array<{ tokens: { output: number } }>
        }
        const first = conflictingBody.snapshots[0]
        if (first === undefined) throw new Error("daily upload contains no snapshots")
        first.tokens.output += 1
        const conflict = yield* Effect.promise(() => execute(receiver.url, upload, conflictingBody))
        expect(conflict.status).toBe(409)

        const start = conformance.exchanges.find((exchange) => exchange.name === "start-daily-sync")
        if (start === undefined || typeof start.request.body !== "object") {
          throw new Error("daily start conformance exchange is missing")
        }
        const conflictingStart = structuredClone(start.request.body) as {
          snapshotCount: number
        }
        conflictingStart.snapshotCount += 1
        expect(
          (yield* Effect.promise(() => execute(receiver.url, start, conflictingStart))).status,
        ).toBe(409)

        const wrongCountUpload = structuredClone(upload.request.body) as {
          snapshots: Array<unknown>
        }
        wrongCountUpload.snapshots = []
        expect(
          (yield* Effect.promise(() => execute(receiver.url, upload, wrongCountUpload))).status,
        ).toBe(409)

        const missingSync = "687ae2d9-d4f2-422e-876b-f620bdd34f20"
        expect(
          (yield* Effect.promise(() =>
            fetch(`${receiver.url}/v1/usage-syncs/${missingSync}/snapshots`, {
              body: JSON.stringify(upload.request.body),
              headers: upload.request.headers,
              method: "PUT",
            }),
          )).status,
        ).toBe(404)
        expect(
          (yield* Effect.promise(() =>
            fetch(`${receiver.url}/v1/usage-syncs/${missingSync}/commit`, {
              headers: upload.request.headers,
              method: "POST",
            }),
          )).status,
        ).toBe(409)

        const unauthorized = yield* Effect.promise(() =>
          fetch(`${receiver.url}/v1/usage/otel-snapshots`, {
            body: "{}",
            headers: { "content-type": "application/json" },
            method: "PUT",
          }),
        )
        expect(unauthorized.status).toBe(401)

        const malformed = yield* Effect.promise(() =>
          fetch(`${receiver.url}/v1/usage/otel-snapshots`, {
            body: "{}",
            headers: {
              authorization: "Bearer mocked-lumen-token",
              "content-type": "application/json",
            },
            method: "PUT",
          }),
        )
        expect(malformed.status).toBe(400)

        const invalidJson = yield* Effect.promise(() =>
          fetch(`${receiver.url}/v1/usage/otel-snapshots`, {
            body: "{",
            headers: {
              authorization: "Bearer mocked-lumen-token",
              "content-type": "application/json",
            },
            method: "PUT",
          }),
        )
        expect(invalidJson.status).toBe(400)
      }),
    ),
  )
})

test("awaits server shutdown before releasing its Effect scope", async () => {
  const port = await Effect.runPromise(
    Effect.scoped(
      makeReferenceReceiver({
        bearerToken: "mocked-lumen-token",
      }).pipe(Effect.map((receiver) => Number(new URL(receiver.url).port))),
    ),
  )

  const reboundPort = await Effect.runPromise(
    Effect.scoped(
      makeReferenceReceiver({
        bearerToken: "mocked-lumen-token",
        port,
      }).pipe(Effect.map((receiver) => Number(new URL(receiver.url).port))),
    ),
  )

  expect(reboundPort).toBe(port)
})
