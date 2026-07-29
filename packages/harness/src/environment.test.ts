import { expect, it } from "vitest"

import { inspectHarnessEnvironment, requiredHarnessEnvironment } from "./environment"

const collectorUrl = "https://collector.lumen.build/"
const context = {
  collectorUrl,
  copilotTelemetryPath: "/home/developer/.copilot/otel/lumen-sync.jsonl",
}

it("describes the supported Copilot environment without capturing content", () => {
  expect(requiredHarnessEnvironment("copilot", context)).toEqual({
    COPILOT_OTEL_ENABLED: "true",
    COPILOT_OTEL_EXPORTER_TYPE: "file",
    COPILOT_OTEL_FILE_EXPORTER_PATH: "/home/developer/.copilot/otel/lumen-sync.jsonl",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    OTEL_SERVICE_NAME: "github-copilot",
  })
})

it("classifies missing, partial, conflicting, and exact harness environments", () => {
  const required = requiredHarnessEnvironment("copilot", context)
  expect(inspectHarnessEnvironment("copilot", context, {}).state).toBe("missing")
  expect(
    inspectHarnessEnvironment("copilot", context, {
      COPILOT_OTEL_ENABLED: "true",
    }).state,
  ).toBe("partial")
  expect(
    inspectHarnessEnvironment("copilot", context, {
      ...required,
      COPILOT_OTEL_EXPORTER_TYPE: "otlp-http",
    }),
  ).toMatchObject({
    conflicting: ["COPILOT_OTEL_EXPORTER_TYPE"],
    state: "conflicting",
  })
  expect(inspectHarnessEnvironment("copilot", context, required).state).toBe("exact")
})

it("requires an explicit OpenCode plugin endpoint", () => {
  expect(requiredHarnessEnvironment("opencode", context)).toEqual({
    LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build",
  })
})
