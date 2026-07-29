import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as BunServices from "@effect/platform-bun/BunServices"
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

const logRequest = (
  records: ReadonlyArray<{
    readonly cost?: number | string
    readonly eventId?: string
    readonly input?: number
    readonly model?: string
    readonly output?: number
    readonly provider?: string
    readonly timeUnixNano?: string
  }>,
): Request =>
  new Request("https://collector.lumen.build/v1/logs", {
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "opencode-mocked-agent" },
              },
            ],
          },
          scopeLogs: [
            {
              logRecords: records.map(
                ({
                  cost,
                  eventId,
                  input = 0,
                  model = "mock-model",
                  output = 0,
                  provider = "mock-provider",
                  timeUnixNano = nanos,
                }) => ({
                  attributes: [
                    {
                      key: "gen_ai.request.model",
                      value: { stringValue: model },
                    },
                    {
                      key: "gen_ai.provider.name",
                      value: { stringValue: provider },
                    },
                    {
                      key: "gen_ai.usage.input_tokens",
                      value: { intValue: String(input) },
                    },
                    {
                      key: "gen_ai.usage.output_tokens",
                      value: { intValue: String(output) },
                    },
                    ...(cost === undefined
                      ? []
                      : [
                          {
                            key: "gen_ai.usage.cost",
                            value: { stringValue: String(cost) },
                          },
                        ]),
                    ...(eventId === undefined
                      ? []
                      : [
                          {
                            key: "lumen.source.event_id",
                            value: { stringValue: eventId },
                          },
                        ]),
                  ],
                  eventName: "gen_ai.client.inference.operation.details",
                  timeUnixNano,
                }),
              ),
            },
          ],
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

const usageEvent = (
  fingerprint: string,
  occurredAt: string,
  input = 1,
  sourceReportedCostNanoUsd?: number,
) => ({
  agent: "opencode" as const,
  fingerprint,
  model: "mocked-model",
  occurredAt,
  provider: "mocked-provider",
  sourceName: "mocked",
  ...(sourceReportedCostNanoUsd === undefined ? {} : { sourceReportedCostNanoUsd }),
  sourceSignal: "logs" as const,
  tokens: {
    cacheCreationInput: 0,
    cacheReadInput: 0,
    input,
    output: 0,
    reasoningOutput: 0,
    tool: 0,
  },
})

it("infers every primary harness identity", () => {
  expect(
    ["claude", "codex", "copilot", "gemini", "opencode", "vscode"].map((agent) =>
      inferAgent({ "service.name": `${agent}-mocked-agent` }, "gen_ai.test"),
    ),
  ).toEqual(["claude", "codex", "copilot", "gemini", "opencode", "vscode"])
})

