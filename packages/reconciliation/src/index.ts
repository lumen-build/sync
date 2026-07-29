import type {
  OtelUsageCostSnapshot,
  OtelUsageSnapshot,
  ReconciliationPolicyName,
  UsageCostSnapshot,
  UsageSnapshot,
  UsageTokens,
} from "@lumen-build/sync-contracts"
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

const zeroTokens = (): UsageTokens => ({
  cacheCreationInput: 0,
  cacheReadInput: 0,
  input: 0,
  output: 0,
  reasoningOutput: 0,
  tool: 0,
})

const usageKey = (snapshot: UsageSnapshot): string =>
  [snapshot.day, snapshot.agent, snapshot.provider, snapshot.model].join("\u0000")

const modelKey = (snapshot: UsageSnapshot): string =>
  [snapshot.day, snapshot.agent, snapshot.model].join("\u0000")

const costKey = (snapshot: UsageCostSnapshot): string =>
  [snapshot.day, snapshot.agent].join("\u0000")

const compareUsage = (left: UsageSnapshot, right: UsageSnapshot): number =>
  usageKey(left).localeCompare(usageKey(right))

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

const matchingLive = (
  target: UsageSnapshot,
  ccusage: ReadonlyArray<UsageSnapshot>,
  otel: ReadonlyArray<OtelUsageSnapshot>,
): OtelUsageSnapshot | undefined => {
  const exact = otel.find((snapshot) => usageKey(snapshot) === usageKey(target))
  if (exact !== undefined) return exact

  const candidates = ccusage.filter((snapshot) => modelKey(snapshot) === modelKey(target))
  if (candidates.length !== 1) return undefined

  return otel.find(
    (snapshot) => snapshot.provider === "unknown" && modelKey(snapshot) === modelKey(target),
  )
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
} => ({
  baselines: ccusage.map((snapshot) => {
    const current = matchingLive(snapshot, ccusage, otel)
    return {
      ...snapshot,
      tokens: current?.tokens ?? zeroTokens(),
    }
  }),
  costBaselines: ccusageCosts.map((snapshot) => {
    const current = otelCosts.find((candidate) => costKey(candidate) === costKey(snapshot))
    return {
      ...snapshot,
      estimatedCostNanoUsd: current?.estimatedCostNanoUsd ?? 0,
      unpricedEvents: current?.unpricedEvents ?? 0,
    }
  }),
})

const canonicalUsage = (input: ReconciliationInput): ReadonlyArray<UsageSnapshot> => {
  const matchedLive = new Set<OtelUsageSnapshot>()
  const imported = input.ccusage.map((snapshot) => {
    const current = matchingLive(snapshot, input.ccusage, input.otel)
    if (current !== undefined) matchedLive.add(current)
    const baseline = input.baselines.find((candidate) => usageKey(candidate) === usageKey(snapshot))

    return {
      ...snapshot,
      tokens: addDelta(
        snapshot.tokens,
        current?.tokens ?? zeroTokens(),
        baseline?.tokens ?? zeroTokens(),
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
  const imported = input.ccusageCosts.map((snapshot) => {
    const current = input.otelCosts.find((candidate) => costKey(candidate) === costKey(snapshot))
    if (current !== undefined) matchedLive.add(current)
    const baseline = input.costBaselines.find(
      (candidate) => costKey(candidate) === costKey(snapshot),
    )
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

      yield* ensureUnique("ccusage usage", input.ccusage, usageKey)
      yield* ensureUnique("OTEL usage", input.otel, usageKey)
      yield* ensureUnique("usage baseline", input.baselines, usageKey)
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

      for (const snapshot of input.ccusage) {
        if (!input.baselines.some((baseline) => usageKey(baseline) === usageKey(snapshot))) {
          return yield* new InvalidInput({
            reason: `missing usage baseline: ${usageKey(snapshot).replaceAll("\u0000", "/")}`,
          })
        }
      }
      for (const snapshot of input.ccusageCosts) {
        if (!input.costBaselines.some((baseline) => costKey(baseline) === costKey(snapshot))) {
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
