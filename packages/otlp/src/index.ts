import { Context, Effect, Layer, Schema } from "effect"
import { parse, type Type } from "protobufjs"

import { OTLP_PROTO } from "./proto.js"

export const OtlpSignal = Schema.Literals(["logs", "metrics", "traces"])
export type OtlpSignal = typeof OtlpSignal.Type

export type OtlpEncoding = "json" | "protobuf"

export type OtlpValue =
  | boolean
  | number
  | string
  | Uint8Array
  | ReadonlyArray<OtlpValue>
  | { readonly [key: string]: OtlpValue }

export interface OtlpLogRecord {
  readonly attributes: Readonly<Record<string, OtlpValue>>
  readonly eventName?: string
  readonly observedTimestamp?: string
  readonly resourceAttributes: Readonly<Record<string, OtlpValue>>
  readonly spanId?: string
  readonly timestamp?: string
  readonly traceId?: string
}

export type MetricDataKind = "gauge" | "histogram" | "sum"
export type MetricTemporality = "cumulative" | "delta" | "unspecified"

export interface OtlpMetricPoint {
  readonly attributes: Readonly<Record<string, OtlpValue>>
  readonly startTimestamp?: string
  readonly timestamp?: string
  readonly value?: number
}

export interface OtlpMetric {
  readonly dataKind: MetricDataKind
  readonly name: string
  readonly points: ReadonlyArray<OtlpMetricPoint>
  readonly resourceAttributes: Readonly<Record<string, OtlpValue>>
  readonly temporality: MetricTemporality
  readonly unit: string
}

export interface OtlpSpan {
  readonly attributes: Readonly<Record<string, OtlpValue>>
  readonly durationMillis?: number
  readonly name: string
  readonly resourceAttributes: Readonly<Record<string, OtlpValue>>
  readonly statusCode: number
  readonly timestamp?: string
}

export type DecodedTelemetry =
  | { readonly _tag: "Logs"; readonly records: ReadonlyArray<OtlpLogRecord> }
  | { readonly _tag: "Metrics"; readonly metrics: ReadonlyArray<OtlpMetric> }
  | { readonly _tag: "Traces"; readonly spans: ReadonlyArray<OtlpSpan> }

export interface DecodeRequest {
  readonly body: Uint8Array
  readonly encoding: OtlpEncoding
  readonly signal: OtlpSignal
}

export class OtlpDecodeError extends Schema.TaggedErrorClass<OtlpDecodeError>()("OtlpDecodeError", {
  signal: OtlpSignal,
}) {}

export class UnsupportedMediaType extends Schema.TaggedErrorClass<UnsupportedMediaType>()(
  "UnsupportedMediaType",
  {
    contentType: Schema.String,
  },
) {}

export interface OtlpCodecInterface {
  readonly decode: (request: DecodeRequest) => Effect.Effect<DecodedTelemetry, OtlpDecodeError>
  readonly encodeFailure: (message: string, encoding: OtlpEncoding) => Effect.Effect<Uint8Array>
  readonly encodeSuccess: (signal: OtlpSignal, encoding: OtlpEncoding) => Effect.Effect<Uint8Array>
}

export class OtlpCodec extends Context.Service<OtlpCodec, OtlpCodecInterface>()(
  "@lumen-build/sync/OtlpCodec",
) {}

type WireRecord = Record<string, unknown>

const root = parse(OTLP_PROTO).root

const requestTypes: Readonly<Record<OtlpSignal, string>> = {
  logs: "lumen.otlp.ExportLogsServiceRequest",
  metrics: "lumen.otlp.ExportMetricsServiceRequest",
  traces: "lumen.otlp.ExportTraceServiceRequest",
}

const responseTypes: Readonly<Record<OtlpSignal, string>> = {
  logs: "lumen.otlp.ExportLogsServiceResponse",
  metrics: "lumen.otlp.ExportMetricsServiceResponse",
  traces: "lumen.otlp.ExportTraceServiceResponse",
}

const requestType = (signal: OtlpSignal): Type => root.lookupType(requestTypes[signal])
const responseType = (signal: OtlpSignal): Type => root.lookupType(responseTypes[signal])

const asRecord = (value: unknown): WireRecord =>
  typeof value === "object" && value !== null ? (value as WireRecord) : {}

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

const numberFromUnknown = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    const number = Number(String(value))
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

const bigintFromUnknown = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  const text =
    typeof value === "string" || (typeof value === "object" && value !== null) ? String(value) : ""
  return /^\d+$/.test(text) ? BigInt(text) : undefined
}

const nanosToIsoTimestamp = (value: unknown): string | undefined => {
  const nanoseconds = bigintFromUnknown(value)
  if (nanoseconds === undefined || nanoseconds <= 0n) return undefined
  const milliseconds = Number(nanoseconds / 1_000_000n)
  if (!Number.isSafeInteger(milliseconds)) return undefined
  const timestamp = new Date(milliseconds)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined
}

