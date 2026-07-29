import { stringify, TomlDocument, TomlFormat } from "@decimalturn/toml-patch"
import { Effect, Option, Predicate, Schema } from "effect"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { FormattingOptions, ParseError } from "jsonc-parser"

import {
  HarnessConfigurationConflict,
  HarnessConfigurationError,
  type ConfigurationState,
  type Harness,
  type ManagedChange,
  type ManagedValue,
  type PreparedConfiguration,
} from "./model"

interface ManagedSetting {
  readonly path: ReadonlyArray<string>
  readonly value: ManagedValue
}

type ObservedValue =
  | { readonly supported: false }
  | { readonly supported: true; readonly value: ManagedValue }

export interface PrepareOptions {
  readonly collectorUrl: string
  readonly contents: string
  readonly force: boolean
  readonly harness: Harness
}

export interface RemoveOptions {
  readonly changes: ReadonlyArray<ManagedChange>
  readonly collectorUrl: string
  readonly contents: string
  readonly harness: Harness
}

export interface PreparedRemoval {
  readonly contents: string
  readonly empty: boolean
  readonly preserved: ReadonlyArray<string>
  readonly restored: ReadonlyArray<string>
}

const present = (value: Schema.Json): ManagedValue => ({ _tag: "Present", value })
const absent: ManagedValue = { _tag: "Absent" }
const jsonEqual = Schema.toEquivalence(Schema.Json)
const isPresent = (
  value: ManagedValue,
): value is Extract<ManagedValue, { readonly _tag: "Present" }> => value._tag === "Present"

const baseUrl = (collectorUrl: string): string => collectorUrl.replace(/\/+$/u, "")
const endpoint = (collectorUrl: string, signal: "logs" | "metrics" | "traces"): string =>
  `${baseUrl(collectorUrl)}/v1/${signal}`

const otlpHttp = (collectorUrl: string, signal: "logs" | "metrics" | "traces"): Schema.Json => ({
  "otlp-http": {
    endpoint: endpoint(collectorUrl, signal),
    protocol: "binary",
  },
})

const claudeSettings = (collectorUrl: string): ReadonlyArray<ManagedSetting> => {
  const environment: Readonly<Record<string, string>> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint(collectorUrl, "logs"),
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint(collectorUrl, "metrics"),
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint(collectorUrl, "traces"),
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_LOG_RAW_API_BODIES: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
  }
  return Object.entries(environment).map(([name, value]) => ({
    path: ["env", name],
    value: present(value),
  }))
}

export const specifications = (
  harness: Harness,
  collectorUrl: string,
): ReadonlyArray<ManagedSetting> => {
  switch (harness) {
    case "claude":
      return claudeSettings(collectorUrl)
    case "codex":
      return [
        { path: ["otel", "log_user_prompt"], value: present(false) },
        { path: ["otel", "exporter"], value: present(otlpHttp(collectorUrl, "logs")) },
        {
          path: ["otel", "metrics_exporter"],
          value: present(otlpHttp(collectorUrl, "metrics")),
        },
        {
          path: ["otel", "trace_exporter"],
          value: present(otlpHttp(collectorUrl, "traces")),
        },
      ]
    case "copilot":
      return [
        { path: ["telemetry", "enabled"], value: present(true) },
        { path: ["telemetry", "endpoint"], value: present(baseUrl(collectorUrl)) },
        { path: ["telemetry", "protocol"], value: present("http/protobuf") },
        { path: ["telemetry", "captureContent"], value: present(false) },
        { path: ["telemetry", "serviceName"], value: present("github-copilot") },
      ]
    case "gemini":
      return [
        { path: ["telemetry", "enabled"], value: present(true) },
        { path: ["telemetry", "target"], value: present("local") },
        { path: ["telemetry", "useCollector"], value: present(true) },
        { path: ["telemetry", "otlpEndpoint"], value: present(baseUrl(collectorUrl)) },
        { path: ["telemetry", "otlpProtocol"], value: present("http") },
        { path: ["telemetry", "logPrompts"], value: present(false) },
        { path: ["telemetry", "traces"], value: present(false) },
        { path: ["telemetry", "outfile"], value: absent },
      ]
    case "opencode":
      return [{ path: ["plugin"], value: present(["@lumen-build/sync/opencode"]) }]
    case "vscode":
      return [
        { path: ["github.copilot.chat.otel.enabled"], value: present(true) },
        {
          path: ["github.copilot.chat.otel.exporterType"],
          value: present("otlp-http"),
        },
        {
          path: ["github.copilot.chat.otel.otlpEndpoint"],
          value: present(baseUrl(collectorUrl)),
        },
        { path: ["github.copilot.chat.otel.captureContent"], value: present(false) },
      ]
  }
}

