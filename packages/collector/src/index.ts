import type { OtelLiveBatch, UsageSnapshot, UsageTokens } from "@lumen-build/sync-contracts"
import { OtelLiveBatch as OtelLiveBatchSchema } from "@lumen-build/sync-contracts"
import {
  OtlpCodec,
  type DecodedTelemetry,
  type OtlpEncoding,
  type OtlpMetric,
  type OtlpSignal,
  type OtlpValue,
  encodingFromContentType,
  layer as otlpLayer,
} from "@lumen-build/sync-otlp"
import { Context, Effect, Layer, Ref, Schema } from "effect"

export interface UsageEvent {
  readonly agent: UsageSnapshot["agent"]
  readonly fingerprint: string
  readonly model: string
  readonly occurredAt: string
  readonly provider: string
  readonly sourceName: string
  readonly sourceSignal: OtlpSignal
  readonly tokens: UsageTokens
}

export class NormalizationError extends Schema.TaggedErrorClass<NormalizationError>()(
  "NormalizationError",
  {
    cause: Schema.Defect(),
  },
) {}

export class LiveUsageStoreError extends Schema.TaggedErrorClass<LiveUsageStoreError>()(
  "LiveUsageStoreError",
  {
    reason: Schema.String,
  },
) {}

export interface UsageNormalizerInterface {
  readonly normalize: (
    telemetry: DecodedTelemetry,
  ) => Effect.Effect<ReadonlyArray<UsageEvent>, NormalizationError>
}

export class UsageNormalizer extends Context.Service<UsageNormalizer, UsageNormalizerInterface>()(
  "@lumen-build/sync/UsageNormalizer",
) {}

export interface LiveUsageStoreInterface {
  readonly ingest: (events: ReadonlyArray<UsageEvent>) => Effect.Effect<number>
  readonly snapshot: (capturedAt: string) => Effect.Effect<OtelLiveBatch, LiveUsageStoreError>
}

export class LiveUsageStore extends Context.Service<LiveUsageStore, LiveUsageStoreInterface>()(
  "@lumen-build/sync/LiveUsageStore",
) {}

export interface CollectorInterface {
  readonly handle: (request: Request) => Effect.Effect<Response>
}

export class Collector extends Context.Service<Collector, CollectorInterface>()(
  "@lumen-build/sync/Collector",
) {}

const normalizeName = (name: string): string => name.replace(/[-.\s]/g, "_").toLowerCase()

interface Attributes {
  readonly number: (names: ReadonlyArray<string>) => number | undefined
  readonly string: (names: ReadonlyArray<string>) => string | undefined
}

const makeAttributes = (
  ...sources: ReadonlyArray<Readonly<Record<string, OtlpValue>>>
): Attributes => {
  const exact = (names: ReadonlyArray<string>): OtlpValue | undefined => {
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const source = sources[index]
      if (source === undefined) continue
      for (const name of names) {
        if (source[name] !== undefined) return source[name]
      }
    }
    const normalized = new Map(
      sources.flatMap((source) =>
        Object.entries(source).map(([name, value]) => [normalizeName(name), value] as const),
      ),
    )
    for (const name of names) {
      const value = normalized.get(normalizeName(name))
      if (value !== undefined) return value
    }
    return undefined
  }

  return {
    number: (names) => {
      const value = exact(names)
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value))
      }
      if (typeof value !== "string" || value.trim() === "") return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined
    },
    string: (names) => {
      const value = exact(names)
      if (typeof value === "string") return value
      return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined
    },
  }
}

