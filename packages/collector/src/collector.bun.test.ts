import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"

import { Collector, collectorLayer, startServer } from "./index.js"

const servers: Array<Bun.Server<undefined>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

test("serves OTLP on an explicitly configured loopback address", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const collector = yield* Collector
      const server = startServer({
        collector,
        hostname: "127.0.0.1",
        port: 0,
      })
      servers.push(server)

      const response = yield* Effect.tryPromise(() =>
        fetch(`http://127.0.0.1:${server.port}/v1/logs`, {
          body: JSON.stringify({ resourceLogs: [] }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      )

      expect(response.status).toBe(200)
      const json = yield* Effect.tryPromise(() => response.json())
      expect(json).toEqual({})
    }).pipe(
      Effect.provide(
        collectorLayer({
          deviceId: "ec7100cb-d60f-479a-a136-85327ec03f8b",
          maxBodyBytes: 1_000_000,
        }),
      ),
    ),
  )
})
