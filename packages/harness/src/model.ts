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

export type ManagedValue =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Present"; readonly value: Schema.Json }

export interface ManagedChange {
  readonly after: ManagedValue
  readonly before: ManagedValue
  readonly path: ReadonlyArray<string>
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
