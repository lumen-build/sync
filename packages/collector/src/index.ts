import type {
  OtelLiveBatch,
  OtelUsageSnapshot,
  UsageSnapshot,
  UsageTokens,
} from "@lumen-build/sync-contracts"
import {
  DeviceId,
  NonNegativeSafeInteger,
  OtelLiveBatch as OtelLiveBatchSchema,
  OtelUsageSnapshot as OtelUsageSnapshotSchema,
  UsageDay,
  UsageAgent as UsageAgentSchema,
  UsageTokens as UsageTokensSchema,
  UtcTimestamp,
  addUsageTokens,
  defaultProviderForAgent,
  emptyUsageTokens,
  usageSnapshotKey,
} from "@lumen-build/sync-contracts"
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
import { Context, Crypto, Effect, FileSystem, Layer, Path, Ref, Schema, Scope } from "effect"

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
  readonly checkpoint: Effect.Effect<void, LiveUsageStoreError>
  readonly generation: Effect.Effect<number>
  readonly ingest: (events: ReadonlyArray<UsageEvent>) => Effect.Effect<number, LiveUsageStoreError>
  readonly snapshot: (capturedAt: string) => Effect.Effect<OtelLiveBatch, LiveUsageStoreError>
  readonly snapshotAfter: (
    capturedAt: string,
    generation: number,
  ) => Effect.Effect<
    { readonly batch: OtelLiveBatch; readonly generation: number } | undefined,
    LiveUsageStoreError
  >
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

export interface CollectorServerAddress {
  readonly port: number
  readonly url: string
}

export interface CollectorServerOptions {
  readonly hostname: string
  readonly port: number
}

export class CollectorServerError extends Schema.TaggedErrorClass<CollectorServerError>()(
  "CollectorServerError",
  {
    reason: Schema.String,
  },
) {}

export interface CollectorServerInterface {
  readonly listen: (
    options: CollectorServerOptions,
  ) => Effect.Effect<CollectorServerAddress, CollectorServerError, Scope.Scope>
}

export class CollectorServer extends Context.Service<CollectorServer, CollectorServerInterface>()(
  "@lumen-build/sync/CollectorServer",
) {}

const normalizeName = (name: string): string => name.replace(/[-.\s]/g, "_").toLowerCase()

interface Attributes {
  readonly number: (names: ReadonlyArray<string>) => number | undefined
  readonly string: (names: ReadonlyArray<string>) => string | undefined
}

const makeAttributes = (
  ...sources: ReadonlyArray<Readonly<Record<string, OtlpValue>>>
): Attributes => {
  let normalized: ReadonlyMap<string, OtlpValue> | undefined
  const exact = (names: ReadonlyArray<string>): OtlpValue | undefined => {
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const source = sources[index]
      if (source === undefined) continue
      for (const name of names) {
        if (source[name] !== undefined) return source[name]
      }
    }
    normalized ??= new Map(
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
        return value
      }
      if (typeof value !== "string" || value.trim() === "") return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
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
      "cached_content_token_count",
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
      "thoughts_token_count",
    ]) ?? 0,
  tool: attributes.number(["gen_ai.usage.tool_tokens", "tool_tokens", "tool_token_count"]) ?? 0,
})

const tokensPresent = (tokens: UsageTokens): boolean =>
  tokens.cacheCreationInput !== 0 ||
  tokens.cacheReadInput !== 0 ||
  tokens.input !== 0 ||
  tokens.output !== 0 ||
  tokens.reasoningOutput !== 0 ||
  tokens.tool !== 0

type TokenField = keyof UsageTokens

const tokenField = (tokenType: string): TokenField | undefined => {
  const normalized = tokenType.replaceAll("-", "_").toLowerCase()
  if (normalized.includes("cache") && normalized.includes("creation")) {
    return "cacheCreationInput"
  }
  if (normalized.includes("cache") || normalized.includes("cached")) {
    return "cacheReadInput"
  }
  if (normalized.includes("reason") || normalized.includes("thought")) {
    return "reasoningOutput"
  }
  if (normalized.includes("tool")) return "tool"
  if (normalized.includes("output") || normalized.includes("completion")) {
    return "output"
  }
  if (normalized.includes("input") || normalized.includes("prompt")) return "input"
  return undefined
}

