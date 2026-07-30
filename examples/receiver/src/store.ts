import type {
  CcusageDailyBatch,
  OtelLiveBatch,
  OtelUsageCostSnapshot,
  OtelUsageSnapshot,
} from "@lumen-build/sync/contracts"
import { usageSnapshotKey } from "@lumen-build/sync/contracts"
import { Effect, HashMap, Option, Ref } from "effect"

import {
  type DailyStart,
  type DailyUpload,
  equivalentDailyStart,
  equivalentDailyUpload,
} from "./protocol.js"

type DailyTransaction =
  | {
      readonly kind: "started"
      readonly start: DailyStart
    }
  | {
      readonly kind: "uploaded"
      readonly start: DailyStart
      readonly upload: DailyUpload
    }
  | {
      readonly kind: "committed"
      readonly start: DailyStart
      readonly upload: DailyUpload
    }

interface State {
  readonly daily: HashMap.HashMap<string, DailyTransaction>
  readonly liveCosts: HashMap.HashMap<string, OtelUsageCostSnapshot>
  readonly liveUsage: HashMap.HashMap<string, OtelUsageSnapshot>
}

export interface ReceiverSnapshot {
  readonly committedDaily: ReadonlyArray<CcusageDailyBatch>
  readonly liveCosts: ReadonlyArray<OtelUsageCostSnapshot>
  readonly liveUsage: ReadonlyArray<OtelUsageSnapshot>
}

type CommitResult =
  | { readonly committed: number; readonly kind: "accepted" }
  | { readonly kind: "missing" }

export interface ReceiverStore {
  readonly commitDaily: (syncId: string) => Effect.Effect<CommitResult>
  readonly putLive: (batch: OtelLiveBatch) => Effect.Effect<number>
  readonly snapshot: Effect.Effect<ReceiverSnapshot>
  readonly startDaily: (syncId: string, start: DailyStart) => Effect.Effect<"accepted" | "conflict">
  readonly uploadDaily: (
    syncId: string,
    upload: DailyUpload,
  ) => Effect.Effect<"accepted" | "conflict" | "missing">
}

const emptyState = (): State => ({
  daily: HashMap.empty(),
  liveCosts: HashMap.empty(),
  liveUsage: HashMap.empty(),
})

const liveCostKey = (deviceId: string, snapshot: OtelUsageCostSnapshot): string =>
  [deviceId, snapshot.day, snapshot.agent].join("\u0000")

const updateLive = (current: State, batch: OtelLiveBatch): State => {
  let liveUsage = current.liveUsage
  let liveCosts = current.liveCosts
  for (const snapshot of batch.snapshots) {
    const key = `${batch.deviceId}\u0000${usageSnapshotKey(snapshot)}`
    const previous = Option.getOrUndefined(HashMap.get(liveUsage, key))
    if (previous === undefined || snapshot.revision > previous.revision) {
      liveUsage = HashMap.set(liveUsage, key, snapshot)
    }
  }
  for (const snapshot of batch.costs) {
    const key = liveCostKey(batch.deviceId, snapshot)
    const previous = Option.getOrUndefined(HashMap.get(liveCosts, key))
    if (previous === undefined || snapshot.revision > previous.revision) {
      liveCosts = HashMap.set(liveCosts, key, snapshot)
    }
  }
  return liveUsage === current.liveUsage && liveCosts === current.liveCosts
    ? current
    : { ...current, liveCosts, liveUsage }
}

const committedBatch = (
  syncId: string,
  transaction: DailyTransaction,
): CcusageDailyBatch | undefined =>
  transaction.kind === "committed"
    ? {
        capturedAt: transaction.start.capturedAt,
        costs: transaction.upload.costs,
        deviceId: transaction.start.deviceId,
        snapshots: transaction.upload.snapshots,
        source: transaction.start.source,
        sourceVersion: transaction.start.sourceVersion,
        syncId,
        timeZone: transaction.start.timeZone,
      }
    : undefined

const publicState = (state: State): ReceiverSnapshot => ({
  committedDaily: [...state.daily]
    .map(([syncId, transaction]) => committedBatch(syncId, transaction))
    .filter((batch): batch is CcusageDailyBatch => batch !== undefined),
  liveCosts: [...state.liveCosts].map(([, snapshot]) => snapshot),
  liveUsage: [...state.liveUsage].map(([, snapshot]) => snapshot),
})

export const makeReceiverStore: Effect.Effect<ReceiverStore> = Effect.gen(function* () {
  const state = yield* Ref.make(emptyState())

  const putLive = (batch: OtelLiveBatch) =>
    Ref.update(state, (current) => updateLive(current, batch)).pipe(
      Effect.as(batch.snapshots.length),
    )

  const startDaily = (syncId: string, start: DailyStart) =>
    Ref.modify(state, (current) => {
      const existing = Option.getOrUndefined(HashMap.get(current.daily, syncId))
      if (existing !== undefined) {
        return [
          equivalentDailyStart(existing.start, start) ? "accepted" : "conflict",
          current,
        ] as const
      }
      return [
        "accepted",
        {
          ...current,
          daily: HashMap.set(current.daily, syncId, { kind: "started", start }),
        },
      ] as const
    })

  const uploadDaily = (syncId: string, upload: DailyUpload) =>
    Ref.modify(state, (current) => {
      const existing = Option.getOrUndefined(HashMap.get(current.daily, syncId))
      if (existing === undefined) return ["missing", current] as const
      if (
        upload.snapshots.length !== existing.start.snapshotCount ||
        upload.costs.length !== existing.start.costSnapshotCount
      ) {
        return ["conflict", current] as const
      }
      if (existing.kind !== "started") {
        return [
          equivalentDailyUpload(existing.upload, upload) ? "accepted" : "conflict",
          current,
        ] as const
      }
      return [
        "accepted",
        {
          ...current,
          daily: HashMap.set(current.daily, syncId, {
            kind: "uploaded",
            start: existing.start,
            upload,
          }),
        },
      ] as const
    })

  const commitDaily = (syncId: string) =>
    Ref.modify(state, (current): readonly [CommitResult, State] => {
      const existing = Option.getOrUndefined(HashMap.get(current.daily, syncId))
      if (existing === undefined || existing.kind === "started") {
        return [{ kind: "missing" }, current] as const
      }
      const result = {
        committed: existing.upload.snapshots.length,
        kind: "accepted",
      } as const
      if (existing.kind === "committed") return [result, current] as const
      return [
        result,
        {
          ...current,
          daily: HashMap.set(current.daily, syncId, {
            kind: "committed",
            start: existing.start,
            upload: existing.upload,
          }),
        },
      ] as const
    })

  return {
    commitDaily,
    putLive,
    snapshot: Ref.get(state).pipe(Effect.map(publicState)),
    startDaily,
    uploadDaily,
  }
})
