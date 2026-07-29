import { Schema } from "effect"

const isUtcTimestamp = (value: string): boolean => {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

const isUtcDay = (value: string): boolean => {
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
  )
}

export const NonNegativeSafeInteger = Schema.Number.check(
  Schema.isInt({ message: "expected an integer" }),
  Schema.isGreaterThanOrEqualTo(0, { message: "expected a non-negative integer" }),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, { message: "expected a safe integer" }),
)

export const PositiveSafeInteger = NonNegativeSafeInteger.check(
  Schema.isGreaterThanOrEqualTo(1, { message: "expected a positive integer" }),
)

export const UtcTimestamp = Schema.String.check(
  Schema.makeFilter(isUtcTimestamp, { message: "expected an ISO-8601 UTC timestamp" }),
)

export const UsageDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: "expected a UTC calendar day" }),
  Schema.makeFilter(isUtcDay, { message: "expected a valid UTC calendar day" }),
)

export const DeviceId = Schema.String.check(
  Schema.isUUID(4, { message: "expected a version 4 UUID" }),
)

export const SyncId = Schema.String.check(
  Schema.isUUID(4, { message: "expected a version 4 UUID" }),
)

export const UsageAgent = Schema.Literals([
  "claude",
  "codex",
  "copilot",
  "gemini",
  "opencode",
  "vscode",
  "unknown",
])

export const UsageTokens = Schema.Struct({
  cacheCreationInput: NonNegativeSafeInteger,
  cacheReadInput: NonNegativeSafeInteger,
  input: NonNegativeSafeInteger,
  output: NonNegativeSafeInteger,
  reasoningOutput: NonNegativeSafeInteger,
  tool: NonNegativeSafeInteger,
}).annotate({ identifier: "UsageTokens" })

export interface UsageTokens extends Schema.Schema.Type<typeof UsageTokens> {}

export const UsageSnapshot = Schema.Struct({
  agent: UsageAgent,
  day: UsageDay,
  model: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  provider: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  tokens: UsageTokens,
}).annotate({ identifier: "UsageSnapshot" })

export interface UsageSnapshot extends Schema.Schema.Type<typeof UsageSnapshot> {}

export const UsageCostCoverage = Schema.Literals(["complete", "partial", "source-reported"])

export const UsageCostSnapshot = Schema.Struct({
  agent: UsageAgent,
  coverage: UsageCostCoverage,
  day: UsageDay,
  estimatedCostNanoUsd: NonNegativeSafeInteger,
  unpricedEvents: NonNegativeSafeInteger,
}).annotate({ identifier: "UsageCostSnapshot" })

export interface UsageCostSnapshot extends Schema.Schema.Type<typeof UsageCostSnapshot> {}

export const OtelUsageSnapshot = UsageSnapshot.pipe(
  Schema.fieldsAssign({ revision: PositiveSafeInteger }),
).annotate({ identifier: "OtelUsageSnapshot" })

export interface OtelUsageSnapshot extends Schema.Schema.Type<typeof OtelUsageSnapshot> {}

export const OtelUsageCostSnapshot = UsageCostSnapshot.pipe(
  Schema.fieldsAssign({ revision: PositiveSafeInteger }),
).annotate({ identifier: "OtelUsageCostSnapshot" })

export interface OtelUsageCostSnapshot extends Schema.Schema.Type<typeof OtelUsageCostSnapshot> {}

export const OtelLiveBatch = Schema.Struct({
  source: Schema.Literal("otel-live"),
  capturedAt: UtcTimestamp,
  deviceId: DeviceId,
  snapshots: Schema.Array(OtelUsageSnapshot),
  costs: Schema.Array(OtelUsageCostSnapshot),
}).annotate({ identifier: "OtelLiveBatch" })

export interface OtelLiveBatch extends Schema.Schema.Type<typeof OtelLiveBatch> {}

export const CcusageDailyBatch = Schema.Struct({
  source: Schema.Literal("ccusage-daily"),
  capturedAt: UtcTimestamp,
  costs: Schema.Array(UsageCostSnapshot),
  deviceId: DeviceId,
  snapshots: Schema.Array(UsageSnapshot),
  sourceVersion: Schema.String.check(
    Schema.isPattern(/^\d+\.\d+\.\d+$/, { message: "expected a semantic version" }),
  ),
  syncId: SyncId,
  timeZone: Schema.Literal("UTC"),
}).annotate({ identifier: "CcusageDailyBatch" })

export interface CcusageDailyBatch extends Schema.Schema.Type<typeof CcusageDailyBatch> {}

export const UsageSourceBatch = Schema.Union([OtelLiveBatch, CcusageDailyBatch])

export type UsageSourceBatch = typeof UsageSourceBatch.Type

export const UsagePrincipal = Schema.Struct({
  claims: Schema.Record(Schema.String, Schema.Unknown),
  scheme: Schema.Literals(["bearer", "oidc"]),
  subjectId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
}).annotate({ identifier: "UsagePrincipal" })

export interface UsagePrincipal extends Schema.Schema.Type<typeof UsagePrincipal> {}

export const ReconciliationPolicyName = Schema.Literals([
  "separate",
  "otel-only",
  "ccusage-only",
  "ccusage-baseline-live-delta",
])

export type ReconciliationPolicyName = typeof ReconciliationPolicyName.Type

export const tokenTotal = (tokens: UsageTokens): number =>
  tokens.input +
  tokens.output +
  tokens.cacheCreationInput +
  tokens.cacheReadInput +
  tokens.reasoningOutput +
  tokens.tool
