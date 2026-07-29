import { Effect } from "effect"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"

import { CcusageImporter, InvalidCcusageReport, buildArguments, importerLayer } from "./index.js"

const metadata = {
  capturedAt: "2026-07-29T10:00:00.000Z",
  deviceId: "ec7100cb-d60f-479a-a136-85327ec03f8b",
  sourceVersion: "20.0.19",
  syncId: "11236047-7ee3-4238-8157-f189bbc16927",
} as const

const commonReport = JSON.stringify({
  daily: [
    {
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      date: "2026-07-29",
      inputTokens: 10,
      modelBreakdowns: [
        {
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          cost: 0.25,
          inputTokens: 10,
          modelName: "test-model",
          outputTokens: 5,
        },
      ],
      modelsUsed: ["test-model"],
      outputTokens: 5,
      totalCost: 0.25,
      totalTokens: 22,
    },
  ],
  totals: {
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    inputTokens: 10,
    outputTokens: 5,
    totalCost: 0.25,
    totalTokens: 22,
  },
})

describe("ccusage daily importer", () => {
  for (const [agent, provider] of [
    ["claude", "anthropic"],
    ["copilot", "github"],
    ["gemini", "google"],
    ["opencode", "unknown"],
  ] as const) {
    it.effect(`normalizes ${agent}'s common daily report`, () =>
      Effect.gen(function* () {
        const importer = yield* CcusageImporter
        const batch = yield* importer.importDaily({
          ...metadata,
          agent,
          stdout: commonReport,
        })

        expect(batch).toMatchObject({
          source: "ccusage-daily",
          sourceVersion: "20.0.19",
          timeZone: "UTC",
          snapshots: [
            {
              agent,
              day: "2026-07-29",
              model: "test-model",
              provider,
              tokens: {
                cacheCreationInput: 3,
                cacheReadInput: 4,
                input: 10,
                output: 5,
                reasoningOutput: 0,
                tool: 0,
              },
            },
          ],
          costs: [
            {
              agent,
              coverage: "source-reported",
              day: "2026-07-29",
              estimatedCostNanoUsd: 250_000_000,
              unpricedEvents: 0,
            },
          ],
        })
      }).pipe(Effect.provide(importerLayer)),
    )
  }

  it.effect("normalizes Codex reasoning output and model records", () =>
    Effect.gen(function* () {
      const importer = yield* CcusageImporter
      const batch = yield* importer.importDaily({
        ...metadata,
        agent: "codex",
        stdout: JSON.stringify({
          daily: [
            {
              cacheCreationTokens: 0,
              cacheReadTokens: 4,
              costUSD: 0.5,
              date: "2026-07-29",
              inputTokens: 10,
              models: {
                "gpt-test": {
                  cacheCreationTokens: 0,
                  cacheReadTokens: 4,
                  inputTokens: 10,
                  isFallback: false,
                  outputTokens: 5,
                  reasoningOutputTokens: 2,
                  totalTokens: 21,
                },
              },
              outputTokens: 5,
              reasoningOutputTokens: 2,
              totalTokens: 21,
            },
          ],
          totals: {
            cacheCreationTokens: 0,
            cacheReadTokens: 4,
            costUSD: 0.5,
            inputTokens: 10,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 21,
          },
        }),
      })

      expect(batch.snapshots).toEqual([
        {
          agent: "codex",
          day: "2026-07-29",
          model: "gpt-test",
          provider: "openai",
          tokens: {
            cacheCreationInput: 0,
            cacheReadInput: 4,
            input: 10,
            output: 5,
            reasoningOutput: 2,
            tool: 0,
          },
        },
      ])
      expect(batch.costs[0]?.estimatedCostNanoUsd).toBe(500_000_000)
    }).pipe(Effect.provide(importerLayer)),
  )

  it.effect("rejects schema drift instead of silently dropping data", () =>
    Effect.gen(function* () {
      const importer = yield* CcusageImporter
      const failure = yield* Effect.flip(
        importer.importDaily({
          ...metadata,
          agent: "claude",
          stdout: JSON.stringify({
            ...JSON.parse(commonReport),
            unexpected: true,
          }),
        }),
      )

      expect(failure).toBeInstanceOf(InvalidCcusageReport)
    }).pipe(Effect.provide(importerLayer)),
  )
})

it("builds deterministic, offline UTC ccusage arguments", () => {
  expect(
    buildArguments({
      agent: "opencode",
      since: "2026-07-01",
      until: "2026-07-29",
    }),
  ).toEqual([
    "opencode",
    "daily",
    "--json",
    "--offline",
    "--timezone",
    "UTC",
    "--since",
    "20260701",
    "--until",
    "20260729",
  ])
})
