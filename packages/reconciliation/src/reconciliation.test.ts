import type {
  OtelUsageCostSnapshot,
  OtelUsageSnapshot,
  UsageCostSnapshot,
  UsageSnapshot,
} from "@lumen-build/sync-contracts"
import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { PolicyRequired, Reconciliation, InvalidInput, captureBaseline, layer } from "./index.js"

const daily = (input: number, provider = "openai"): UsageSnapshot => ({
  agent: "codex",
  day: "2026-07-29",
  model: "gpt-5.6",
  provider,
  tokens: {
    cacheCreationInput: 0,
    cacheReadInput: 0,
    input,
    output: 0,
    reasoningOutput: 0,
    tool: 0,
  },
})

const live = (input: number, revision = 1, provider = "openai"): OtelUsageSnapshot => ({
  ...daily(input, provider),
  revision,
})

const dailyCost = (amount: number): UsageCostSnapshot => ({
  agent: "codex",
  coverage: "source-reported",
  day: "2026-07-29",
  estimatedCostNanoUsd: amount,
  unpricedEvents: 0,
})

const liveCost = (amount: number, revision = 1): OtelUsageCostSnapshot => ({
  ...dailyCost(amount),
  coverage: "complete",
  revision,
})

it.effect("requires an explicit reconciliation policy", () =>
  Effect.gen(function* () {
    const service = yield* Reconciliation
    const failure = yield* Effect.flip(
      service.reconcile({
        baselines: [],
        costBaselines: [],
        ccusage: [],
        ccusageCosts: [],
        otel: [live(100)],
        otelCosts: [],
      }),
    )

    expect(failure).toBeInstanceOf(PolicyRequired)
  }).pipe(Effect.provide(layer)),
)

it.effect("keeps raw sources separate without inventing a total", () =>
  Effect.gen(function* () {
    const service = yield* Reconciliation
    const result = yield* service.reconcile({
      policy: "separate",
      baselines: [],
      costBaselines: [],
      ccusage: [daily(150)],
      ccusageCosts: [],
      otel: [live(100)],
      otelCosts: [],
    })

    expect(result).toEqual({
      _tag: "Separate",
      ccusage: [daily(150)],
      ccusageCosts: [],
      otel: [live(100)],
      otelCosts: [],
    })
  }).pipe(Effect.provide(layer)),
)

it.effect("keeps only the explicitly authoritative source", () =>
  Effect.gen(function* () {
    const service = yield* Reconciliation
    const shared = {
      baselines: [],
      ccusage: [daily(150)],
      ccusageCosts: [dailyCost(1_500)],
      costBaselines: [],
      otel: [live(100, 3)],
      otelCosts: [liveCost(1_000, 3)],
    }

    expect(yield* service.reconcile({ ...shared, policy: "otel-only" })).toEqual({
      _tag: "Canonical",
      costs: [{ ...dailyCost(1_000), coverage: "complete" }],
      policy: "otel-only",
      snapshots: [daily(100)],
    })
    expect(yield* service.reconcile({ ...shared, policy: "ccusage-only" })).toEqual({
      _tag: "Canonical",
      costs: [dailyCost(1_500)],
      policy: "ccusage-only",
      snapshots: [daily(150)],
    })
  }).pipe(Effect.provide(layer)),
)

it.effect("uses ccusage as a baseline and adds only later live deltas", () =>
  Effect.gen(function* () {
    const service = yield* Reconciliation
    const baseline = captureBaseline({
      ccusage: [daily(150)],
      ccusageCosts: [dailyCost(1_500)],
      otel: [live(100)],
      otelCosts: [liveCost(1_000)],
    })
    const result = yield* service.reconcile({
      policy: "ccusage-baseline-live-delta",
      ...baseline,
      ccusage: [daily(150)],
      ccusageCosts: [dailyCost(1_500)],
      otel: [live(130, 2)],
      otelCosts: [liveCost(1_300, 2)],
    })

    expect(result).toEqual({
      _tag: "Canonical",
      policy: "ccusage-baseline-live-delta",
      snapshots: [daily(180)],
      costs: [
        {
          ...dailyCost(1_800),
          coverage: "source-reported",
        },
      ],
    })
  }).pipe(Effect.provide(layer)),
)

it.effect("rejects an incomplete baseline instead of risking double counting", () =>
  Effect.gen(function* () {
    const service = yield* Reconciliation
    const failure = yield* Effect.flip(
      service.reconcile({
        policy: "ccusage-baseline-live-delta",
        baselines: [],
        costBaselines: [],
        ccusage: [daily(150)],
        ccusageCosts: [],
        otel: [live(100)],
        otelCosts: [],
      }),
    )

    expect(failure).toBeInstanceOf(InvalidInput)
  }).pipe(Effect.provide(layer)),
)

it.effect("reconciles unknown providers only when the daily match is unambiguous", () =>
  Effect.gen(function* () {
    const service = yield* Reconciliation
    const oneDaily = daily(150)
    const unknownLive = live(100, 1, "unknown")
    const baseline = captureBaseline({
      ccusage: [oneDaily],
      ccusageCosts: [],
      otel: [unknownLive],
      otelCosts: [],
    })
    const unambiguous = yield* service.reconcile({
      policy: "ccusage-baseline-live-delta",
      ...baseline,
      ccusage: [oneDaily],
      ccusageCosts: [],
      otel: [live(130, 2, "unknown")],
      otelCosts: [],
    })
    expect(unambiguous._tag).toBe("Canonical")
    if (unambiguous._tag === "Canonical") {
      expect(unambiguous.snapshots).toEqual([daily(180)])
    }

    const ambiguousDaily = [daily(150, "openai"), daily(40, "azure")]
    const ambiguousBaseline = captureBaseline({
      ccusage: ambiguousDaily,
      ccusageCosts: [],
      otel: [unknownLive],
      otelCosts: [],
    })
    const ambiguous = yield* service.reconcile({
      policy: "ccusage-baseline-live-delta",
      ...ambiguousBaseline,
      ccusage: ambiguousDaily,
      ccusageCosts: [],
      otel: [live(130, 2, "unknown")],
      otelCosts: [],
    })
    expect(ambiguous._tag).toBe("Canonical")
    if (ambiguous._tag === "Canonical") {
      expect(ambiguous.snapshots).toEqual([
        daily(40, "azure"),
        daily(150, "openai"),
        daily(130, "unknown"),
      ])
    }
  }).pipe(Effect.provide(layer)),
)