const durationMillis = (start: unknown, end: unknown): number | undefined => {
  const startNanoseconds = bigintFromUnknown(start)
  const endNanoseconds = bigintFromUnknown(end)
  if (
    startNanoseconds === undefined ||
    endNanoseconds === undefined ||
    endNanoseconds < startNanoseconds
  ) {
    return undefined
  }
  const duration = Number(endNanoseconds - startNanoseconds) / 1_000_000
  return Number.isFinite(duration) ? duration : undefined
}

const bytesToHex = (value: unknown): string | undefined => {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return undefined
  return Buffer.from(value).toString("hex")
}

const anyValueToNative = (input: unknown): OtlpValue => {
  const value = asRecord(input)
  switch (value.value) {
    case "stringValue":
      return asString(value.stringValue)
    case "boolValue":
      return value.boolValue === true
    case "intValue":
      return numberFromUnknown(value.intValue) ?? String(value.intValue)
    case "doubleValue":
      return numberFromUnknown(value.doubleValue) ?? 0
    case "bytesValue":
      return value.bytesValue instanceof Uint8Array ? value.bytesValue : new Uint8Array()
    case "arrayValue":
      return asArray(asRecord(value.arrayValue).values).map(anyValueToNative)
    case "kvlistValue":
      return keyValuesToRecord(asRecord(value.kvlistValue).values)
    default:
      return ""
  }
}

const keyValuesToRecord = (input: unknown): Readonly<Record<string, OtlpValue>> => {
  const values: Record<string, OtlpValue> = {}
  for (const raw of asArray(input)) {
    const item = asRecord(raw)
    const key = asString(item.key)
    if (key !== "" && item.value !== undefined) {
      values[key] = anyValueToNative(item.value)
    }
  }
  return values
}

const adaptJsonIdentifiers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(adaptJsonIdentifiers)
  if (typeof value !== "object" || value === null) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      const byteLength =
        key === "traceId" ? 16 : key === "spanId" || key === "parentSpanId" ? 8 : undefined
      if (byteLength === undefined) return [key, adaptJsonIdentifiers(nested)]
      if (nested === "") return [key, new Uint8Array()]
      if (
        typeof nested !== "string" ||
        nested.length !== byteLength * 2 ||
        !/^[0-9a-f]+$/i.test(nested)
      ) {
        throw new Error("invalid OTLP identifier")
      }
      return [
        key,
        Uint8Array.from(nested.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []),
      ]
    }),
  )
}

const decodeWire = (request: DecodeRequest): WireRecord => {
  const type = requestType(request.signal)
  if (request.encoding === "protobuf") {
    return asRecord(type.decode(request.body))
  }
  const text = new TextDecoder().decode(request.body)
  const json = adaptJsonIdentifiers(JSON.parse(text) as unknown)
  return asRecord(type.fromObject(asRecord(json)))
}

const mapLogs = (wire: WireRecord): DecodedTelemetry => ({
  _tag: "Logs",
  records: asArray(wire.resourceLogs).flatMap((rawResource) => {
    const resource = asRecord(rawResource)
    const resourceAttributes = keyValuesToRecord(asRecord(resource.resource).attributes)
    return asArray(resource.scopeLogs).flatMap((rawScope) =>
      asArray(asRecord(rawScope).logRecords).map((rawRecord) => {
        const record = asRecord(rawRecord)
        const eventName = asString(record.eventName)
        const observedTimestamp = nanosToIsoTimestamp(record.observedTimeUnixNano)
        const spanId = bytesToHex(record.spanId)
        const timestamp = nanosToIsoTimestamp(record.timeUnixNano)
        const traceId = bytesToHex(record.traceId)
        return {
          attributes: keyValuesToRecord(record.attributes),
          ...(eventName === "" ? {} : { eventName }),
          ...(observedTimestamp === undefined ? {} : { observedTimestamp }),
          resourceAttributes,
          ...(spanId === undefined ? {} : { spanId }),
          ...(timestamp === undefined ? {} : { timestamp }),
          ...(traceId === undefined ? {} : { traceId }),
        }
      }),
    )
  }),
})

const temporality = (value: unknown): MetricTemporality => {
  switch (numberFromUnknown(value)) {
    case 1:
      return "delta"
    case 2:
      return "cumulative"
    default:
      return "unspecified"
  }
}

