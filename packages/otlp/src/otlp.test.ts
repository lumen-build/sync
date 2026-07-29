import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { OtlpCodec, encodeRequest, layer } from "./index.js"

const nanos = "1785319200000000000"

const logRequest = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          {
            key: "service.name",
            value: { stringValue: "mocked-agent" },
          },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              attributes: [
                {
                  key: "gen_ai.usage.input_tokens",
                  value: { intValue: "12" },
                },
              ],
              eventName: "gen_ai.client.inference.operation.details",
              timeUnixNano: nanos,
              traceId: "00112233445566778899aabbccddeeff",
            },
          ],
        },
      ],
    },
  ],
}

it.effect("decodes standard OTLP JSON identifiers and attributes", () =>
  Effect.gen(function* () {
    const codec = yield* OtlpCodec
    const decoded = yield* codec.decode({
      body: new TextEncoder().encode(JSON.stringify(logRequest)),
      encoding: "json",
      signal: "logs",
    })

    expect(decoded).toEqual({
      _tag: "Logs",
      records: [
        {
          attributes: { "gen_ai.usage.input_tokens": 12 },
          eventName: "gen_ai.client.inference.operation.details",
          resourceAttributes: { "service.name": "mocked-agent" },
          timestamp: "2026-07-29T10:00:00.000Z",
          traceId: "00112233445566778899aabbccddeeff",
        },
      ],
    })
  }).pipe(Effect.provide(layer)),
)

it.effect("decodes protobuf metrics", () =>
  Effect.gen(function* () {
    const codec = yield* OtlpCodec
    const body = encodeRequest("metrics", {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "mocked-agent" },
              },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "gen_ai.client.token.usage",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        asInt: 7,
                        attributes: [
                          {
                            key: "gen_ai.token.type",
                            value: { stringValue: "input" },
                          },
                        ],
                        timeUnixNano: nanos,
                      },
                    ],
                  },
                  unit: "{token}",
                },
              ],
            },
          ],
        },
      ],
    })
    const decoded = yield* codec.decode({
      body,
      encoding: "protobuf",
      signal: "metrics",
    })

    expect(decoded).toEqual({
      _tag: "Metrics",
      metrics: [
        {
          dataKind: "sum",
          name: "gen_ai.client.token.usage",
          points: [
            {
              attributes: { "gen_ai.token.type": "input" },
              timestamp: "2026-07-29T10:00:00.000Z",
              value: 7,
            },
          ],
          resourceAttributes: { "service.name": "mocked-agent" },
          temporality: "delta",
          unit: "{token}",
        },
      ],
    })
  }).pipe(Effect.provide(layer)),
)

it.effect("decodes protobuf traces", () =>
  Effect.gen(function* () {
    const codec = yield* OtlpCodec
    const body = encodeRequest("traces", {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    {
                      key: "gen_ai.request.model",
                      value: { stringValue: "mock-model" },
                    },
                  ],
                  endTimeUnixNano: "1785319200250000000",
                  name: "chat mock-model",
                  startTimeUnixNano: nanos,
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    })
    const decoded = yield* codec.decode({
      body,
      encoding: "protobuf",
      signal: "traces",
    })

    expect(decoded).toEqual({
      _tag: "Traces",
      spans: [
        {
          attributes: { "gen_ai.request.model": "mock-model" },
          durationMillis: 250,
          name: "chat mock-model",
          resourceAttributes: {},
          statusCode: 1,
          timestamp: "2026-07-29T10:00:00.000Z",
        },
      ],
    })
  }).pipe(Effect.provide(layer)),
)