export const inferAgent = (
  values: Readonly<Record<string, OtlpValue>>,
  hint: string,
): UsageSnapshot["agent"] => {
  const attributes = makeAttributes(values)
  const emitter = [
    hint,
    attributes.string(["service.name"]),
    attributes.string(["telemetry.sdk.name"]),
  ]
    .filter((value) => value !== undefined)
    .join(" ")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")

  if (emitter.includes("opencode")) return "opencode"
  if (emitter.includes("vscode") || emitter.includes("visual studio code")) {
    return "vscode"
  }
  if (emitter.includes("copilot")) return "copilot"
  if (emitter.includes("codex")) return "codex"
  if (emitter.includes("claude")) return "claude"
  if (emitter.includes("gemini")) return "gemini"

  const provider = [
    attributes.string(["gen_ai.system"]),
    attributes.string(["gen_ai.provider.name"]),
  ]
    .filter((value) => value !== undefined)
    .join(" ")
    .toLowerCase()

  if (provider.includes("anthropic")) return "claude"
  if (provider.includes("google")) return "gemini"
  if (provider.includes("github")) return "copilot"
  if (provider.includes("openai")) return "codex"
  return "unknown"
}

const defaultProvider = (agent: UsageSnapshot["agent"]): string => {
  switch (agent) {
    case "claude":
      return "anthropic"
    case "codex":
      return "openai"
    case "copilot":
    case "vscode":
      return "github"
    case "gemini":
      return "google"
    case "opencode":
    case "unknown":
      return "unknown"
  }
}

const emptyTokens = (): UsageTokens => ({
  cacheCreationInput: 0,
  cacheReadInput: 0,
  input: 0,
  output: 0,
  reasoningOutput: 0,
  tool: 0,
})

const addTokens = (left: UsageTokens, right: UsageTokens): UsageTokens => ({
  cacheCreationInput: left.cacheCreationInput + right.cacheCreationInput,
  cacheReadInput: left.cacheReadInput + right.cacheReadInput,
  input: left.input + right.input,
  output: left.output + right.output,
  reasoningOutput: left.reasoningOutput + right.reasoningOutput,
  tool: left.tool + right.tool,
})

const extractTokens = (attributes: Attributes): UsageTokens => ({
  cacheCreationInput:
    attributes.number([
      "gen_ai.usage.cache_creation_input_tokens",
      "cache_creation_input_tokens",
      "cache_write_input_tokens",
    ]) ?? 0,
  cacheReadInput:
    attributes.number([
      "gen_ai.usage.cache_read_input_tokens",
      "cache_read_input_tokens",
      "cached_input_tokens",
      "cached_token_count",
    ]) ?? 0,
  input:
    attributes.number([
      "gen_ai.usage.input_tokens",
      "input_tokens",
      "input_token_count",
      "prompt_tokens",
    ]) ?? 0,
  output:
    attributes.number([
      "gen_ai.usage.output_tokens",
      "output_tokens",
      "output_token_count",
      "completion_tokens",
    ]) ?? 0,
  reasoningOutput:
    attributes.number([
      "gen_ai.usage.reasoning_tokens",
      "reasoning_output_tokens",
      "reasoning_token_count",
    ]) ?? 0,
  tool: attributes.number(["gen_ai.usage.tool_tokens", "tool_tokens"]) ?? 0,
})

const tokensPresent = (tokens: UsageTokens): boolean =>
  tokens.cacheCreationInput > 0 ||
  tokens.cacheReadInput > 0 ||
  tokens.input > 0 ||
  tokens.output > 0 ||
  tokens.reasoningOutput > 0 ||
  tokens.tool > 0

type TokenField = keyof UsageTokens

const tokenField = (tokenType: string): TokenField | undefined => {
  const normalized = tokenType.replaceAll("-", "_").toLowerCase()
  if (normalized.includes("cache") && normalized.includes("creation")) {
    return "cacheCreationInput"
  }
  if (normalized.includes("cache") || normalized.includes("cached")) {
    return "cacheReadInput"
  }
  if (normalized.includes("reason")) return "reasoningOutput"
  if (normalized.includes("tool")) return "tool"
  if (normalized.includes("output") || normalized.includes("completion")) {
    return "output"
  }
  if (normalized.includes("input") || normalized.includes("prompt")) return "input"
  return undefined
}

const tokensFor = (field: TokenField, value: number): UsageTokens => ({
  ...emptyTokens(),
  [field]: Math.max(0, Math.trunc(value)),
})

interface UsageCandidate extends Omit<UsageEvent, "fingerprint"> {}

