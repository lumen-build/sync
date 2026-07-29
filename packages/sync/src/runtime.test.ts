import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Collector, LiveUsageStore } from "@lumen-build/sync-collector"
import { CcusageCommand, importerLayer } from "@lumen-build/sync-ccusage"
import { Destination, DestinationUnavailable } from "@lumen-build/sync-destination"
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

import { makeFileDailySyncIdJournal } from "./sync-id-journal"
import {
  InvalidUploadInterval,
  parseCollectorAddress,
  runCollector,
  runLiveUploads,
  syncDaily,
} from "./runtime"

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
      syncIds: {
        getOrCreate: () => Effect.succeed("4209e319-04bf-4fd0-8d84-a18920ebcb9c"),
        remove: () => Effect.void,
      },
      since: "2026-07-29",
      until: "2026-07-29",
    })
    expect(results).toMatchObject([{ agent: "claude", committed: 1, snapshots: 1 }])
  }).pipe(Effect.provide(Layer.mergeAll(command, importerLayer, destination)))
})

it.effect(
  "reuses a durable daily sync ID after a lost commit response and clears it on success",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-daily-"))),
      (directory) => {
        const command = Layer.succeed(
          CcusageCommand,
          CcusageCommand.of({
            runDaily: () => Effect.succeed({ stderr: "", stdout: report }),
          }),
        )
        const attemptedSyncIds: Array<string> = []
        const destination = Layer.succeed(
          Destination,
          Destination.of({
            baseUrl: "https://usage.lumen.build",
            putLive: () => Effect.succeed(0),
            syncDaily: (batch) => {
              attemptedSyncIds.push(batch.syncId)
              return attemptedSyncIds.length === 1
                ? Effect.fail(new DestinationUnavailable({ reason: "commit response was lost" }))
                : Effect.succeed(batch.snapshots.length)
            },
          }),
        )
        const options = {
          agents: ["claude"] as const,
          capturedAt: "2026-07-29T12:00:00.000Z",
          deviceId: "11236047-7ee3-4238-8157-f189bbc16927",
          since: "2026-07-29",
          until: "2026-07-29",
        }

        return Effect.gen(function* () {
          const firstJournal = makeFileDailySyncIdJournal(directory)
          yield* syncDaily({ ...options, syncIds: firstJournal }).pipe(Effect.flip)
          const pending = yield* Effect.promise(() => readdir(directory))
          expect(pending).toHaveLength(1)
          expect(
            (yield* Effect.promise(() => stat(join(directory, pending[0]!)))).mode & 0o777,
          ).toBe(0o600)

          const secondJournal = makeFileDailySyncIdJournal(directory)
          const result = yield* syncDaily({ ...options, syncIds: secondJournal })

          expect(attemptedSyncIds).toHaveLength(2)
          expect(attemptedSyncIds[1]).toBe(attemptedSyncIds[0])
          expect(result).toMatchObject([{ committed: 1, syncId: attemptedSyncIds[0] }])
          expect(yield* Effect.promise(() => readdir(directory))).toEqual([])
        }).pipe(Effect.provide(Layer.mergeAll(command, importerLayer, destination)))
      },
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    ),
)

it.effect("uploads changed live generations once, skips unchanged data, and retries failures", () =>
  Effect.gen(function* () {
    const checkpoints = yield* Ref.make(0)
    const generation = yield* Ref.make(0)
    const snapshotGeneration = yield* Ref.make(0)
    const attempts: Array<number> = []
    const failGeneration = yield* Ref.make<number | undefined>(undefined)
    const store = Layer.succeed(
      LiveUsageStore,
      LiveUsageStore.of({
        checkpoint: Ref.update(checkpoints, (current) => current + 1),
        generation: Ref.get(generation),
        ingest: () => Effect.succeed(0),
        snapshot: (capturedAt) =>
          Effect.gen(function* () {
            yield* Ref.set(snapshotGeneration, yield* Ref.get(generation))
            return {
              capturedAt,
              costs: [],
              deviceId: "11236047-7ee3-4238-8157-f189bbc16927",
              snapshots: [],
              source: "otel-live" as const,
            }
          }),
        snapshotAfter: (capturedAt, afterGeneration) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(generation)
            if (current <= afterGeneration) return undefined
            yield* Ref.set(snapshotGeneration, current)
            return {
              batch: {
                capturedAt,
                costs: [],
                deviceId: "11236047-7ee3-4238-8157-f18920ebcb9c",
                snapshots: [],
                source: "otel-live" as const,
              },
              generation: current,
            }
          }),
      }),
    )
    const destination = Layer.succeed(
      Destination,
      Destination.of({
        baseUrl: "https://usage.lumen.build",
        putLive: () =>
          Effect.gen(function* () {
            const current = yield* Ref.get(snapshotGeneration)
            attempts.push(current)
            if ((yield* Ref.get(failGeneration)) === current) {
              yield* Ref.set(failGeneration, undefined)
              return yield* new DestinationUnavailable({ reason: "temporary failure" })
            }
            return 1
          }),
        syncDaily: () => Effect.succeed(0),
      }),
    )
    const fiber = yield* runLiveUploads({ uploadIntervalMilliseconds: 1_000 }).pipe(
      Effect.provide(Layer.merge(store, destination)),
      Effect.forkChild,
    )

    yield* Ref.set(generation, 1)
    yield* TestClock.adjust("1 second")
    expect(attempts).toEqual([1])
    expect(yield* Ref.get(checkpoints)).toBe(1)

    yield* TestClock.adjust("1 second")
    expect(attempts).toEqual([1])
    expect(yield* Ref.get(checkpoints)).toBe(1)

    yield* Ref.set(generation, 2)
    yield* Ref.set(failGeneration, 2)
    yield* TestClock.adjust("1 second")
    expect(attempts).toEqual([1, 2])
    expect(yield* Ref.get(checkpoints)).toBe(1)

    yield* TestClock.adjust("1 second")
    expect(attempts).toEqual([1, 2, 2])
    expect(yield* Ref.get(checkpoints)).toBe(2)

    yield* TestClock.adjust("1 second")
    expect(attempts).toEqual([1, 2, 2])
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("rejects a nonpositive upload interval before starting the collector", () =>
  Effect.gen(function* () {
    const error = yield* runCollector({
      hostname: "127.0.0.1",
      port: 0,
      uploadIntervalMilliseconds: 0,
    }).pipe(Effect.flip)
    expect(error).toEqual(new InvalidUploadInterval({ milliseconds: 0 }))
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          Collector,
          Collector.of({
            handle: () => Effect.die("collector should not start"),
          }),
        ),
        Layer.succeed(
          LiveUsageStore,
          LiveUsageStore.of({
            checkpoint: Effect.void,
            generation: Effect.succeed(0),
            ingest: () => Effect.succeed(0),
            snapshot: () => Effect.die("upload loop should not start"),
            snapshotAfter: () => Effect.die("upload loop should not start"),
          }),
        ),
        Layer.succeed(
          Destination,
          Destination.of({
            baseUrl: "https://usage.lumen.build",
            putLive: () => Effect.die("upload loop should not start"),
            syncDaily: () => Effect.die("daily sync should not start"),
          }),
        ),
      ),
    ),
  ),
)

it("parses an explicit loopback collector address", () => {
  expect(parseCollectorAddress("http://127.0.0.1:4318")).toEqual({
    hostname: "127.0.0.1",
    port: 4318,
  })
})
