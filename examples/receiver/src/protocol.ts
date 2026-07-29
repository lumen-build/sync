import { DailySyncStartRequest, DailySyncUploadRequest } from "@lumen-build/sync/contracts"
import { Schema } from "effect"

export const DailyStart = DailySyncStartRequest

export interface DailyStart extends Schema.Schema.Type<typeof DailyStart> {}

export const DailyUpload = DailySyncUploadRequest

export interface DailyUpload extends Schema.Schema.Type<typeof DailyUpload> {}

export const equivalentDailyStart = Schema.toEquivalence(DailyStart)
export const equivalentDailyUpload = Schema.toEquivalence(DailyUpload)
