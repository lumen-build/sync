import type {
  OtelUsageCostSnapshot,
  OtelUsageSnapshot,
  ReconciliationPolicyName,
  UsageCostSnapshot,
  UsageSnapshot,
  UsageTokens,
} from "@lumen-build/sync-contracts"
import { emptyUsageTokens, usageSnapshotKey } from "@lumen-build/sync-contracts"
import { Context, Effect, Layer, Schema } from "effect"

export interface UsageBaseline extends UsageSnapshot {}

export interface UsageCostBaseline extends UsageCostSnapshot {}

export interface BaselineCaptureInput {
  readonly ccusage: ReadonlyArray<UsageSnapshot>
  readonly ccusageCosts: ReadonlyArray<UsageCostSnapshot>
  readonly otel: ReadonlyArray<OtelUsageSnapshot>
  readonly otelCosts: ReadonlyArray<OtelUsageCostSnapshot>
}

export interface ReconciliationInput extends BaselineCaptureInput {
  readonly baselines: ReadonlyArray<UsageBaseline>
  readonly costBaselines: ReadonlyArray<UsageCostBaseline>
  readonly policy?: ReconciliationPolicyName
}

export type ReconciliationResult =
  | {
      readonly _tag: "Separate"
      readonly ccusage: ReadonlyArray<UsageSnapshot>
      readonly ccusageCosts: ReadonlyArray<UsageCostSnapshot>
      readonly otel: ReadonlyArray<OtelUsageSnapshot>
      readonly otelCosts: ReadonlyArray<OtelUsageCostSnapshot>
    }
  | {
      readonly _tag: "Canonical"
      readonly policy: Exclude<ReconciliationPolicyName, "separate">
      readonly snapshots: ReadonlyArray<UsageSnapshot>
      readonly costs: ReadonlyArray<UsageCostSnapshot>
    }

export class PolicyRequired extends Schema.TaggedErrorClass<PolicyRequired>()(
  "ReconciliationPolicyRequired",
  {
    message: Schema.String,
  },
) {}

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()(
  "ReconciliationInvalidInput",
  {
    reason: Schema.String,
  },
) {}

export type ReconciliationError = PolicyRequired | InvalidInput

export interface Interface {
  readonly reconcile: (
    input: ReconciliationInput,
  ) => Effect.Effect<ReconciliationResult, ReconciliationError>
}

export class Reconciliation extends Context.Service<Reconciliation, Interface>()(
  "@lumen-build/sync/Reconciliation",
) {}

const modelKey = (snapshot: UsageSnapshot): string =>
  [snapshot.day, snapshot.agent, snapshot.model].join("\u0000")

const costKey = (snapshot: UsageCostSnapshot): string =>
  [snapshot.day, snapshot.agent].join("\u0000")

const compareUsage = (left: UsageSnapshot, right: UsageSnapshot): number =>
  usageSnapshotKey(left).localeCompare(usageSnapshotKey(right))

const compareCosts = (left: UsageCostSnapshot, right: UsageCostSnapshot): number =>
  costKey(left).localeCompare(costKey(right))

const withoutRevision = (snapshot: OtelUsageSnapshot): UsageSnapshot => ({
  agent: snapshot.agent,
  day: snapshot.day,
  model: snapshot.model,
  provider: snapshot.provider,
  tokens: snapshot.tokens,
})

const withoutCostRevision = (snapshot: OtelUsageCostSnapshot): UsageCostSnapshot => ({
  agent: snapshot.agent,
  coverage: snapshot.coverage,
  day: snapshot.day,
  estimatedCostNanoUsd: snapshot.estimatedCostNanoUsd,
  unpricedEvents: snapshot.unpricedEvents,
})

const indexBy = <Value>(
  values: ReadonlyArray<Value>,
  key: (value: Value) => string,
): ReadonlyMap<string, Value> => new Map(values.map((value) => [key(value), value]))