it.effect("uses logs only for OpenCode and unknown emitters", () =>
  Effect.gen(function* () {
    const normalizer = yield* UsageNormalizer
    const events = yield* normalizer.normalize(attributes("opencode-mocked-agent"))
    expect(events[0]).toMatchObject({
      agent: "opencode",
      model: "mock-model",
      occurredAt: timestamp,
      tokens: { input: 12, output: 3 },
    })
    expect(yield* normalizer.normalize(attributes("claude-mocked-agent"))).toEqual([])
    expect(JSON.stringify(events)).not.toContain("prompt")
    expect(JSON.stringify(events)).not.toContain("response")
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("normalizes the official token metrics from five native OTEL harnesses", () =>
  Effect.gen(function* () {
    const normalizer = yield* UsageNormalizer
    const metric = (
      serviceName: string,
      name: string,
      type: string,
      dataKind: "histogram" | "sum" = "sum",
    ): Extract<DecodedTelemetry, { readonly _tag: "Metrics" }>["metrics"][number] => ({
      dataKind,
      name,
      points: [
        {
          attributes: {
            [name === "codex.turn.token_usage"
              ? "token_type"
              : name === "gen_ai.client.token.usage"
                ? "gen_ai.token.type"
                : "type"]: type,
          },
          timestamp,
          value: 7,
        },
      ],
      resourceAttributes: {
        "gen_ai.request.model": "mock-model",
        "service.name": serviceName,
      },
      temporality: "delta",
      unit: "{token}",
    })
    const events = yield* normalizer.normalize({
      _tag: "Metrics",
      metrics: [
        metric("claude-code", "claude_code.token.usage", "input"),
        metric("codex", "codex.turn.token_usage", "input", "histogram"),
        metric("github-copilot", "gen_ai.client.token.usage", "input"),
        metric("gemini-cli", "gemini_cli.token.usage", "thought"),
        metric("vscode", "gen_ai.client.token.usage", "output"),
      ],
    })

    expect(events.map((event) => event.agent)).toEqual([
      "claude",
      "codex",
      "copilot",
      "gemini",
      "vscode",
    ])
    expect(events[3]?.tokens.reasoningOutput).toBe(7)
    expect(events[4]?.tokens.output).toBe(7)
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("deduplicates events and increments live revisions atomically", () =>
  Effect.gen(function* () {
    const normalizer = yield* UsageNormalizer
    const store = yield* LiveUsageStore
    const events = yield* normalizer.normalize(attributes("opencode-mocked-agent"))

    expect(yield* store.generation).toBe(0)
    expect(yield* store.ingest(events)).toBe(1)
    expect(yield* store.generation).toBe(1)
    expect(yield* store.ingest(events)).toBe(0)
    expect(yield* store.generation).toBe(1)
    expect(yield* store.snapshotAfter("2026-07-29T10:01:00.000Z", 1)).toBeUndefined()
    const first = yield* store.snapshot("2026-07-29T10:01:00.000Z")
    expect(first.snapshots[0]?.revision).toBe(1)

    const later = yield* normalizer.normalize({
      ...attributes("opencode-mocked-agent"),
      records: [
        {
          ...attributes("opencode-mocked-agent").records[0]!,
          timestamp: "2026-07-29T10:02:00.000Z",
        },
      ],
    })
    expect(yield* store.ingest(later)).toBe(1)
    const versioned = yield* store.snapshotAfter("2026-07-29T10:03:00.000Z", 1)
    expect(versioned?.generation).toBe(2)
    const second = versioned!.batch
    expect(second.snapshots[0]).toMatchObject({
      revision: 2,
      tokens: { input: 24, output: 6 },
    })
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("uses OpenCode event IDs for deduplication and aggregates source-reported costs", () =>
  Effect.gen(function* () {
    const collector = yield* Collector
    const store = yield* LiveUsageStore
    const first = {
      cost: "0.25",
      eventId: "opencode-event-one",
      input: 12,
      model: "mock-model",
      output: 3,
      provider: "mock-provider",
    }
    const second = {
      ...first,
      eventId: "opencode-event-two",
    }

    expect((yield* collector.handle(logRequest([first, second]))).status).toBe(200)
    expect(yield* store.generation).toBe(1)

    const accepted = yield* store.snapshot("2026-07-29T10:01:00.000Z")
    expect(accepted.snapshots).toMatchObject([
      {
        revision: 2,
        tokens: { input: 24, output: 6 },
      },
    ])
    expect(accepted.costs).toEqual([
      {
        agent: "opencode",
        coverage: "source-reported",
        day: "2026-07-29",
        estimatedCostNanoUsd: 500_000_000,
        revision: 2,
        unpricedEvents: 0,
      },
    ])
    expect(JSON.stringify(accepted)).not.toContain("opencode-event")

    expect((yield* collector.handle(logRequest([first]))).status).toBe(200)
    expect(yield* store.generation).toBe(1)
    expect(yield* store.snapshot("2026-07-29T10:02:00.000Z")).toMatchObject({
      costs: [{ estimatedCostNanoUsd: 500_000_000, revision: 2 }],
      snapshots: [{ revision: 2, tokens: { input: 24, output: 6 } }],
    })
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("restores acknowledged revisions and fingerprints from a private checkpoint", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-collector-state-"))),
    (directory) => {
      const statePath = join(directory, "collector.json")
      const layer = () => collectorLayer({ deviceId, maxBodyBytes: 1_000_000, statePath })
      const firstEvent = usageEvent("checkpoint-one", timestamp, 1, 250_000_000)
      const secondEvent = usageEvent("checkpoint-two", "2026-07-29T10:01:00.000Z", 1, 500_000_000)

      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const store = yield* LiveUsageStore
          expect(yield* store.ingest([firstEvent, secondEvent])).toBe(2)
          const snapshot = yield* store.snapshot(timestamp)
          expect(snapshot.snapshots[0]?.revision).toBe(2)
          expect(snapshot.costs[0]).toMatchObject({
            estimatedCostNanoUsd: 750_000_000,
            revision: 2,
          })
          yield* store.checkpoint
        }).pipe(Effect.provide(layer()))

        if (process.platform !== "win32") {
          expect((yield* Effect.promise(() => stat(statePath))).mode & 0o777).toBe(0o600)
        }

        yield* Effect.gen(function* () {
          const store = yield* LiveUsageStore
          expect(yield* store.generation).toBe(1)
          expect(yield* store.ingest([firstEvent])).toBe(0)
          expect(
            yield* store.ingest([
              usageEvent("checkpoint-three", "2026-07-29T10:02:00.000Z", 1, 125_000_000),
            ]),
          ).toBe(1)
          const restored = yield* store.snapshot("2026-07-29T10:03:00.000Z")
          expect(restored.snapshots[0]).toMatchObject({
            revision: 3,
            tokens: { input: 3 },
          })
          expect(restored.costs[0]).toMatchObject({
            estimatedCostNanoUsd: 875_000_000,
            revision: 3,
          })
        }).pipe(Effect.provide(layer()))
      })
    },
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  ).pipe(Effect.provide(BunServices.layer)),
)

it.effect("bounds live fingerprint retention and prunes old buckets", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore

    expect(yield* store.ingest([usageEvent("day-one", "2026-07-01T00:00:00.000Z")])).toBe(1)
    expect(yield* store.ingest([usageEvent("day-two", "2026-07-02T00:00:00.000Z")])).toBe(1)
    expect(yield* store.ingest([usageEvent("day-three", "2026-07-03T00:00:00.000Z")])).toBe(1)
    const snapshot = yield* store.snapshot("2026-07-03T00:01:00.000Z")
    expect(snapshot.snapshots.map(({ day }) => day)).toEqual(["2026-07-02", "2026-07-03"])

    expect(yield* store.ingest([usageEvent("day-one", "2026-07-03T00:02:00.000Z")])).toBe(1)
  }).pipe(
    Effect.provide(
      collectorLayer({
        deviceId,
        maxBodyBytes: 1_000_000,
        maxFingerprints: 2,
        retentionDays: 2,
      }),
    ),
  ),
)

it.effect("rejects bucket-limit overflow atomically and remains usable", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore
    const first = usageEvent("first", timestamp)

    expect(yield* store.ingest([first])).toBe(1)
    expect(
      yield* Effect.result(
        store.ingest([
          usageEvent("update", "2026-07-29T10:01:00.000Z", 2),
          {
            ...usageEvent("second-bucket", "2026-07-29T10:01:00.000Z", 3),
            model: "another-model",
          },
        ]),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: "live usage bucket limit exceeded (1)",
      },
    })

    expect(yield* store.generation).toBe(1)
    expect((yield* store.snapshot("2026-07-29T10:02:00.000Z")).snapshots).toMatchObject([
      {
        revision: 1,
        tokens: { input: 1 },
      },
    ])

    expect(yield* store.ingest([usageEvent("after-rejection", "2026-07-29T10:03:00.000Z")])).toBe(1)
    expect((yield* store.snapshot("2026-07-29T10:04:00.000Z")).snapshots[0]).toMatchObject({
      revision: 2,
      tokens: { input: 2 },
    })
  }).pipe(
    Effect.provide(
      collectorLayer({
        deviceId,
        maxBodyBytes: 1_000_000,
        maxBuckets: 1,
      }),
    ),
  ),
)

it.effect("reclaims expired bucket cardinality before enforcing the bucket limit", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore

    expect(yield* store.ingest([usageEvent("old", "2026-07-01T00:00:00.000Z")])).toBe(1)
    expect(
      yield* store.ingest([
        {
          ...usageEvent("replacement", "2026-07-03T00:00:00.000Z"),
          model: "replacement-model",
        },
      ]),
    ).toBe(1)

    expect(yield* store.snapshot("2026-07-03T00:01:00.000Z")).toMatchObject({
      snapshots: [{ day: "2026-07-03", model: "replacement-model" }],
    })
  }).pipe(
    Effect.provide(
      collectorLayer({
        deviceId,
        maxBodyBytes: 1_000_000,
        maxBuckets: 1,
        retentionDays: 2,
      }),
    ),
  ),
)

