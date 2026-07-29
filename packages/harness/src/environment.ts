import { normalizeCollectorUrl } from "./collector-url"
import { configurationState, type Harness, type HarnessStatusState } from "./model"

export interface HarnessEnvironmentInspection {
  readonly conflicting: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly required: Readonly<Record<string, string>>
  readonly state: Exclude<HarnessStatusState, "unreadable">
}

export interface HarnessEnvironmentContext {
  readonly collectorUrl: string
  readonly copilotTelemetryPath: string
}

export const requiredHarnessEnvironment = (
  harness: Harness,
  context: HarnessEnvironmentContext,
): Readonly<Record<string, string>> => {
  switch (harness) {
    case "copilot":
      return {
        COPILOT_OTEL_ENABLED: "true",
        COPILOT_OTEL_EXPORTER_TYPE: "file",
        COPILOT_OTEL_FILE_EXPORTER_PATH: context.copilotTelemetryPath,
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
        OTEL_SERVICE_NAME: "github-copilot",
      }
    case "opencode":
      return {
        LUMEN_COLLECTOR_OTLP_ENDPOINT: normalizeCollectorUrl(context.collectorUrl),
      }
    default:
      return {}
  }
}

export const inspectHarnessEnvironment = (
  harness: Harness,
  context: HarnessEnvironmentContext,
  environment: Readonly<Record<string, string | undefined>>,
): HarnessEnvironmentInspection => {
  const required = requiredHarnessEnvironment(harness, context)
  const entries = Object.entries(required)
  const missing = entries.filter(([name]) => environment[name] === undefined).map(([name]) => name)
  const conflicting = entries
    .filter(([name, value]) => environment[name] !== undefined && environment[name] !== value)
    .map(([name]) => name)
  const state = configurationState(missing.length, conflicting.length, entries.length)

  return { conflicting, missing, required, state }
}