const readPath = (root: unknown, path: ReadonlyArray<string>): ObservedValue => {
  let current = root
  for (const segment of path) {
    if (!Predicate.isObject(current)) return { supported: false }
    if (!(segment in current)) return { supported: true, value: absent }
    current = current[segment]
  }
  const value = Schema.decodeUnknownOption(Schema.Json)(current)
  return Option.isSome(value)
    ? { supported: true, value: present(value.value) }
    : { supported: false }
}

const valuesEqual = (left: ManagedValue, right: ManagedValue): boolean => {
  if (left._tag === "Absent" || right._tag === "Absent") return left._tag === right._tag
  return jsonEqual(left.value, right.value)
}

const setPath = (
  root: unknown,
  path: ReadonlyArray<string>,
  value: ManagedValue,
): Record<string, unknown> => {
  const [segment, ...remaining] = path
  if (segment === undefined) return Predicate.isObject(root) ? { ...root } : {}
  const output = Predicate.isObject(root) ? { ...root } : {}
  if (remaining.length === 0) {
    if (value._tag === "Absent") delete output[segment]
    else output[segment] = value.value
    return output
  }
  output[segment] = setPath(output[segment], remaining, value)
  return output
}

const stateFor = (
  changes: ReadonlyArray<ManagedChange>,
  conflicts: ReadonlyArray<ManagedChange>,
  total: number,
): ConfigurationState => {
  if (conflicts.length > 0) return "conflicting"
  if (changes.length === 0) return "exact"
  return changes.length === total ? "missing" : "partial"
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const configurationError = (harness: Harness, cause: unknown): HarnessConfigurationError =>
  new HarnessConfigurationError({ harness, reason: reason(cause) })

const parseToml = (harness: Harness, contents: string) =>
  Effect.try({
    try: () => new TomlDocument(contents),
    catch: (cause) => configurationError(harness, cause),
  })

const parseJson = (harness: Harness, contents: string) =>
  Effect.gen(function* () {
    const source = contents.trim().length === 0 ? "{}\n" : contents
    const errors: Array<ParseError> = []
    const root: unknown = parse(source, errors, { allowTrailingComma: true })
    if (errors.length > 0 || !Predicate.isObject(root)) {
      return yield* new HarnessConfigurationError({
        harness,
        reason: "configuration must contain one valid JSON object",
      })
    }
    return { root, source }
  })

const jsonFormatting: FormattingOptions = {
  eol: "\n",
  insertSpaces: true,
  tabSize: 2,
}

const tomlValueFormat = TomlFormat.default()
tomlValueFormat.inlineTableStart = 0
tomlValueFormat.trailingNewline = 0

const tomlKey = (segment: string): string =>
  /^[A-Za-z\d_-]+$/u.test(segment) ? segment : JSON.stringify(segment)

const tomlValue = (value: Schema.Json): string =>
  stringify({ __lumen_value: value }, tomlValueFormat).replace(/^__lumen_value\s*=\s*/u, "")

const usesDottedOtelKeys = (contents: string): boolean =>
  /^[\t ]*(?:\uFEFF)?otel[\t ]*\./mu.test(contents)

const insertDottedTomlChanges = (
  contents: string,
  changes: ReadonlyArray<ManagedChange>,
): string => {
  if (changes.length === 0) return contents
  const newline = contents.includes("\r\n") ? "\r\n" : "\n"
  const lines = contents.split(/\r?\n/u)
  const insertionIndex = lines.findLastIndex((line) => /^[\t ]*(?:\uFEFF)?otel[\t ]*\./u.test(line))
  const assignments = changes.flatMap((change) =>
    isPresent(change.after)
      ? [`${change.path.map(tomlKey).join(".")} = ${tomlValue(change.after.value)}`]
      : [],
  )
  lines.splice(insertionIndex + 1, 0, ...assignments)
  return lines.join(newline)
}

const renderJson = (source: string, changes: ReadonlyArray<ManagedChange>): string =>
  changes.reduce(
    (current, change) =>
      applyEdits(
        current,
        modify(
          current,
          [...change.path],
          isPresent(change.after) ? change.after.value : undefined,
          {
            formattingOptions: jsonFormatting,
          },
        ),
      ),
    source,
  )

const isSemanticallyEmpty = (value: unknown): boolean =>
  Predicate.isObject(value) && Object.values(value).every(isSemanticallyEmpty)

const invalidOwnershipField = (
  settings: ReadonlyArray<ManagedSetting>,
  changes: ReadonlyArray<ManagedChange>,
): string | undefined => {
  const seen = new Set<string>()
  for (const change of changes) {
    const key = change.path.join(".")
    const setting = settings.find((candidate) => candidate.path.join(".") === key)
    if (setting === undefined || seen.has(key) || !valuesEqual(change.after, setting.value))
      return key
    seen.add(key)
  }
  return undefined
}

export const prepareConfiguration = Effect.fn("HarnessConfiguration.prepare")(function* ({
  collectorUrl,
  contents,
  force,
  harness,
}: PrepareOptions) {
  const document =
    harness === "codex" ? yield* parseToml(harness, contents) : yield* parseJson(harness, contents)
  const root: unknown = document instanceof TomlDocument ? document.toJsObject : document.root
  const settings = specifications(harness, collectorUrl)
  const observed = settings.map((setting) => ({ setting, value: readPath(root, setting.path) }))
  const unsupported = observed.find((item) => !item.value.supported)
  if (unsupported !== undefined) {
    return yield* new HarnessConfigurationError({
      harness,
      reason: `managed field ${unsupported.setting.path.join(".")} contains an unsupported value`,
    })
  }
  const differences = observed.flatMap(({ setting, value }) =>
    value.supported && !valuesEqual(value.value, setting.value)
      ? [{ after: setting.value, before: value.value, path: setting.path }]
      : [],
  )
  const conflicts = differences.filter((change) => change.before._tag === "Present")
  const state = stateFor(differences, conflicts, settings.length)
  if (conflicts.length > 0 && !force) {
    return yield* new HarnessConfigurationConflict({
      fields: conflicts.map((change) => change.path.join(".")),
      harness,
    })
  }
  const changes = force
    ? differences
    : differences.filter((change) => change.before._tag === "Absent")
  if (changes.length === 0) return { changes, contents, state } satisfies PreparedConfiguration

  if (document instanceof TomlDocument) {
    const dottedAdditions = usesDottedOtelKeys(contents)
      ? changes.filter(
          (change) => change.before._tag === "Absent" && change.after._tag === "Present",
        )
      : []
    const patchedChanges = changes.filter((change) => !dottedAdditions.includes(change))
    const updated = patchedChanges.reduce(
      (current, change) => setPath(current, change.path, change.after),
      root,
    )
    const rendered = yield* Effect.try({
      try: () => {
        document.patch(updated)
        return insertDottedTomlChanges(document.toTomlString, dottedAdditions)
      },
      catch: (cause) => configurationError(harness, cause),
    })
    return { changes, contents: rendered, state } satisfies PreparedConfiguration
  }

  return {
    changes,
    contents: renderJson(document.source, changes),
    state,
  } satisfies PreparedConfiguration
})

export const prepareRemoval = Effect.fn("HarnessConfiguration.prepareRemoval")(function* ({
  changes,
  collectorUrl,
  contents,
  harness,
}: RemoveOptions) {
  const settings = specifications(harness, collectorUrl)
  const invalidField = invalidOwnershipField(settings, changes)
  if (invalidField !== undefined) {
    return yield* new HarnessConfigurationError({
      harness,
      reason: `ownership contains an invalid managed field: ${invalidField}`,
    })
  }
  const document =
    harness === "codex" ? yield* parseToml(harness, contents) : yield* parseJson(harness, contents)
  const root: unknown = document instanceof TomlDocument ? document.toJsObject : document.root
  const observed = changes.map((change) => ({ change, value: readPath(root, change.path) }))
  const restorable = observed
    .filter((item) => item.value.supported && valuesEqual(item.value.value, item.change.after))
    .map((item) => item.change)
  const preserved = observed
    .filter((item) => !item.value.supported || !valuesEqual(item.value.value, item.change.after))
    .map((item) => item.change.path.join("."))
  const restored = restorable.map((change) => change.path.join("."))
  const reverseChanges = restorable.map(
    (change): ManagedChange => ({
      after: change.before,
      before: change.after,
      path: change.path,
    }),
  )

  if (document instanceof TomlDocument) {
    const updated = reverseChanges.reduce(
      (current, change) => setPath(current, change.path, change.after),
      root,
    )
    const rendered = yield* Effect.try({
      try: () => {
        document.patch(updated)
        return document.toTomlString
      },
      catch: (cause) => configurationError(harness, cause),
    })
    const reparsed = yield* parseToml(harness, rendered)
    return {
      contents: rendered,
      empty: isSemanticallyEmpty(reparsed.toJsObject),
      preserved,
      restored,
    } satisfies PreparedRemoval
  }

  const rendered = renderJson(document.source, reverseChanges)
  const reparsed = yield* parseJson(harness, rendered)
  return {
    contents: rendered,
    empty: isSemanticallyEmpty(reparsed.root),
    preserved,
    restored,
  } satisfies PreparedRemoval
})