const makeLiveMatcher = (
  ccusage: ReadonlyArray<UsageSnapshot>,
  otel: ReadonlyArray<OtelUsageSnapshot>,
) => {
  const exact = indexBy(otel, usageSnapshotKey)
  const modelCounts = new Map<string, number>()
  for (const snapshot of ccusage) {
    const key = modelKey(snapshot)
    modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1)
  }
  const unknownProvider = new Map(
    otel
      .filter((snapshot) => snapshot.provider === "unknown")
      .map((snapshot) => [modelKey(snapshot), snapshot]),
  )

  return (target: UsageSnapshot): OtelUsageSnapshot | undefined =>
    exact.get(usageSnapshotKey(target)) ??
    (modelCounts.get(modelKey(target)) === 1 ? unknownProvider.get(modelKey(target)) : undefined)
}

const addDelta = (
  authoritative: UsageTokens,
  current: UsageTokens,
  baseline: UsageTokens,
): UsageTokens => ({
  cacheCreationInput:
    authoritative.cacheCreationInput +
    Math.max(current.cacheCreationInput - baseline.cacheCreationInput, 0),
  cacheReadInput:
    authoritative.cacheReadInput + Math.max(current.cacheReadInput - baseline.cacheReadInput, 0),
  input: authoritative.input + Math.max(current.input - baseline.input, 0),
  output: authoritative.output + Math.max(current.output - baseline.output, 0),
  reasoningOutput:
    authoritative.reasoningOutput + Math.max(current.reasoningOutput - baseline.reasoningOutput, 0),
  tool: authoritative.tool + Math.max(current.tool - baseline.tool, 0),
})

const ensureUnique = <A>(
  label: string,
  values: ReadonlyArray<A>,
  key: (value: A) => string,
): Effect.Effect<void, InvalidInput> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    for (const value of values) {
      const identity = key(value)
      if (seen.has(identity)) {
        return yield* new InvalidInput({
          reason: `duplicate ${label} identity: ${identity.replaceAll("\u0000", "/")}`,
        })
      }
      seen.add(identity)
    }
  })

export const captureBaseline = ({
  ccusage,
  ccusageCosts,
  otel,
  otelCosts,
}: BaselineCaptureInput): {
  readonly baselines: ReadonlyArray<UsageBaseline>
  readonly costBaselines: ReadonlyArray<UsageCostBaseline>
} => {
  const matchingLive = makeLiveMatcher(ccusage, otel)
  const currentCosts = indexBy(otelCosts, costKey)
  return {
    baselines: ccusage.map((snapshot) => {
      const current = matchingLive(snapshot)
      return {
        ...snapshot,
        tokens: current?.tokens ?? emptyUsageTokens(),
      }
    }),
    costBaselines: ccusageCosts.map((snapshot) => {
      const current = currentCosts.get(costKey(snapshot))
      return {
        ...snapshot,
        estimatedCostNanoUsd: current?.estimatedCostNanoUsd ?? 0,
        unpricedEvents: current?.unpricedEvents ?? 0,
      }
    }),
  }
}

const canonicalUsage = (input: ReconciliationInput): ReadonlyArray<UsageSnapshot> => {
  const matchedLive = new Set<OtelUsageSnapshot>()
  const matchingLive = makeLiveMatcher(input.ccusage, input.otel)
  const baselines = indexBy(input.baselines, usageSnapshotKey)
  const imported = input.ccusage.map((snapshot) => {
    const current = matchingLive(snapshot)
    if (current !== undefined) matchedLive.add(current)
    const baseline = baselines.get(usageSnapshotKey(snapshot))

    return {
      ...snapshot,
      tokens: addDelta(
        snapshot.tokens,
        current?.tokens ?? emptyUsageTokens(),
        baseline?.tokens ?? emptyUsageTokens(),
      ),
    }
  })

  return [
    ...imported,
    ...input.otel.filter((snapshot) => !matchedLive.has(snapshot)).map(withoutRevision),
  ].toSorted(compareUsage)
}

