import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { CcusageDailyBatch, OtelLiveBatch, UsagePrincipal, UsageSnapshot } from "./index.js"

const snapshot = {
  agent: "codex",
  day: "2026-07-29",
  model: "gpt-5.6",
  provider: "openai",
  tokens: {
    cacheCreationInput: 0,
    cacheReadInput: 20,
    input: 100,
    output: 30,
    reasoningOutput: 10,
    tool: 0,
  },
}

describe("public usage contracts", () => {
  it("accepts distinct live and daily source envelopes", () => {
    expect(
      Schema.is(OtelLiveBatch)({
        source: "otel-live",
        capturedAt: "2026-07-29T10:00:00.000Z",
        deviceId: "ec7100cb-d60f-479a-a136-85327ec03f8b",
        snapshots: [{ ...snapshot, revision: 1 }],
        costs: [],
      }),
    ).toBe(true)

    expect(
      Schema.is(CcusageDailyBatch)({
        source: "ccusage-daily",
        capturedAt: "2026-07-29T11:00:00.000Z",
        deviceId: "ec7100cb-d60f-479a-a136-85327ec03f8b",
        syncId: "11236047-7ee3-4238-8157-f189bbc16927",
        sourceVersion: "20.0.19",
        timeZone: "UTC",
        snapshots: [snapshot],
        costs: [],
      }),
    ).toBe(true)
  })

  it("rejects malformed source data and untrusted empty principals", () => {
    expect(
      Schema.is(UsageSnapshot)({
        ...snapshot,
        tokens: { ...snapshot.tokens, input: -1 },
      }),
    ).toBe(false)
    expect(
      Schema.is(UsagePrincipal)({
        subjectId: "",
        scheme: "oidc",
        claims: {},
      }),
    ).toBe(false)
  })
})
