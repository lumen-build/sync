type JsonObject = Readonly<Record<string, unknown>>

interface AssistantUsage {
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost?: number
  readonly id: string
  readonly input: number
  readonly model: string
  readonly occurredAt: string
  readonly output: number
  readonly provider: string
  readonly reasoning: number
}

interface PendingModel {
  readonly model: string
  readonly provider: string
}

export interface OpenCodeUsageState {
  readonly emitted: Set<string>
  readonly limit: number
  readonly pendingModels: Map<string, PendingModel>
}

export const makeOpenCodeUsageState = (limit = 10_000): OpenCodeUsageState => ({
  emitted: new Set(),
  limit: Math.max(1, Math.trunc(limit)),
  pendingModels: new Map(),
})

const removeOldest = <Value>(values: Set<string> | Map<string, Value>): void => {
  const oldest = values.keys().next().value
  if (oldest !== undefined) values.delete(oldest)
}

const remember = (values: Set<string>, value: string, limit: number): void => {
  if (values.size >= limit) removeOldest(values)
  values.add(value)
}

const rememberModel = (
  values: Map<string, PendingModel>,
  id: string,
  model: PendingModel,
  limit: number,
): void => {
  if (!values.has(id) && values.size >= limit) removeOldest(values)
  values.set(id, model)
}

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0

const milliseconds = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  return new Date().toISOString()
}

const assistantUsage = (info: JsonObject): AssistantUsage | undefined => {
  if (info.role !== "assistant" && info.type !== "assistant") return undefined
  const tokens = object(info.tokens)
  const cache = object(tokens?.cache)
  const model = object(info.model)
  const time = object(info.time)
  const id = text(info.id) ?? text(info.messageID)
  if (tokens === undefined || id === undefined) return undefined

  return {
    cacheRead: number(cache?.read),
    cacheWrite: number(cache?.write),
    ...(typeof info.cost === "number" && Number.isFinite(info.cost)
      ? { cost: Math.max(0, info.cost) }
      : {}),
    id,
    input: number(tokens.input),
    model: text(info.modelID) ?? text(model?.id) ?? "unknown",
    occurredAt: milliseconds(time?.completed ?? time?.created),
    output: number(tokens.output),
    provider: text(info.providerID) ?? text(model?.providerID) ?? "unknown",
    reasoning: number(tokens.reasoning),
  }
}

const stepStarted = (
  properties: JsonObject,
  state: OpenCodeUsageState,
): ReadonlyArray<AssistantUsage> => {
  const id = text(properties.assistantMessageID)
  const model = object(properties.model)
  if (id !== undefined && model !== undefined) {
    rememberModel(
      state.pendingModels,
      id,
      {
        model: text(model.modelID) ?? text(model.id) ?? "unknown",
        provider: text(model.providerID) ?? "unknown",
      },
      state.limit,
    )
  }
  return []
}

const stepEnded = (
  properties: JsonObject,
  state: OpenCodeUsageState,
): ReadonlyArray<AssistantUsage> => {
  const id = text(properties.assistantMessageID)
  const tokens = object(properties.tokens)
  if (id === undefined || tokens === undefined) return []
  const model = state.pendingModels.get(id)
  const cache = object(tokens.cache)
  state.pendingModels.delete(id)
  return [
    {
      cacheRead: number(cache?.read),
      cacheWrite: number(cache?.write),
      ...(typeof properties.cost === "number" && Number.isFinite(properties.cost)
        ? { cost: Math.max(0, properties.cost) }
        : {}),
      id,
      input: number(tokens.input),
      model: model?.model ?? "unknown",
      occurredAt: milliseconds(properties.time ?? properties.timestamp),
      output: number(tokens.output),
      provider: model?.provider ?? "unknown",
      reasoning: number(tokens.reasoning),
    },
  ]
}

export const usageFromOpenCodeEvent = (
  input: unknown,
  state: OpenCodeUsageState,
): ReadonlyArray<AssistantUsage> => {
  const event = object(input)
  const eventType = text(event?.type)
  const properties = object(event?.properties)
  if (eventType === undefined || properties === undefined) return []

  let candidates: ReadonlyArray<AssistantUsage>
  if (eventType === "message.updated") {
    const usage = assistantUsage(object(properties.info) ?? properties)
    candidates = usage === undefined ? [] : [usage]
  } else if (eventType === "session.next.step.started") {
    candidates = stepStarted(properties, state)
  } else if (eventType === "session.next.step.ended") {
    candidates = stepEnded(properties, state)
  } else {
    candidates = []
  }

  return candidates.filter((usage) => {
    state.pendingModels.delete(usage.id)
    if (state.emitted.has(usage.id)) return false
    remember(state.emitted, usage.id, state.limit)
    return true
  })
}

const attribute = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
})

export const toOtlpLogs = (usage: ReadonlyArray<AssistantUsage>): JsonObject => ({
  resourceLogs: [
    {
      resource: {
        attributes: [attribute("service.name", "opencode")],
      },
      scopeLogs: [
        {
          logRecords: usage.map((item) => ({
            attributes: [
              attribute("gen_ai.provider.name", item.provider),
              attribute("gen_ai.request.model", item.model),
              attribute("gen_ai.usage.input_tokens", item.input),
              attribute("gen_ai.usage.output_tokens", item.output),
              attribute("gen_ai.usage.reasoning_tokens", item.reasoning),
              attribute("gen_ai.usage.cache_read_input_tokens", item.cacheRead),
              attribute("gen_ai.usage.cache_creation_input_tokens", item.cacheWrite),
              ...(item.cost === undefined
                ? []
                : [attribute("gen_ai.usage.cost", String(item.cost))]),
              attribute("lumen.source.event_id", item.id),
            ],
            eventName: "gen_ai.client.inference.operation.details",
            timeUnixNano: String(BigInt(new Date(item.occurredAt).getTime()) * 1_000_000n),
          })),
        },
      ],
    },
  ],
})

const logsEndpoint = (endpoint: string): string => {
  const normalized = endpoint.replace(/\/+$/u, "")
  return normalized.endsWith("/v1/logs") ? normalized : `${normalized}/v1/logs`
}

interface OpenCodePluginInput {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

interface OpenCodeEventInput {
  readonly event: unknown
}

export const LumenSync = async (
  input: OpenCodePluginInput = {},
): Promise<{ readonly event?: (input: OpenCodeEventInput) => Promise<void> }> => {
  const environment =
    input.environment ??
    (typeof process === "undefined"
      ? {}
      : (process.env as Readonly<Record<string, string | undefined>>))
  const endpoint =
    environment.LUMEN_COLLECTOR_OTLP_ENDPOINT ?? environment.OTEL_EXPORTER_OTLP_ENDPOINT
  if (endpoint === undefined || endpoint.length === 0) return {}

  const state = makeOpenCodeUsageState()
  return {
    event: async ({ event }) => {
      const usage = usageFromOpenCodeEvent(event, state)
      if (usage.length === 0) return
      const response = await fetch(logsEndpoint(endpoint), {
        body: JSON.stringify(toOtlpLogs(usage)),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      if (!response.ok) {
        throw new Error(`Lumen Sync collector rejected OpenCode usage (${response.status})`)
      }
    },
  }
}
