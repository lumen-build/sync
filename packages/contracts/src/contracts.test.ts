import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CcusageDailyBatch,
  CliEvent,
  OtelLiveBatch,
  UsagePrincipal,
  UsageSnapshot,
  addUsageTokens,
  defaultProviderForAgent,
  emptyUsageTokens,
  usageSnapshotKey,
} from "./index.js"

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
} satisfies typeof UsageSnapshot.Type

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

  it("owns token algebra and snapshot identity semantics", () => {
    expect(addUsageTokens(emptyUsageTokens(), snapshot.tokens)).toEqual(snapshot.tokens)
    expect(usageSnapshotKey(snapshot)).toBe("2026-07-29\u0000codex\u0000openai\u0000gpt-5.6")
    expect(defaultProviderForAgent("vscode")).toBe("github")
  })

  it("validates versioned CLI events without accepting malformed errors", () => {
    expect(
      Schema.is(CliEvent)({
        protocolVersion: 1,
        sequence: 1,
        timestamp: "2026-07-29T10:00:00.000Z",
        command: "collector.run",
        type: "ready",
        data: { address: "http://127.0.0.1:4318" },
      }),
    ).toBe(true)

    expect(
      Schema.is(CliEvent)({
        protocolVersion: 1,
        sequence: 2,
        timestamp: "2026-07-29T10:00:01.000Z",
        command: "collector.run",
        type: "error",
        error: {
          code: "",
          message: "failed",
          retryable: false,
        },
      }),
    ).toBe(false)
  })
})
