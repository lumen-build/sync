/* oxlint-disable no-underscore-dangle -- Effect-style tagged values use _tag. */

import { Schema } from "effect"

export const Harness = Schema.Literals([
  "claude",
  "codex",
  "copilot",
  "gemini",
  "opencode",
  "vscode",
])

export type Harness = typeof Harness.Type

export const HarnessIntegration = Schema.Literals(["native-otel", "opencode-plugin"])

export type HarnessIntegration = typeof HarnessIntegration.Type

export const HarnessConfigurationFormat = Schema.Literals(["jsonc", "toml"])

export type HarnessConfigurationFormat = typeof HarnessConfigurationFormat.Type

export interface HarnessDescriptor {
  readonly displayName: string
  readonly format: HarnessConfigurationFormat
  readonly id: Harness
  readonly integration: HarnessIntegration
  readonly signals: ReadonlyArray<"logs" | "metrics" | "traces">
}

export const harnessRegistry: Readonly<Record<Harness, HarnessDescriptor>> = {
  claude: {
    displayName: "Claude Code",
    format: "jsonc",
    id: "claude",
    integration: "native-otel",
    signals: ["metrics"],
  },
  codex: {
    displayName: "Codex",
    format: "toml",
    id: "codex",
    integration: "native-otel",
    signals: ["metrics"],
  },
  copilot: {
    displayName: "GitHub Copilot CLI",
    format: "jsonc",
    id: "copilot",
    integration: "native-otel",
    signals: ["metrics"],
  },
  gemini: {
    displayName: "Gemini CLI",
    format: "jsonc",
    id: "gemini",
    integration: "native-otel",
    signals: ["metrics"],
  },
  opencode: {
    displayName: "OpenCode",
    format: "jsonc",
    id: "opencode",
    integration: "opencode-plugin",
    signals: ["logs"],
  },
  vscode: {
    displayName: "Visual Studio Code",
    format: "jsonc",
    id: "vscode",
    integration: "native-otel",
    signals: ["metrics"],
  },
}

export const harnesses = Object.values(harnessRegistry)

export const HarnessStatusState = Schema.Literals([
  "conflicting",
  "exact",
  "missing",
  "partial",
  "unreadable",
])

export type HarnessStatusState = typeof HarnessStatusState.Type

export interface HarnessStatus {
  readonly harness: Harness
  readonly managed: boolean
  readonly path: string
  readonly reason?: string
  readonly state: HarnessStatusState
}

export const ManagedValue = Schema.Union([
  Schema.TaggedStruct("Absent", {}),
  Schema.TaggedStruct("Present", { value: Schema.Json }),
])

export type ManagedValue = typeof ManagedValue.Type

export const ManagedChange = Schema.Struct({
  after: ManagedValue,
  before: ManagedValue,
  path: Schema.Array(Schema.String),
})

export type ManagedChange = typeof ManagedChange.Type

const jsonEqual = Schema.toEquivalence(Schema.Json)

export const managedPathKey = (path: ReadonlyArray<string>): string => path.join("\u0000")

export const managedValuesEqual = (left: ManagedValue, right: ManagedValue): boolean => {
  if (left._tag === "Absent" || right._tag === "Absent") return left._tag === right._tag
  return jsonEqual(left.value, right.value)
}

export type ConfigurationState = "conflicting" | "exact" | "missing" | "partial"

export interface PreparedConfiguration {
  readonly changes: ReadonlyArray<ManagedChange>
  readonly contents: string
  readonly state: ConfigurationState
}

export class HarnessConfigurationError extends Schema.TaggedErrorClass<HarnessConfigurationError>()(
  "HarnessConfigurationError",
  {
    harness: Harness,
    reason: Schema.String,
  },
) {}

export class HarnessConfigurationConflict extends Schema.TaggedErrorClass<HarnessConfigurationConflict>()(
  "HarnessConfigurationConflict",
  {
    fields: Schema.Array(Schema.String),
    harness: Harness,
  },
) {}