const mapPoint = (input: unknown): OtlpMetricPoint => {
  const point = asRecord(input)
  const startTimestamp = nanosToIsoTimestamp(point.startTimeUnixNano)
  const timestamp = nanosToIsoTimestamp(point.timeUnixNano)
  let value: number | undefined
  switch (point.value) {
    case "asDouble":
      value = numberFromUnknown(point.asDouble)
      break
    case "asInt":
      value = numberFromUnknown(point.asInt)
      break
    default:
      value = numberFromUnknown(point.sum)
  }
  return {
    attributes: keyValuesToRecord(point.attributes),
    ...(startTimestamp === undefined ? {} : { startTimestamp }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(value === undefined ? {} : { value }),
  }
}

const mapMetric = (
  input: unknown,
  resourceAttributes: Readonly<Record<string, OtlpValue>>,
): OtlpMetric | undefined => {
  const metric = asRecord(input)
  const common = {
    name: asString(metric.name),
    resourceAttributes,
    unit: asString(metric.unit),
  }
  switch (metric.data) {
    case "gauge":
      return {
        ...common,
        dataKind: "gauge",
        points: asArray(asRecord(metric.gauge).dataPoints).map(mapPoint),
        temporality: "unspecified",
      }
    case "sum": {
      const sum = asRecord(metric.sum)
      return {
        ...common,
        dataKind: "sum",
        points: asArray(sum.dataPoints).map(mapPoint),
        temporality: temporality(sum.aggregationTemporality),
      }
    }
    case "histogram": {
      const histogram = asRecord(metric.histogram)
      return {
        ...common,
        dataKind: "histogram",
        points: asArray(histogram.dataPoints).map(mapPoint),
        temporality: temporality(histogram.aggregationTemporality),
      }
    }
    default:
      return undefined
  }
}

const mapMetrics = (wire: WireRecord): DecodedTelemetry => ({
  _tag: "Metrics",
  metrics: asArray(wire.resourceMetrics).flatMap((rawResource) => {
    const resource = asRecord(rawResource)
    const resourceAttributes = keyValuesToRecord(asRecord(resource.resource).attributes)
    return asArray(resource.scopeMetrics).flatMap((rawScope) =>
      asArray(asRecord(rawScope).metrics).flatMap((rawMetric) => {
        const metric = mapMetric(rawMetric, resourceAttributes)
        return metric === undefined ? [] : [metric]
      }),
    )
  }),
})

const mapTraces = (wire: WireRecord): DecodedTelemetry => ({
  _tag: "Traces",
  spans: asArray(wire.resourceSpans).flatMap((rawResource) => {
    const resource = asRecord(rawResource)
    const resourceAttributes = keyValuesToRecord(asRecord(resource.resource).attributes)
    return asArray(resource.scopeSpans).flatMap((rawScope) =>
      asArray(asRecord(rawScope).spans).map((rawSpan) => {
        const span = asRecord(rawSpan)
        const duration = durationMillis(span.startTimeUnixNano, span.endTimeUnixNano)
        const timestamp = nanosToIsoTimestamp(span.startTimeUnixNano)
        return {
          attributes: keyValuesToRecord(span.attributes),
          ...(duration === undefined ? {} : { durationMillis: duration }),
          name: asString(span.name),
          resourceAttributes,
          statusCode: numberFromUnknown(asRecord(span.status).code) ?? 0,
          ...(timestamp === undefined ? {} : { timestamp }),
        }
      }),
    )
  }),
})

const mapTelemetry = (signal: OtlpSignal, wire: WireRecord): DecodedTelemetry => {
  switch (signal) {
    case "logs":
      return mapLogs(wire)
    case "metrics":
      return mapMetrics(wire)
    case "traces":
      return mapTraces(wire)
  }
}

const service = OtlpCodec.of({
  decode: Effect.fn("OtlpCodec.decode")((request) =>
    Effect.try({
      try: () => mapTelemetry(request.signal, decodeWire(request)),
      catch: () => new OtlpDecodeError({ signal: request.signal }),
    }),
  ),
  encodeFailure: Effect.fn("OtlpCodec.encodeFailure")((message, encoding) =>
    Effect.sync(() =>
      encoding === "json"
        ? new TextEncoder().encode(JSON.stringify({ message }))
        : root.lookupType("lumen.otlp.RpcStatus").encode({ message }).finish(),
    ),
  ),
  encodeSuccess: Effect.fn("OtlpCodec.encodeSuccess")((signal, encoding) =>
    Effect.sync(() =>
      encoding === "json"
        ? new TextEncoder().encode("{}")
        : responseType(signal).encode({}).finish(),
    ),
  ),
})

export const layer = Layer.succeed(OtlpCodec, service)

export const encodingFromContentType = (
  contentType: string | undefined,
): Effect.Effect<OtlpEncoding, UnsupportedMediaType> => {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? ""
  if (mediaType === "application/json") return Effect.succeed("json")
  if (mediaType === "application/x-protobuf" || mediaType === "application/octet-stream") {
    return Effect.succeed("protobuf")
  }
  return Effect.fail(new UnsupportedMediaType({ contentType: mediaType }))
}

export const encodeRequest = (
  signal: OtlpSignal,
  value: Readonly<Record<string, unknown>>,
): Uint8Array => requestType(signal).encode(requestType(signal).fromObject(value)).finish()