const candidate = ({
  attributes,
  explicitAgent,
  identityHint,
  occurredAt,
  sourceName,
  sourceSignal,
  tokens,
}: {
  readonly attributes: Attributes
  readonly explicitAgent?: UsageSnapshot["agent"]
  readonly identityHint: string
  readonly occurredAt: string
  readonly sourceName: string
  readonly sourceSignal: OtlpSignal
  readonly tokens: UsageTokens
}): UsageCandidate => {
  const agent =
    explicitAgent ??
    inferAgent(
      {
        "gen_ai.provider.name": attributes.string(["gen_ai.provider.name"]) ?? "",
        "gen_ai.system": attributes.string(["gen_ai.system"]) ?? "",
        "service.name": attributes.string(["service.name"]) ?? "",
        "telemetry.sdk.name": attributes.string(["telemetry.sdk.name"]) ?? "",
      },
      identityHint,
    )
  return {
    agent,
    model:
      attributes.string(["gen_ai.response.model", "gen_ai.request.model", "model", "model_name"]) ??
      "unknown",
    occurredAt,
    provider:
      attributes.string(["gen_ai.provider.name", "gen_ai.system", "provider"]) ??
      defaultProvider(agent),
    sourceName,
    sourceSignal,
    tokens,
  }
}

const mapCodexMetric = (metric: OtlpMetric): ReadonlyArray<UsageCandidate> => {
  if (
    metric.name !== "codex.turn.token_usage" ||
    metric.dataKind !== "histogram" ||
    metric.temporality !== "delta"
  ) {
    return []
  }
  let tokens = emptyTokens()
  for (const point of metric.points) {
    const attributes = makeAttributes(metric.resourceAttributes, point.attributes)
    const field = tokenField(attributes.string(["token_type"]) ?? "")
    if (field !== undefined && point.value !== undefined && point.value > 0) {
      tokens = addTokens(tokens, tokensFor(field, point.value))
    }
  }
  const occurredAt = metric.points
    .flatMap((point) => (point.timestamp === undefined ? [] : [point.timestamp]))
    .toSorted()
    .at(-1)
  if (!tokensPresent(tokens) || occurredAt === undefined) return []

  return [
    candidate({
      attributes: makeAttributes(
        metric.resourceAttributes,
        ...metric.points.map((point) => point.attributes),
      ),
      explicitAgent: "codex",
      identityHint: metric.name,
      occurredAt,
      sourceName: metric.name,
      sourceSignal: "metrics",
      tokens,
    }),
  ]
}

const mapMetrics = (
  metrics: Extract<DecodedTelemetry, { readonly _tag: "Metrics" }>["metrics"],
): ReadonlyArray<UsageCandidate> =>
  metrics.flatMap((metric) => {
    if (metric.name === "codex.turn.token_usage") return mapCodexMetric(metric)
    if (metric.temporality === "cumulative") return []
    if (!`${metric.name} ${metric.unit}`.toLowerCase().includes("token")) return []

    return metric.points.flatMap((point) => {
      const attributes = makeAttributes(metric.resourceAttributes, point.attributes)
      const field = tokenField(
        attributes.string(["gen_ai.token.type", "type", "token_type"]) ?? metric.name,
      )
      if (
        field === undefined ||
        point.value === undefined ||
        point.value <= 0 ||
        point.timestamp === undefined
      ) {
        return []
      }
      return [
        candidate({
          attributes,
          identityHint: metric.name,
          occurredAt: point.timestamp,
          sourceName: metric.name,
          sourceSignal: "metrics",
          tokens: tokensFor(field, point.value),
        }),
      ]
    })
  })

