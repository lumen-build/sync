import {
  CCUSAGE_VERSION,
  CcusageCommand,
  CcusageImporter,
  type CcusageAgent,
} from "@lumen-build/sync-ccusage"
import { CollectorServer, LiveUsageStore } from "@lumen-build/sync-collector"
import type { CcusageDailyBatch } from "@lumen-build/sync-contracts"
import {
  Destination,
  DestinationRejected,
  DestinationUnavailable,
} from "@lumen-build/sync-destination"
import { Clock, Console, Context, Effect, Ref, Schema } from "effect"

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
  readonly getOrCreateBatch: <E, R>(
    key: DailySyncIdKey,
    create: (syncId: string) => Effect.Effect<CcusageDailyBatch, E, R>,
  ) => Effect.Effect<CcusageDailyBatch, DailySyncIdJournalError | E, R>
  readonly remove: (
    key: DailySyncIdKey,
    syncId: string,
  ) => Effect.Effect<void, DailySyncIdJournalError>
}

export interface DailySyncIdJournalFactoryInterface {
  readonly make: (directory: string) => DailySyncIdJournal
}

export class DailySyncIdJournalFactory extends Context.Service<
  DailySyncIdJournalFactory,
  DailySyncIdJournalFactoryInterface
>()("@lumen-build/sync/DailySyncIdJournalFactory") {}

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
        const key = { agent, deviceId, since, until } satisfies DailySyncIdKey
        const batch = yield* syncIds.getOrCreateBatch(
          key,
          Effect.fn("SyncRuntime.createDailyBatch")(function* (syncId) {
            const output = yield* command.runDaily({ agent, since, until })
            return yield* importer.importDaily({
              agent,
              capturedAt,
              deviceId,
              sourceVersion: CCUSAGE_VERSION,
              stdout: output.stdout,
              syncId,
            })
          }),
        )
        const committed = yield* destination.syncDaily(batch)
        yield* syncIds.remove(key, batch.syncId)
        return {
          agent,
          committed,
          snapshots: batch.snapshots.length,
          syncId: batch.syncId,
        } satisfies DailySyncResult
      }),
    { concurrency: 2 },
  )
})

export interface CollectorRuntimeOptions {
  readonly hostname: string
  readonly port: number
  readonly reporter?: RuntimeReporter
  readonly uploadIntervalMilliseconds: number
}

export interface LocalCollectorRuntimeOptions {
  readonly hostname: string
  readonly port: number
  readonly reporter?: RuntimeReporter
}

export interface LiveUploadRuntimeOptions {
  readonly reporter?: RuntimeReporter
  readonly uploadIntervalMilliseconds: number
}

export interface RuntimeReporter {
  readonly listening: (url: string) => Effect.Effect<void>
  readonly uploadFailed: (error: unknown) => Effect.Effect<void>
  readonly uploadSucceeded: (accepted: number) => Effect.Effect<void>
}

const consoleReporter: RuntimeReporter = {
  listening: (url) => Console.log(`OTLP collector listening on ${url}`),
  uploadFailed: (error) => Console.error("Live usage upload failed", error),
  uploadSucceeded: (accepted) => Console.log(`Uploaded ${accepted} live usage snapshots`),
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
  const capturedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const snapshot = yield* store.snapshotAfter(capturedAt, uploadedGeneration)
  if (snapshot === undefined) return undefined
  const { batch, generation } = snapshot
  const accepted = yield* destination.putLive(batch)
  yield* store.checkpoint
  return { accepted, generation }
})

const isRetryableLiveUploadError = (
  error: unknown,
): error is DestinationRejected | DestinationUnavailable =>
  error instanceof DestinationUnavailable ||
  (error instanceof DestinationRejected &&
    (error.status === 429 || (error.status >= 500 && error.status < 600)))

export const runLiveUploads = Effect.fn("SyncRuntime.runLiveUploads")(function* ({
  reporter = consoleReporter,
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
        yield* reporter.uploadSucceeded(result.accepted)
      }),
    ),
    Effect.catchIf(isRetryableLiveUploadError, (error) => reporter.uploadFailed(error)),
  )
  return yield* upload.pipe(Effect.forever)
})

export const runLocalCollector = Effect.fn("SyncRuntime.runLocalCollector")(function* ({
  hostname,
  port,
  reporter = consoleReporter,
}: LocalCollectorRuntimeOptions) {
  return yield* Effect.gen(function* () {
    const server = yield* CollectorServer
    const address = yield* server.listen({ hostname, port })
    yield* reporter.listening(address.url)
    return yield* Effect.never
  }).pipe(Effect.scoped)
})

export const runCollector = Effect.fn("SyncRuntime.runCollector")(function* ({
  hostname,
  port,
  reporter = consoleReporter,
  uploadIntervalMilliseconds,
}: CollectorRuntimeOptions) {
  yield* validateUploadInterval(uploadIntervalMilliseconds)
  return yield* Effect.gen(function* () {
    const server = yield* CollectorServer
    const address = yield* server.listen({ hostname, port })
    yield* reporter.listening(address.url)
    return yield* runLiveUploads({ reporter, uploadIntervalMilliseconds })
  }).pipe(Effect.scoped)
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
