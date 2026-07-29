import {
  CCUSAGE_VERSION,
  CcusageCommand,
  CcusageImporter,
  type CcusageAgent,
} from "@lumen-build/sync-ccusage"
import { Collector, LiveUsageStore, startServer } from "@lumen-build/sync-collector"
import { Destination } from "@lumen-build/sync-destination"
import { Console, Effect, Ref, Schema } from "effect"

export interface DailySyncIdKey {
  readonly agent: CcusageAgent
  readonly deviceId: string
  readonly since: string
  readonly until: string
}

export class DailySyncIdJournalError extends Schema.TaggedErrorClass<DailySyncIdJournalError>()(
  "DailySyncIdJournalError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

export interface DailySyncIdJournal {
  readonly getOrCreate: (key: DailySyncIdKey) => Effect.Effect<string, DailySyncIdJournalError>
  readonly remove: (
    key: DailySyncIdKey,
    syncId: string,
  ) => Effect.Effect<void, DailySyncIdJournalError>
}

export interface DailySyncOptions {
  readonly agents: ReadonlyArray<CcusageAgent>
  readonly capturedAt: string
  readonly deviceId: string
  readonly syncIds: DailySyncIdJournal
  readonly since: string
  readonly until: string
}

export interface DailySyncResult {
  readonly agent: CcusageAgent
  readonly committed: number
  readonly snapshots: number
  readonly syncId: string
}

export const syncDaily = Effect.fn("SyncRuntime.syncDaily")(function* ({
  agents,
  capturedAt,
  deviceId,
  syncIds,
  since,
  until,
}: DailySyncOptions) {
  const command = yield* CcusageCommand
  const importer = yield* CcusageImporter
  const destination = yield* Destination

  return yield* Effect.forEach(
    agents,
    (agent) =>
      Effect.gen(function* () {
        const output = yield* command.runDaily({ agent, since, until })
        const key = { agent, deviceId, since, until } satisfies DailySyncIdKey
        const syncId = yield* syncIds.getOrCreate(key)
        const batch = yield* importer.importDaily({
          agent,
          capturedAt,
          deviceId,
          sourceVersion: CCUSAGE_VERSION,
          stdout: output.stdout,
          syncId,
        })
        const committed = yield* destination.syncDaily(batch)
        yield* syncIds.remove(key, syncId)
        return {
          agent,
          committed,
          snapshots: batch.snapshots.length,
          syncId,
        } satisfies DailySyncResult
      }),
    { concurrency: 2 },
  )
})

export interface CollectorRuntimeOptions {
  readonly hostname: string
  readonly port: number
  readonly uploadIntervalMilliseconds: number
}

export interface LocalCollectorRuntimeOptions {
  readonly hostname: string
  readonly port: number
}

export interface LiveUploadRuntimeOptions {
  readonly uploadIntervalMilliseconds: number
}

export class InvalidUploadInterval extends Schema.TaggedErrorClass<InvalidUploadInterval>()(
  "InvalidUploadInterval",
  {
    milliseconds: Schema.Number,
  },
) {}

const validateUploadInterval = (milliseconds: number) =>
  Number.isFinite(milliseconds) && milliseconds > 0
    ? Effect.void
    : Effect.fail(new InvalidUploadInterval({ milliseconds }))

const uploadLive = Effect.fn("SyncRuntime.uploadLive")(function* (uploadedGeneration: number) {
  const store = yield* LiveUsageStore
  const destination = yield* Destination
  const snapshot = yield* store.snapshotAfter(new Date().toISOString(), uploadedGeneration)
  if (snapshot === undefined) return undefined
  const { batch, generation } = snapshot
  const accepted = yield* destination.putLive(batch)
  yield* store.checkpoint
  return { accepted, generation }
})

export const runLiveUploads = Effect.fn("SyncRuntime.runLiveUploads")(function* ({
  uploadIntervalMilliseconds,
}: LiveUploadRuntimeOptions) {
  yield* validateUploadInterval(uploadIntervalMilliseconds)
  const uploadedGeneration = yield* Ref.make(0)
  const upload = Effect.sleep(uploadIntervalMilliseconds).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const result = yield* uploadLive(yield* Ref.get(uploadedGeneration))
        if (result === undefined) return
        yield* Ref.set(uploadedGeneration, result.generation)
        yield* Console.log(`Uploaded ${result.accepted} live usage snapshots`)
      }),
    ),
    Effect.catch((error) => Console.error("Live usage upload failed", error)),
  )
  return yield* upload.pipe(Effect.forever)
})

export const runLocalCollector = Effect.fn("SyncRuntime.runLocalCollector")(function* ({
  hostname,
  port,
}: LocalCollectorRuntimeOptions) {
  const collector = yield* Collector
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => startServer({ collector, hostname, port })),
    (server) =>
      Effect.gen(function* () {
        yield* Console.log(`OTLP collector listening on ${server.url}`)
        return yield* Effect.never
      }),
    (server) => Effect.sync(() => server.stop(true)),
  )
})

export const runCollector = Effect.fn("SyncRuntime.runCollector")(function* ({
  hostname,
  port,
  uploadIntervalMilliseconds,
}: CollectorRuntimeOptions) {
  yield* validateUploadInterval(uploadIntervalMilliseconds)
  const collector = yield* Collector
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => startServer({ collector, hostname, port })),
    (server) =>
      Effect.gen(function* () {
        yield* Console.log(`OTLP collector listening on ${server.url}`)
        return yield* runLiveUploads({ uploadIntervalMilliseconds })
      }),
    (server) => Effect.sync(() => server.stop(true)),
  )
})

export const parseCollectorAddress = (
  listenUrl: string,
): { readonly hostname: string; readonly port: number } => {
  const url = new URL(listenUrl)
  return {
    hostname: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: url.port === "" ? 80 : Number(url.port),
  }
}