const tokensFor = (field: TokenField, value: number): UsageTokens => ({
  ...emptyUsageTokens(),
  [field]: value,
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
      defaultProviderForAgent(agent),
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
  let tokens = emptyUsageTokens()
  for (const point of metric.points) {
    const attributes = makeAttributes(metric.resourceAttributes, point.attributes)
    const field = tokenField(attributes.string(["token_type"]) ?? "")
    if (field !== undefined && point.value !== undefined && point.value !== 0) {
      tokens = addUsageTokens(tokens, tokensFor(field, point.value))
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
        point.value === 0 ||
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
        const agent = inferAgent(record.resourceAttributes, sourceName)
        if ((agent !== "opencode" && agent !== "unknown") || record.timestamp === undefined) {
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
        const agent = inferAgent(span.resourceAttributes, span.name)
        if ((agent !== "opencode" && agent !== "unknown") || span.timestamp === undefined) {
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
      return Buffer.from(digest).toString("hex")
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

const versionedSnapshot = ({ revision, snapshot }: Bucket): OtelUsageSnapshot => ({
  ...snapshot,
  revision,
})

interface StoreState {
  buckets: Map<string, Bucket>
  bucketsByDay: Map<string, Set<string>>
  fingerprintOrder: Set<string>
  fingerprintsByDay: Map<string, Set<string>>
  generation: number
  latestDay?: string
  seen: Map<string, string>
}

const Fingerprint = Schema.NonEmptyString.check(Schema.isMaxLength(512))

const UsageEventSchema = Schema.Struct({
  agent: UsageAgentSchema,
  fingerprint: Fingerprint,
  model: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  occurredAt: UtcTimestamp,
  provider: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  sourceName: Schema.String,
  sourceSignal: Schema.Literals(["logs", "metrics", "traces"]),
  tokens: UsageTokensSchema,
})

const isUsageEvent = Schema.is(UsageEventSchema)
const isOtelUsageSnapshot = Schema.is(OtelUsageSnapshotSchema)

const StoreCheckpoint = Schema.Struct({
  deviceId: DeviceId,
  generation: NonNegativeSafeInteger,
  latestDay: Schema.optionalKey(UsageDay),
  seen: Schema.Array(Schema.Tuple([Fingerprint, UsageDay])),
  snapshots: Schema.Array(OtelUsageSnapshotSchema),
  version: Schema.Literal(1),
})

type StoreCheckpoint = typeof StoreCheckpoint.Type

const emptyStoreState = (): StoreState => ({
  buckets: new Map(),
  bucketsByDay: new Map(),
  fingerprintOrder: new Set(),
  fingerprintsByDay: new Map(),
  generation: 0,
  seen: new Map(),
})

const checkpointError = (operation: string, cause: unknown): LiveUsageStoreError =>
  new LiveUsageStoreError({
    reason: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })

interface CheckpointRuntime {
  readonly crypto: Crypto.Crypto
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
}

const stateFromCheckpoint = (
  deviceId: string,
  checkpoint: StoreCheckpoint,
): Effect.Effect<StoreState, LiveUsageStoreError> =>
  Effect.gen(function* () {
    if (checkpoint.deviceId !== deviceId) {
      return yield* new LiveUsageStoreError({
        reason: "collector checkpoint belongs to a different device",
      })
    }

    const state = emptyStoreState()
    state.generation = checkpoint.generation
    if (checkpoint.latestDay !== undefined) state.latestDay = checkpoint.latestDay
    for (const snapshot of checkpoint.snapshots) {
      const { revision, ...usage } = snapshot
      const key = usageSnapshotKey(usage)
      if (state.buckets.has(key)) {
        return yield* new LiveUsageStoreError({
          reason: "collector checkpoint contains duplicate usage snapshots",
        })
      }
      state.buckets.set(key, { revision, snapshot: usage })
      addToDayIndex(state.bucketsByDay, usage.day, key)
    }
    for (const [digest, day] of checkpoint.seen) {
      if (state.seen.has(digest)) {
        return yield* new LiveUsageStoreError({
          reason: "collector checkpoint contains duplicate fingerprints",
        })
      }
      state.seen.set(digest, day)
      state.fingerprintOrder.add(digest)
      addToDayIndex(state.fingerprintsByDay, day, digest)
    }
    return state
  })

const loadStoreState = (
  deviceId: string,
  path: string | undefined,
  runtime: CheckpointRuntime | undefined,
): Effect.Effect<StoreState, LiveUsageStoreError> => {
  if (path === undefined) return Effect.succeed(emptyStoreState())
  if (runtime === undefined) {
    return Effect.fail(
      new LiveUsageStoreError({
        reason: "collector checkpoint runtime is unavailable",
      }),
    )
  }
  return Effect.gen(function* () {
    const exists = yield* runtime.fileSystem
      .exists(path)
      .pipe(Effect.mapError((cause) => checkpointError("inspect collector checkpoint", cause)))
    if (!exists) return emptyStoreState()
    const contents = yield* runtime.fileSystem
      .readFileString(path)
      .pipe(Effect.mapError((cause) => checkpointError("read collector checkpoint", cause)))
    const checkpoint = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (cause) => checkpointError("parse collector checkpoint", cause),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StoreCheckpoint)),
      Effect.mapError((cause) => checkpointError("decode collector checkpoint", cause)),
    )
    return yield* stateFromCheckpoint(deviceId, checkpoint)
  })
}

const checkpointFromState = (deviceId: string, state: StoreState): StoreCheckpoint => ({
  deviceId,
  generation: state.generation,
  ...(state.latestDay === undefined ? {} : { latestDay: state.latestDay }),
  seen: [...state.seen],
  snapshots: [...state.buckets.values()]
    .map(versionedSnapshot)
    .toSorted((left, right) => usageSnapshotKey(left).localeCompare(usageSnapshotKey(right))),
  version: 1,
})

const persistStoreState = (
  path: string | undefined,
  checkpoint: StoreCheckpoint,
  runtime: CheckpointRuntime | undefined,
): Effect.Effect<void, LiveUsageStoreError> => {
  if (path === undefined) return Effect.void
  if (runtime === undefined) {
    return Effect.fail(
      new LiveUsageStoreError({
        reason: "collector checkpoint runtime is unavailable",
      }),
    )
  }
  return Effect.gen(function* () {
    const temporary = `${path}.${yield* runtime.crypto.randomUUIDv4}.tmp`
    yield* runtime.fileSystem.makeDirectory(runtime.path.dirname(path), {
      mode: 0o700,
      recursive: true,
    })
    yield* runtime.fileSystem
      .writeFileString(temporary, `${JSON.stringify(checkpoint)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.andThen(runtime.fileSystem.rename(temporary, path)),
        Effect.andThen(runtime.fileSystem.chmod(path, 0o600)),
        Effect.ensuring(runtime.fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
      )
  }).pipe(Effect.mapError((cause) => checkpointError("write collector checkpoint", cause)))
}

const checkedAddUsageTokens = (left: UsageTokens, right: UsageTokens): UsageTokens | undefined => {
  const result = {
    cacheCreationInput: left.cacheCreationInput + right.cacheCreationInput,
    cacheReadInput: left.cacheReadInput + right.cacheReadInput,
    input: left.input + right.input,
    output: left.output + right.output,
    reasoningOutput: left.reasoningOutput + right.reasoningOutput,
    tool: left.tool + right.tool,
  }
  return Object.values(result).every((value) => Number.isSafeInteger(value) && value >= 0)
    ? result
    : undefined
}

const retentionCutoff = (latestDay: string, retentionDays: number): string => {
  const date = new Date(`${latestDay}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - retentionDays + 1)
  return date.toISOString().slice(0, 10)
}

const nextDay = (day: string): string => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

const daysBetween = (earlier: string, later: string): number =>
  Math.trunc(
    (Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000,
  )

const addToDayIndex = (index: Map<string, Set<string>>, day: string, value: string): void => {
  const values = index.get(day)
  if (values === undefined) {
    index.set(day, new Set([value]))
  } else {
    values.add(value)
  }
}

const expireDay = (state: StoreState, day: string): void => {
  const fingerprints = state.fingerprintsByDay.get(day)
  if (fingerprints !== undefined) {
    for (const current of fingerprints) {
      state.seen.delete(current)
      state.fingerprintOrder.delete(current)
    }
    state.fingerprintsByDay.delete(day)
  }

  const bucketKeys = state.bucketsByDay.get(day)
  if (bucketKeys !== undefined) {
    for (const key of bucketKeys) state.buckets.delete(key)
    state.bucketsByDay.delete(day)
  }
}

const expireBefore = (state: StoreState, nextLatestDay: string, retentionDays: number): void => {
  if (state.latestDay === undefined) return
  const currentCutoff = retentionCutoff(state.latestDay, retentionDays)
  const nextCutoff = retentionCutoff(nextLatestDay, retentionDays)
  const advance = daysBetween(currentCutoff, nextCutoff)
  if (advance <= 0) return

  if (advance >= retentionDays) {
    state.buckets = new Map()
    state.bucketsByDay = new Map()
    state.fingerprintOrder = new Set()
    state.fingerprintsByDay = new Map()
    state.seen = new Map()
    return
  }

  let day = currentCutoff
  while (day < nextCutoff) {
    expireDay(state, day)
    day = nextDay(day)
  }
}

const removeFingerprint = (state: StoreState, digest: string): void => {
  const day = state.seen.get(digest)
  if (day === undefined) return
  state.seen.delete(digest)
  state.fingerprintOrder.delete(digest)
  const fingerprints = state.fingerprintsByDay.get(day)
  fingerprints?.delete(digest)
  if (fingerprints?.size === 0) state.fingerprintsByDay.delete(day)
}

type IngestResult =
  | { readonly status: "failure"; readonly error: LiveUsageStoreError }
  | { readonly status: "success"; readonly accepted: number }

const storeLayer = (
  deviceId: string,
  retentionDays: number,
  maxFingerprints: number,
  statePath: string | undefined,
) =>
  Layer.effect(
    LiveUsageStore,
    Effect.gen(function* () {
      const runtime =
        statePath === undefined
          ? undefined
          : {
              crypto: yield* Crypto.Crypto,
              fileSystem: yield* FileSystem.FileSystem,
              path: yield* Path.Path,
            }
      const state = yield* Ref.make(yield* loadStoreState(deviceId, statePath, runtime))

      const ingest = Effect.fn("LiveUsageStore.ingest")(function* (
        events: ReadonlyArray<UsageEvent>,
      ) {
        const result = yield* Ref.modify(state, (current): [IngestResult, StoreState] => {
          for (const event of events) {
            if (!isUsageEvent(event)) {
              return [
                {
                  status: "failure",
                  error: new LiveUsageStoreError({ reason: "invalid normalized usage event" }),
                },
                current,
              ]
            }
          }

          const batchFingerprints = new Set<string>()
          const accepted: Array<{ readonly day: string; readonly event: UsageEvent }> = []
          let latestDay = current.latestDay
          for (const event of events) {
            if (current.seen.has(event.fingerprint) || batchFingerprints.has(event.fingerprint)) {
              continue
            }
            const day = event.occurredAt.slice(0, 10)
            batchFingerprints.add(event.fingerprint)
            accepted.push({ day, event })
            latestDay = latestDay === undefined || day > latestDay ? day : latestDay
          }

          if (accepted.length === 0 || latestDay === undefined) {
            return [{ status: "success", accepted: 0 }, current]
          }

          const cutoff = retentionCutoff(latestDay, retentionDays)
          const pendingBuckets = new Map<string, Bucket>()
          for (const { day, event } of accepted) {
            if (day < cutoff) continue
            const snapshot: UsageSnapshot = {
              agent: event.agent,
              day,
              model: event.model,
              provider: event.provider,
              tokens: event.tokens,
            }
            const key = usageSnapshotKey(snapshot)
            const existing = pendingBuckets.get(key) ?? current.buckets.get(key)
            const tokens = checkedAddUsageTokens(
              existing?.snapshot.tokens ?? emptyUsageTokens(),
              snapshot.tokens,
            )
            const revision = (existing?.revision ?? 0) + 1
            if (tokens === undefined || !Number.isSafeInteger(revision)) {
              return [
                {
                  status: "failure",
                  error: new LiveUsageStoreError({
                    reason: "usage aggregate exceeds safe integer bounds",
                  }),
                },
                current,
              ]
            }
            const bucket = {
              revision,
              snapshot: {
                ...snapshot,
                tokens,
              },
            }
            if (!isOtelUsageSnapshot({ ...bucket.snapshot, revision: bucket.revision })) {
              return [
                {
                  status: "failure",
                  error: new LiveUsageStoreError({ reason: "invalid live usage snapshot" }),
                },
                current,
              ]
            }
            pendingBuckets.set(key, bucket)
          }

          expireBefore(current, latestDay, retentionDays)

          for (const { day, event } of accepted) {
            if (day < cutoff) continue
            current.seen.set(event.fingerprint, day)
            current.fingerprintOrder.add(event.fingerprint)
            addToDayIndex(current.fingerprintsByDay, day, event.fingerprint)
          }

          while (current.seen.size > maxFingerprints) {
            const oldest = current.fingerprintOrder.values().next().value
            if (oldest === undefined) break
            removeFingerprint(current, oldest)
          }

          for (const [key, bucket] of pendingBuckets) {
            if (!current.buckets.has(key)) {
              addToDayIndex(current.bucketsByDay, bucket.snapshot.day, key)
            }
            current.buckets.set(key, bucket)
          }

          current.generation += 1
          current.latestDay = latestDay
          return [{ status: "success", accepted: accepted.length }, current]
        })

        if (result.status === "failure") return yield* Effect.fail(result.error)
        return result.accepted
      })

      const decodeSnapshot = (capturedAt: string, current: StoreState) =>
        Schema.decodeUnknownEffect(OtelLiveBatchSchema)({
          source: "otel-live",
          capturedAt,
          costs: [],
          deviceId,
          snapshots: [...current.buckets.values()]
            .map(versionedSnapshot)
            .toSorted((left, right) =>
              usageSnapshotKey(left).localeCompare(usageSnapshotKey(right)),
            ),
        }).pipe(
          Effect.mapError(
            (error) =>
              new LiveUsageStoreError({
                reason: error.message,
              }),
          ),
        )

      const snapshot = Effect.fn("LiveUsageStore.snapshot")(function* (capturedAt: string) {
        const current = yield* Ref.get(state)
        return yield* decodeSnapshot(capturedAt, current)
      })

      const snapshotAfter = Effect.fn("LiveUsageStore.snapshotAfter")(function* (
        capturedAt: string,
        generation: number,
      ) {
        const current = yield* Ref.get(state)
        if (current.generation <= generation) return undefined
        const capturedGeneration = current.generation
        const batch = yield* decodeSnapshot(capturedAt, current)
        return { batch, generation: capturedGeneration }
      })

      return LiveUsageStore.of({
        checkpoint: Ref.get(state).pipe(
          Effect.flatMap((current) =>
            persistStoreState(statePath, checkpointFromState(deviceId, current), runtime),
          ),
        ),
        generation: Ref.get(state).pipe(Effect.map((current) => current.generation)),
        ingest,
        snapshot,
        snapshotAfter,
      })
    }),
  )

export interface CollectorOptions {
  readonly deviceId: string
  readonly maxFingerprints?: number
  readonly maxBodyBytes: number
  readonly retentionDays?: number
  readonly statePath?: string
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

type BodyReadResult =
  | { readonly _tag: "Body"; readonly body: Uint8Array }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "TooLarge" }

const readLimited = async (
  stream: ReadableStream<Uint8Array> | null,
  maxBodyBytes: number,
): Promise<BodyReadResult> => {
  if (stream === null) return { _tag: "Body", body: new Uint8Array() }
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBodyBytes) {
        await reader.cancel()
        return { _tag: "TooLarge" }
      }
      chunks.push(next.value)
    }
    const body = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { _tag: "Body", body }
  } catch {
    return { _tag: "Invalid" }
  } finally {
    reader.releaseLock()
  }
}

const decodeGzip = (body: Uint8Array, maxBodyBytes: number): Promise<BodyReadResult> => {
  try {
    const stream = new Blob([ownedBuffer(body)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
    return readLimited(stream, maxBodyBytes)
  } catch {
    return Promise.resolve({ _tag: "Invalid" })
  }
}

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

          const rawResult = yield* Effect.promise(() => readLimited(request.body, maxBodyBytes))
          if (rawResult._tag === "TooLarge") {
            return new Response("body too large", { status: 413 })
          }
          if (rawResult._tag === "Invalid") {
            return new Response("invalid request body", { status: 400 })
          }
          let body = rawResult.body
          const contentEncoding = (
            request.headers.get("content-encoding") ?? "identity"
          ).toLowerCase()
          if (contentEncoding === "gzip") {
            const decoded = yield* Effect.promise(() => decodeGzip(body, maxBodyBytes))
            if (decoded._tag === "TooLarge") {
              return new Response("body too large", { status: 413 })
            }
            if (decoded._tag === "Invalid") {
              return new Response("invalid gzip body", { status: 400 })
            }
            body = decoded.body
          } else if (contentEncoding !== "identity" && contentEncoding !== "") {
            return new Response("unsupported content encoding", { status: 415 })
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
          const ingestion = yield* Effect.result(store.ingest(events.success))
          if (ingestion._tag === "Failure") {
            const failure = yield* codec.encodeFailure("invalid normalized usage batch", encoding)
            return response(failure, encoding, 400)
          }
          return response(yield* codec.encodeSuccess(signal, encoding), encoding)
        }),
      )

      return Collector.of({ handle })
    }),
  )