it.effect("ignores events outside retention without advancing the generation", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore

    expect(yield* store.ingest([usageEvent("current", "2026-07-03T00:00:00.000Z")])).toBe(1)
    expect(yield* store.ingest([usageEvent("stale", "2026-07-01T00:00:00.000Z")])).toBe(1)
    expect(yield* store.generation).toBe(1)
    expect(yield* store.snapshotAfter("2026-07-03T00:01:00.000Z", 1)).toBeUndefined()
  }).pipe(
    Effect.provide(
      collectorLayer({
        deviceId,
        maxBodyBytes: 1_000_000,
        retentionDays: 2,
      }),
    ),
  ),
)

it.effect("retains exactly 45 days and expires fingerprints with their day partition", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore
    const first = usageEvent("boundary", "2026-07-01T00:00:00.000Z")

    expect(yield* store.ingest([first])).toBe(1)
    expect(yield* store.ingest([usageEvent("day-45", "2026-08-14T00:00:00.000Z")])).toBe(1)
    expect(yield* store.ingest([first])).toBe(0)

    expect(yield* store.ingest([usageEvent("day-46", "2026-08-15T00:00:00.000Z")])).toBe(1)
    expect(yield* store.ingest([usageEvent("boundary", "2026-08-15T00:01:00.000Z")])).toBe(1)

    const snapshot = yield* store.snapshot("2026-08-15T00:02:00.000Z")
    expect(snapshot.snapshots.map(({ day }) => day)).toEqual(["2026-08-14", "2026-08-15"])

    expect(yield* store.ingest([usageEvent("far-future", "2027-01-01T00:00:00.000Z")])).toBe(1)
    expect(yield* store.ingest([usageEvent("boundary", "2027-01-01T00:01:00.000Z")])).toBe(1)
    expect(
      (yield* store.snapshot("2027-01-01T00:02:00.000Z")).snapshots.map(({ day }) => day),
    ).toEqual(["2027-01-01"])
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("keeps FIFO dedupe state bounded under sustained ingestion", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore
    const events = Array.from({ length: 10 }, (_, index) =>
      usageEvent(`event-${index}`, `2026-07-29T10:00:${String(index).padStart(2, "0")}.000Z`),
    )

    for (const event of events) expect(yield* store.ingest([event])).toBe(1)
    expect(yield* store.ingest([events.at(-1)!])).toBe(0)
    expect(yield* store.ingest([events[0]!])).toBe(1)
    expect(yield* store.generation).toBe(11)

    const snapshot = yield* store.snapshot("2026-07-29T10:01:00.000Z")
    expect(snapshot.snapshots[0]?.tokens.input).toBe(11)
  }).pipe(
    Effect.provide(
      collectorLayer({
        deviceId,
        maxBodyBytes: 1_000_000,
        maxFingerprints: 3,
      }),
    ),
  ),
)

