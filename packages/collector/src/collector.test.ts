import type { OtelLiveBatch } from "@lumen-build/sync-contracts"
import { encodeRequest, type DecodedTelemetry } from "@lumen-build/sync-otlp"
import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { Collector, LiveUsageStore, UsageNormalizer, collectorLayer, inferAgent } from "./index.js"

const deviceId = "ec7100cb-d60f-479a-a136-85327ec03f8b"
const timestamp = "2026-07-29T10:00:00.000Z"
const nanos = "1785319200000000000"

const attributes = (serviceName: string): Extract<DecodedTelemetry, { readonly _tag: "Logs" }> => ({
  _tag: "Logs",
  records: [
    {
      attributes: {
        "gen_ai.request.model": "mock-model",
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 3,
      },
      eventName: "gen_ai.client.inference.operation.details",
      resourceAttributes: { "service.name": serviceName },
      timestamp,
    },
  ],
})

it("infers every primary harness identity", () => {
  expect(
    ["claude", "codex", "copilot", "gemini", "opencode", "vscode"].map((agent) =>
      inferAgent({ "service.name": `${agent}-mocked-agent` }, "gen_ai.test"),
    ),
  ).toEqual(["claude", "codex", "copilot", "gemini", "opencode", "vscode"])
})

it.effect("normalizes generic usage without retaining prompts or responses", () =>
  Effect.gen(function* () {
    const normalizer = yield* UsageNormalizer
    for (const agent of ["claude", "copilot", "gemini", "opencode", "vscode"] as const) {
      const events = yield* normalizer.normalize(attributes(`${agent}-mocked-agent`))
      expect(events[0]).toMatchObject({
        agent,
        model: "mock-model",
        occurredAt: timestamp,
        tokens: { input: 12, output: 3 },
      })
      expect(JSON.stringify(events)).not.toContain("prompt")
      expect(JSON.stringify(events)).not.toContain("response")
    }
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("deduplicates events and increments live revisions atomically", () =>
  Effect.gen(function* () {
    const normalizer = yield* UsageNormalizer
    const store = yield* LiveUsageStore
    const events = yield* normalizer.normalize(attributes("claude-mocked-agent"))

    expect(yield* store.ingest(events)).toBe(1)
    expect(yield* store.ingest(events)).toBe(0)
    const first = yield* store.snapshot("2026-07-29T10:01:00.000Z")
    expect(first.snapshots[0]?.revision).toBe(1)

    const later = yield* normalizer.normalize({
      ...attributes("claude-mocked-agent"),
      records: [
        {
          ...attributes("claude-mocked-agent").records[0]!,
          timestamp: "2026-07-29T10:02:00.000Z",
        },
      ],
    })
    expect(yield* store.ingest(later)).toBe(1)
    const second = yield* store.snapshot("2026-07-29T10:03:00.000Z")
    expect(second.snapshots[0]).toMatchObject({
      revision: 2,
      tokens: { input: 24, output: 6 },
    })
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("accepts mocked JSON and protobuf OTLP requests", () =>
  Effect.gen(function* () {
    const collector = yield* Collector
    const store = yield* LiveUsageStore

    const logResponse = yield* collector.handle(
      new Request("https://collector.lumen.build/v1/logs", {
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: "claude-mocked-agent" },
                  },
                ],
              },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      attributes: [
                        {
                          key: "gen_ai.request.model",
                          value: { stringValue: "claude-mock" },
                        },
                        {
                          key: "gen_ai.usage.input_tokens",
                          value: { intValue: "9" },
                        },
                      ],
                      eventName: "gen_ai.client.inference.operation.details",
                      timeUnixNano: nanos,
                    },
                  ],
                },
              ],
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(logResponse.status).toBe(200)

    const metricBody = encodeRequest("metrics", {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "codex-mocked-agent" },
              },
              {
                key: "model",
                value: { stringValue: "gpt-mock" },
              },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          {
                            key: "token_type",
                            value: { stringValue: "input" },
                          },
                        ],
                        sum: 7,
                        timeUnixNano: nanos,
                      },
                    ],
                  },
                  name: "codex.turn.token_usage",
                  unit: "{token}",
                },
              ],
            },
          ],
        },
      ],
    })
    const metricResponse = yield* collector.handle(
      new Request("https://collector.lumen.build/v1/metrics", {
        body: new Uint8Array(metricBody).buffer,
        headers: { "content-type": "application/x-protobuf" },
        method: "POST",
      }),
    )
    expect(metricResponse.status).toBe(200)
    expect(metricResponse.headers.get("content-type")).toContain("application/x-protobuf")

    const snapshot: OtelLiveBatch = yield* store.snapshot("2026-07-29T10:05:00.000Z")
    expect(snapshot.snapshots).toHaveLength(2)
    expect(snapshot.snapshots.map((item) => item.agent)).toEqual(["claude", "codex"])
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)