export type CollectorServices = Collector | LiveUsageStore | OtlpCodec | UsageNormalizer

export type CollectorRuntime = Crypto.Crypto | FileSystem.FileSystem | Path.Path

export type PersistentCollectorOptions = Omit<CollectorOptions, "statePath"> & {
  readonly statePath: string
}

export type MemoryCollectorOptions = Omit<CollectorOptions, "statePath"> & {
  readonly statePath?: never
}

export function collectorLayer(
  options: PersistentCollectorOptions,
): Layer.Layer<CollectorServices, LiveUsageStoreError, CollectorRuntime>
export function collectorLayer(
  options: MemoryCollectorOptions,
): Layer.Layer<CollectorServices, LiveUsageStoreError>
export function collectorLayer({
  deviceId,
  maxBodyBytes,
  maxFingerprints = 100_000,
  retentionDays = 45,
  statePath,
}: PersistentCollectorOptions | MemoryCollectorOptions): Layer.Layer<
  CollectorServices,
  LiveUsageStoreError,
  CollectorRuntime
> {
  const boundedFingerprints = Math.max(1, Math.trunc(maxFingerprints))
  const boundedRetentionDays = Math.max(1, Math.trunc(retentionDays))
  const dependencies = Layer.mergeAll(
    otlpLayer,
    normalizerLayer,
    storeLayer(deviceId, boundedRetentionDays, boundedFingerprints, statePath),
  )
  return Layer.merge(
    dependencies,
    makeCollectorLayer(maxBodyBytes).pipe(Layer.provide(dependencies)),
  )
}
