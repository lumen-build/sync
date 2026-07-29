import {
  CCUSAGE_VERSION,
  CcusageCommand,
  CcusageImporter,
  type CcusageAgent,
} from "@lumen-build/sync-ccusage"
import { Collector, LiveUsageStore, startServer } from "@lumen-build/sync-collector"
import { Destination } from "@lumen-build/sync-destination"
import { Console, Effect } from "effect"

export interface DailySyncOptions {
  readonly agents: ReadonlyArray<CcusageAgent>
  readonly capturedAt: string
  readonly deviceId: string
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
        const syncId = crypto.randomUUID()
        const output = yield* command.runDaily({ agent, since, until })
        const batch = yield* importer.importDaily({
          agent,
          capturedAt,
          deviceId,
          sourceVersion: CCUSAGE_VERSION,
          stdout: output.stdout,
          syncId,
        })
        const committed = yield* destination.syncDaily(batch)
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
  readonly uploadIntervalMilliseconds?: number
}

const uploadLive = Effect.fn("SyncRuntime.uploadLive")(function* () {
  const store = yield* LiveUsageStore
  const destination = yield* Destination
  const batch = yield* store.snapshot(new Date().toISOString())
  if (batch.snapshots.length === 0 && batch.costs.length === 0) return 0
  return yield* destination.putLive(batch)
})

export const runCollector = Effect.fn("SyncRuntime.runCollector")(function* ({
  hostname,
  port,
  uploadIntervalMilliseconds,
}: CollectorRuntimeOptions) {
  const collector = yield* Collector
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => startServer({ collector, hostname, port })),
    (server) =>
      Effect.gen(function* () {
        yield* Console.log(`OTLP collector listening on ${server.url}`)
        if (uploadIntervalMilliseconds === undefined) return yield* Effect.never
        const upload = Effect.sleep(uploadIntervalMilliseconds).pipe(
          Effect.andThen(uploadLive()),
          Effect.tap((accepted) => Console.log(`Uploaded ${accepted} live usage snapshots`)),
          Effect.catch((error) => Console.error("Live usage upload failed", error)),
          Effect.forever,
        )
        return yield* upload
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