const mapTelemetry = (telemetry: DecodedTelemetry): ReadonlyArray<UsageCandidate> => {
  switch (telemetry._tag) {
    case "Logs":
      return telemetry.records.flatMap((record) => {
        const attributes = makeAttributes(record.resourceAttributes, record.attributes)
        const sourceName = (
          attributes.string(["event.name", "event_name", "codex.event", "codex.event_name"]) ??
          record.eventName ??
          "gen_ai.log"
        ).toLowerCase()
        if (
          inferAgent(record.resourceAttributes, sourceName) === "codex" ||
          record.timestamp === undefined
        ) {
          return []
        }
        const tokens = extractTokens(attributes)
        return tokensPresent(tokens)
          ? [
              candidate({
                attributes,
                identityHint: sourceName,
                occurredAt: record.timestamp,
                sourceName,
                sourceSignal: "logs",
                tokens,
              }),
            ]
          : []
      })
    case "Metrics":
      return mapMetrics(telemetry.metrics)
    case "Traces":
      return telemetry.spans.flatMap((span) => {
        const attributes = makeAttributes(span.resourceAttributes, span.attributes)
        if (
          inferAgent(span.resourceAttributes, span.name) === "codex" ||
          span.timestamp === undefined
        ) {
          return []
        }
        const tokens = extractTokens(attributes)
        return tokensPresent(tokens)
          ? [
              candidate({
                attributes,
                identityHint: span.name,
                occurredAt: span.timestamp,
                sourceName: "gen_ai.span",
                sourceSignal: "traces",
                tokens,
              }),
            ]
          : []
      })
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const fingerprint = (value: UsageCandidate): Effect.Effect<string, NormalizationError> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableJson(value)),
      )
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    },
    catch: (cause) => new NormalizationError({ cause }),
  })

const normalizerLayer = Layer.succeed(
  UsageNormalizer,
  UsageNormalizer.of({
    normalize: Effect.fn("UsageNormalizer.normalize")((telemetry) =>
      Effect.forEach(mapTelemetry(telemetry), (current) =>
        fingerprint(current).pipe(Effect.map((digest) => ({ ...current, fingerprint: digest }))),
      ),
    ),
  }),
)

interface Bucket {
  readonly revision: number
  readonly snapshot: UsageSnapshot
}

interface StoreState {
  readonly buckets: ReadonlyMap<string, Bucket>
  readonly seen: ReadonlySet<string>
}

const usageKey = (snapshot: UsageSnapshot): string =>
  [snapshot.day, snapshot.agent, snapshot.provider, snapshot.model].join("\u0000")

const storeLayer = (deviceId: string) =>
  Layer.effect(
    LiveUsageStore,
    Effect.gen(function* () {
      const state = yield* Ref.make<StoreState>({
        buckets: new Map(),
        seen: new Set(),
      })

      const ingest = Effect.fn("LiveUsageStore.ingest")((events: ReadonlyArray<UsageEvent>) =>
        Ref.modify(state, (current) => {
          const seen = new Set(current.seen)
          const buckets = new Map(current.buckets)
          let accepted = 0
          for (const event of events) {
            if (seen.has(event.fingerprint)) continue
            seen.add(event.fingerprint)
            accepted += 1
            const snapshot: UsageSnapshot = {
              agent: event.agent,
              day: event.occurredAt.slice(0, 10),
              model: event.model,
              provider: event.provider,
              tokens: event.tokens,
            }
            const key = usageKey(snapshot)
            const existing = buckets.get(key)
            buckets.set(key, {
              revision: (existing?.revision ?? 0) + 1,
              snapshot: {
                ...snapshot,
                tokens:
                  existing === undefined
                    ? snapshot.tokens
                    : addTokens(existing.snapshot.tokens, snapshot.tokens),
              },
            })
          }
          return [accepted, { buckets, seen }]
        }),
      )

      const snapshot = Effect.fn("LiveUsageStore.snapshot")(function* (capturedAt: string) {
        const current = yield* Ref.get(state)
        return yield* Schema.decodeUnknownEffect(OtelLiveBatchSchema)({
          source: "otel-live",
          capturedAt,
          costs: [],
          deviceId,
          snapshots: [...current.buckets.values()]
            .map((bucket) => ({
              ...bucket.snapshot,
              revision: bucket.revision,
            }))
            .toSorted((left, right) => usageKey(left).localeCompare(usageKey(right))),
        }).pipe(
          Effect.mapError(
            (error) =>
              new LiveUsageStoreError({
                reason: error.message,
              }),
          ),
        )
      })

      return LiveUsageStore.of({ ingest, snapshot })
    }),
  )

export interface CollectorOptions {
  readonly deviceId: string
  readonly maxBodyBytes: number
}

