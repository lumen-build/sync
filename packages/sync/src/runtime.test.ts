import { CcusageCommand, CcusageImporter, importerLayer } from "@lumen-build/sync-ccusage"
import { Destination } from "@lumen-build/sync-destination"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { parseCollectorAddress, syncDaily } from "./runtime"

const report = JSON.stringify({
  daily: [
    {
      cacheCreationTokens: 0,
      cacheReadTokens: 1,
      date: "2026-07-29",
      inputTokens: 4,
      modelBreakdowns: [
        {
          cacheCreationTokens: 0,
          cacheReadTokens: 1,
          cost: 0.01,
          inputTokens: 4,
          modelName: "mocked-model",
          outputTokens: 2,
        },
      ],
      modelsUsed: ["mocked-model"],
      outputTokens: 2,
      totalCost: 0.01,
      totalTokens: 7,
    },
  ],
  totals: {
    cacheCreationTokens: 0,
    cacheReadTokens: 1,
    inputTokens: 4,
    outputTokens: 2,
    totalCost: 0.01,
    totalTokens: 7,
  },
})

it.effect("runs ccusage and commits source-tagged daily batches", () => {
  const command = Layer.succeed(
    CcusageCommand,
    CcusageCommand.of({
      runDaily: () => Effect.succeed({ stderr: "", stdout: report }),
    }),
  )
  const destination = Layer.succeed(
    Destination,
    Destination.of({
      baseUrl: "https://usage.lumen.build",
      putLive: () => Effect.succeed(0),
      syncDaily: (batch) => {
        expect(batch.source).toBe("ccusage-daily")
        expect(batch.timeZone).toBe("UTC")
        return Effect.succeed(batch.snapshots.length)
      },
    }),
  )

  return Effect.gen(function* () {
    const results = yield* syncDaily({
      agents: ["claude"],
      capturedAt: "2026-07-29T12:00:00.000Z",
      deviceId: "11236047-7ee3-4238-8157-f189bbc16927",
      since: "2026-07-29",
      until: "2026-07-29",
    })
    expect(results).toMatchObject([{ agent: "claude", committed: 1, snapshots: 1 }])
  }).pipe(Effect.provide(Layer.mergeAll(command, importerLayer, destination)))
})

it("parses an explicit loopback collector address", () => {
  expect(parseCollectorAddress("http://127.0.0.1:4318")).toEqual({
    hostname: "127.0.0.1",
    port: 4318,
  })
})
