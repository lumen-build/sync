import { CcusageDailyBatch, NonNegativeSafeInteger } from "@lumen-build/sync/contracts"
import { Schema } from "effect"

export const DailyStart = Schema.Struct({
  capturedAt: CcusageDailyBatch.fields.capturedAt,
  costSnapshotCount: NonNegativeSafeInteger,
  deviceId: CcusageDailyBatch.fields.deviceId,
  snapshotCount: NonNegativeSafeInteger,
  source: CcusageDailyBatch.fields.source,
  sourceVersion: CcusageDailyBatch.fields.sourceVersion,
  timeZone: CcusageDailyBatch.fields.timeZone,
})

export interface DailyStart extends Schema.Schema.Type<typeof DailyStart> {}

export const DailyUpload = Schema.Struct({
  costs: CcusageDailyBatch.fields.costs,
  snapshots: CcusageDailyBatch.fields.snapshots,
  source: CcusageDailyBatch.fields.source,
})

export interface DailyUpload extends Schema.Schema.Type<typeof DailyUpload> {}

export const equivalentDailyStart = Schema.toEquivalence(DailyStart)
export const equivalentDailyUpload = Schema.toEquivalence(DailyUpload)