const canonicalCosts = (input: ReconciliationInput): ReadonlyArray<UsageCostSnapshot> => {
  const matchedLive = new Set<OtelUsageCostSnapshot>()
  const currentCosts = indexBy(input.otelCosts, costKey)
  const baselines = indexBy(input.costBaselines, costKey)
  const imported = input.ccusageCosts.map((snapshot) => {
    const current = currentCosts.get(costKey(snapshot))
    if (current !== undefined) matchedLive.add(current)
    const baseline = baselines.get(costKey(snapshot))
    const amountDelta = Math.max(
      (current?.estimatedCostNanoUsd ?? 0) - (baseline?.estimatedCostNanoUsd ?? 0),
      0,
    )
    const unpricedDelta = Math.max(
      (current?.unpricedEvents ?? 0) - (baseline?.unpricedEvents ?? 0),
      0,
    )

    return {
      ...snapshot,
      coverage: unpricedDelta > 0 ? "partial" : snapshot.coverage,
      estimatedCostNanoUsd: snapshot.estimatedCostNanoUsd + amountDelta,
      unpricedEvents: snapshot.unpricedEvents + unpricedDelta,
    } satisfies UsageCostSnapshot
  })

  return [
    ...imported,
    ...input.otelCosts.filter((snapshot) => !matchedLive.has(snapshot)).map(withoutCostRevision),
  ].toSorted(compareCosts)
}

export const make = Effect.succeed(
  Reconciliation.of({
    reconcile: Effect.fn("Reconciliation.reconcile")(function* (input) {
      if (input.policy === undefined) {
        return yield* new PolicyRequired({
          message: "select a reconciliation policy before requesting a canonical view",
        })
      }

      yield* ensureUnique("ccusage usage", input.ccusage, usageSnapshotKey)
      yield* ensureUnique("OTEL usage", input.otel, usageSnapshotKey)
      yield* ensureUnique("usage baseline", input.baselines, usageSnapshotKey)
      yield* ensureUnique("ccusage cost", input.ccusageCosts, costKey)
      yield* ensureUnique("OTEL cost", input.otelCosts, costKey)
      yield* ensureUnique("cost baseline", input.costBaselines, costKey)

      if (input.policy === "separate") {
        return {
          _tag: "Separate",
          ccusage: input.ccusage,
          ccusageCosts: input.ccusageCosts,
          otel: input.otel,
          otelCosts: input.otelCosts,
        }
      }

      if (input.policy === "otel-only") {
        return {
          _tag: "Canonical",
          policy: input.policy,
          snapshots: input.otel.map(withoutRevision).toSorted(compareUsage),
          costs: input.otelCosts.map(withoutCostRevision).toSorted(compareCosts),
        }
      }

      if (input.policy === "ccusage-only") {
        return {
          _tag: "Canonical",
          policy: input.policy,
          snapshots: [...input.ccusage].toSorted(compareUsage),
          costs: [...input.ccusageCosts].toSorted(compareCosts),
        }
      }

      const usageBaselines = new Set(input.baselines.map(usageSnapshotKey))
      for (const snapshot of input.ccusage) {
        if (!usageBaselines.has(usageSnapshotKey(snapshot))) {
          return yield* new InvalidInput({
            reason: `missing usage baseline: ${usageSnapshotKey(snapshot).replaceAll("\u0000", "/")}`,
          })
        }
      }
      const costBaselines = new Set(input.costBaselines.map(costKey))
      for (const snapshot of input.ccusageCosts) {
        if (!costBaselines.has(costKey(snapshot))) {
          return yield* new InvalidInput({
            reason: `missing cost baseline: ${costKey(snapshot).replaceAll("\u0000", "/")}`,
          })
        }
      }

      return {
        _tag: "Canonical",
        policy: input.policy,
        snapshots: canonicalUsage(input),
        costs: canonicalCosts(input),
      }
    }),
  }),
)

export const layer = Layer.effect(Reconciliation, make)
