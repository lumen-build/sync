/* oxlint-disable no-underscore-dangle -- Effect-style tagged values use _tag. */

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
  managedPathKey,
  managedValuesEqual,
} from "./model"

interface ManagedSetting {
  readonly operation?: "ensure-array-member"
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
const isPresent = (
  value: ManagedValue,
): value is Extract<ManagedValue, { readonly _tag: "Present" }> => value._tag === "Present"

const baseUrl = (collectorUrl: string): string => collectorUrl.replace(/\/+$/u, "")
const openCodePlugin = "@lumen-build/sync"
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
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint(collectorUrl, "metrics"),
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_LOG_RAW_API_BODIES: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_METRICS_EXPORTER: "otlp",
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
        {
          path: ["otel", "metrics_exporter"],
          value: present(otlpHttp(collectorUrl, "metrics")),
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
      return [
        {
          operation: "ensure-array-member",
          path: ["plugin"],
          value: present([openCodePlugin]),
        },
      ]
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

const settingsFor = (
  harness: Harness,
  collectorUrl: string,
  root: unknown,
): ReadonlyArray<ManagedSetting> =>
  specifications(harness, collectorUrl).map((setting) => {
    if (setting.operation !== "ensure-array-member") return setting
    const observed = readPath(root, setting.path)
    if (
      !observed.supported ||
      observed.value._tag !== "Present" ||
      !Array.isArray(observed.value.value) ||
      !observed.value.value.every((value) => typeof value === "string") ||
      setting.value._tag !== "Present" ||
      !Array.isArray(setting.value.value)
    ) {
      return setting
    }
    const current = observed.value.value as ReadonlyArray<string>
    const members = setting.value.value as ReadonlyArray<string>
    return {
      ...setting,
      value: present([...new Set([...current, ...members])]),
    }
  })

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

const isAdditiveChange = (setting: ManagedSetting, change: ManagedChange): boolean => {
  if (
    setting.operation !== "ensure-array-member" ||
    !isPresent(change.before) ||
    !isPresent(change.after) ||
    !Array.isArray(change.before.value) ||
    !Array.isArray(change.after.value)
  ) {
    return false
  }

  const before = change.before.value
  const after = change.after.value
  return (
    before.every((member) => after.includes(member)) &&
    isPresent(setting.value) &&
    Array.isArray(setting.value.value) &&
    setting.value.value.every((member) => after.includes(member))
  )
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

const acceptsMergedValue = (setting: ManagedSetting, value: ManagedValue): boolean => {
  if (
    setting.operation !== "ensure-array-member" ||
    !isPresent(setting.value) ||
    !Array.isArray(setting.value.value) ||
    !isPresent(value) ||
    !Array.isArray(value.value)
  ) {
    return false
  }
  const expected = setting.value.value
  const actual = value.value
  return expected.every((member) => actual.includes(member))
}

const invalidOwnershipField = (
  settings: ReadonlyArray<ManagedSetting>,
  changes: ReadonlyArray<ManagedChange>,
): string | undefined => {
  const seen = new Set<string>()
  for (const change of changes) {
    const key = managedPathKey(change.path)
    const setting = settings.find((candidate) => managedPathKey(candidate.path) === key)
    const validMergedSetting = setting !== undefined && acceptsMergedValue(setting, change.after)
    if (
      setting === undefined ||
      seen.has(key) ||
      (!validMergedSetting && !managedValuesEqual(change.after, setting.value))
    )
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
  const settings = settingsFor(harness, collectorUrl, root)
  const observed = settings.map((setting) => ({ setting, value: readPath(root, setting.path) }))
  const unsupported = observed.find((item) => !item.value.supported)
  if (unsupported !== undefined) {
    return yield* new HarnessConfigurationError({
      harness,
      reason: `managed field ${unsupported.setting.path.join(".")} contains an unsupported value`,
    })
  }
  const differences = observed.flatMap(({ setting, value }) =>
    value.supported && !managedValuesEqual(value.value, setting.value)
      ? [{ after: setting.value, before: value.value, path: setting.path }]
      : [],
  )
  const settingFor = (change: ManagedChange): ManagedSetting | undefined =>
    settings.find((setting) => managedPathKey(setting.path) === managedPathKey(change.path))
  const conflicts = differences.filter((change) => {
    const setting = settingFor(change)
    return (
      change.before._tag === "Present" &&
      (setting === undefined || !isAdditiveChange(setting, change))
    )
  })
  const state = stateFor(differences, conflicts, settings.length)
  if (conflicts.length > 0 && !force) {
    return yield* new HarnessConfigurationConflict({
      fields: conflicts.map((change) => change.path.join(".")),
      harness,
    })
  }
  const changes = force
    ? differences
    : differences.filter(
        (change) =>
          change.before._tag === "Absent" ||
          (settingFor(change) !== undefined && isAdditiveChange(settingFor(change)!, change)),
      )
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
  const document =
    harness === "codex" ? yield* parseToml(harness, contents) : yield* parseJson(harness, contents)
  const root: unknown = document instanceof TomlDocument ? document.toJsObject : document.root
  const settings = specifications(harness, collectorUrl)
  const invalidField = invalidOwnershipField(settings, changes)
  if (invalidField !== undefined) {
    return yield* new HarnessConfigurationError({
      harness,
      reason: `ownership contains an invalid managed field: ${invalidField}`,
    })
  }
  const observed = changes.map((change) => ({
    change,
    setting: settings.find(
      (setting) => managedPathKey(setting.path) === managedPathKey(change.path),
    )!,
    value: readPath(root, change.path),
  }))
  const reverseChanges = observed.flatMap(({ change, setting, value }) => {
    if (!value.supported) return []
    if (
      setting.operation === "ensure-array-member" &&
      isPresent(value.value) &&
      Array.isArray(value.value.value) &&
      isPresent(change.after) &&
      Array.isArray(change.after.value)
    ) {
      const before =
        isPresent(change.before) && Array.isArray(change.before.value) ? change.before.value : []
      const inserted = change.after.value.filter((member) => !before.includes(member))
      const next = value.value.value.filter((member) => !inserted.includes(member))
      if (next.length === value.value.value.length) return []
      return [
        {
          after: next.length === 0 && change.before._tag === "Absent" ? absent : present(next),
          before: value.value,
          path: change.path,
        } satisfies ManagedChange,
      ]
    }
    return managedValuesEqual(value.value, change.after)
      ? [{ after: change.before, before: change.after, path: change.path }]
      : []
  })
  const restoredKeys = new Set(reverseChanges.map((change) => managedPathKey(change.path)))
  const preserved = changes
    .filter((change) => !restoredKeys.has(managedPathKey(change.path)))
    .map((change) => change.path.join("."))
  const restored = reverseChanges.map((change) => change.path.join("."))

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