const contentTypeFor = (encoding: OtlpEncoding): string =>
  encoding === "json" ? "application/json" : "application/x-protobuf"

const ownedBuffer = (body: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy.buffer
}

const response = (body: Uint8Array, encoding: OtlpEncoding, status = 200): Response =>
  new Response(ownedBuffer(body), {
    headers: { "content-type": contentTypeFor(encoding) },
    status,
  })

const signalFromPath = (pathname: string): OtlpSignal | undefined => {
  if (pathname === "/v1/logs") return "logs"
  if (pathname === "/v1/metrics") return "metrics"
  if (pathname === "/v1/traces") return "traces"
  return undefined
}

const decodeGzip = (body: Uint8Array): Promise<Uint8Array> =>
  new Response(new Blob([ownedBuffer(body)]).stream().pipeThrough(new DecompressionStream("gzip")))
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))

const makeCollectorLayer = (maxBodyBytes: number) =>
  Layer.effect(
    Collector,
    Effect.gen(function* () {
      const codec = yield* OtlpCodec
      const normalizer = yield* UsageNormalizer
      const store = yield* LiveUsageStore

      const handle = Effect.fn("Collector.handle")((request: Request) =>
        Effect.gen(function* () {
          const signal = signalFromPath(new URL(request.url).pathname)
          if (request.method !== "POST" || signal === undefined) {
            return new Response("not found", { status: 404 })
          }

          const contentLength = Number(request.headers.get("content-length") ?? "0")
          if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
            return new Response("body too large", { status: 413 })
          }

          const encodingResult = yield* Effect.result(
            encodingFromContentType(request.headers.get("content-type") ?? undefined),
          )
          if (encodingResult._tag === "Failure") {
            return new Response("unsupported media type", { status: 415 })
          }
          const encoding = encodingResult.success

          const rawResult = yield* Effect.result(Effect.tryPromise(() => request.arrayBuffer()))
          if (rawResult._tag === "Failure") {
            return new Response("invalid request body", { status: 400 })
          }
          let body: Uint8Array = new Uint8Array(rawResult.success)
          const contentEncoding = (
            request.headers.get("content-encoding") ?? "identity"
          ).toLowerCase()
          if (contentEncoding === "gzip") {
            const decoded = yield* Effect.result(Effect.tryPromise(() => decodeGzip(body)))
            if (decoded._tag === "Failure") {
              return new Response("invalid gzip body", { status: 400 })
            }
            body = decoded.success
          } else if (contentEncoding !== "identity" && contentEncoding !== "") {
            return new Response("unsupported content encoding", { status: 415 })
          }
          if (body.byteLength > maxBodyBytes) {
            return new Response("body too large", { status: 413 })
          }

          const telemetry = yield* Effect.result(codec.decode({ body, encoding, signal }))
          if (telemetry._tag === "Failure") {
            const failure = yield* codec.encodeFailure("invalid OTLP payload", encoding)
            return response(failure, encoding, 400)
          }
          const events = yield* Effect.result(normalizer.normalize(telemetry.success))
          if (events._tag === "Failure") {
            const failure = yield* codec.encodeFailure("could not normalize OTLP payload", encoding)
            return response(failure, encoding, 400)
          }
          yield* store.ingest(events.success)
          return response(yield* codec.encodeSuccess(signal, encoding), encoding)
        }),
      )

      return Collector.of({ handle })
    }),
  )

export const collectorLayer = ({ deviceId, maxBodyBytes }: CollectorOptions) => {
  const dependencies = Layer.mergeAll(otlpLayer, normalizerLayer, storeLayer(deviceId))
  return Layer.merge(
    dependencies,
    makeCollectorLayer(maxBodyBytes).pipe(Layer.provide(dependencies)),
  )
}

export interface ServerOptions {
  readonly collector: CollectorInterface
  readonly hostname: string
  readonly port: number
}

export const startServer = ({ collector, hostname, port }: ServerOptions): Bun.Server<undefined> =>
  Bun.serve({
    fetch: (request) => Effect.runPromise(collector.handle(request)),
    hostname,
    port,
  })