it.effect("rejects a poisoned normalized batch without mutating the store", () =>
  Effect.gen(function* () {
    const collector = yield* Collector
    const store = yield* LiveUsageStore
    const valid = { input: 7, model: "good-model", provider: "good-provider" }
    const poisoned = [
      { input: 1, model: "", provider: "good-provider" },
      { input: 1, model: "x".repeat(257), provider: "good-provider" },
      { input: 1, model: "good-model", provider: "" },
      { input: 1, model: "good-model", provider: "x".repeat(257) },
      { input: -1, model: "good-model", provider: "good-provider" },
      { input: Number.MAX_SAFE_INTEGER + 1, model: "good-model", provider: "good-provider" },
      { cost: -1, input: 1, model: "good-model", provider: "good-provider" },
      {
        cost: Number.MAX_SAFE_INTEGER,
        input: 1,
        model: "good-model",
        provider: "good-provider",
      },
    ]

    for (const poison of poisoned) {
      const result = yield* collector.handle(logRequest([valid, poison]))
      expect(result.status).toBe(400)
      expect(yield* store.generation).toBe(0)
      expect((yield* store.snapshot("2026-07-29T10:01:00.000Z")).snapshots).toEqual([])
    }

    expect((yield* collector.handle(logRequest([valid]))).status).toBe(200)
    const snapshot = yield* store.snapshot("2026-07-29T10:01:00.000Z")
    expect(snapshot.snapshots[0]).toMatchObject({
      revision: 1,
      tokens: { input: 7 },
    })
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("rejects checked-add overflow and remains usable", () =>
  Effect.gen(function* () {
    const collector = yield* Collector
    const store = yield* LiveUsageStore

    expect(
      (yield* collector.handle(
        logRequest([
          {
            input: Number.MAX_SAFE_INTEGER,
            timeUnixNano: "1785319200000000000",
          },
        ]),
      )).status,
    ).toBe(200)
    expect(
      (yield* collector.handle(logRequest([{ input: 1, timeUnixNano: "1785319260000000000" }])))
        .status,
    ).toBe(400)
    expect(yield* store.generation).toBe(1)

    expect(
      (yield* collector.handle(logRequest([{ output: 1, timeUnixNano: "1785319320000000000" }])))
        .status,
    ).toBe(200)
    const snapshot = yield* store.snapshot("2026-07-29T10:03:00.000Z")
    expect(snapshot.snapshots[0]).toMatchObject({
      revision: 2,
      tokens: { input: Number.MAX_SAFE_INTEGER, output: 1 },
    })
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("rejects source-reported cost overflow atomically and remains usable", () =>
  Effect.gen(function* () {
    const store = yield* LiveUsageStore
    const maximum = usageEvent(
      "maximum-cost",
      "2026-07-29T10:00:00.000Z",
      1,
      Number.MAX_SAFE_INTEGER,
    )

    expect(yield* store.ingest([maximum])).toBe(1)
    expect(
      yield* Effect.result(
        store.ingest([
          usageEvent("overflow-cost", "2026-07-29T10:01:00.000Z", 10, 1),
          usageEvent("second-model", "2026-07-29T10:01:00.000Z", 10),
        ]),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: "usage cost aggregate exceeds safe integer bounds",
      },
    })

    expect(yield* store.generation).toBe(1)
    expect(yield* store.snapshot("2026-07-29T10:02:00.000Z")).toMatchObject({
      costs: [{ estimatedCostNanoUsd: Number.MAX_SAFE_INTEGER, revision: 1 }],
      snapshots: [{ revision: 1, tokens: { input: 1 } }],
    })

    expect(
      yield* store.ingest([usageEvent("after-cost-rejection", "2026-07-29T10:03:00.000Z")]),
    ).toBe(1)
    expect(yield* store.generation).toBe(2)
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
                    value: { stringValue: "opencode-mocked-agent" },
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
                          value: { stringValue: "opencode-mock" },
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
    expect(snapshot.snapshots.map((item) => item.agent)).toEqual(["codex", "opencode"])
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 1_000_000 }))),
)

it.effect("rejects chunked and decompressed bodies at the configured byte limit", () =>
  Effect.gen(function* () {
    const collector = yield* Collector
    const oversized = yield* collector.handle(
      new Request("https://collector.lumen.build/v1/logs", {
        body: "x".repeat(101),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    expect(oversized.status).toBe(413)

    const compressed = yield* Effect.promise(async () =>
      new Response(
        new Blob(["x".repeat(1_000)]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    )
    const decompressionBomb = yield* collector.handle(
      new Request("https://collector.lumen.build/v1/logs", {
        body: compressed,
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    )
    expect(decompressionBomb.status).toBe(413)
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 100 }))),
)

it.effect("rejects unsupported content encoding before accessing the request body", () =>
  Effect.gen(function* () {
    const collector = yield* Collector
    let bodyAccessed = false
    const request = {
      get body() {
        bodyAccessed = true
        throw new Error("body must not be accessed")
      },
      headers: new Headers({
        "content-encoding": "br",
        "content-type": "application/json",
      }),
      method: "POST",
      url: "https://collector.lumen.build/v1/logs",
    } as unknown as Request

    expect((yield* collector.handle(request)).status).toBe(415)
    expect(bodyAccessed).toBe(false)
  }).pipe(Effect.provide(collectorLayer({ deviceId, maxBodyBytes: 100 }))),
)
