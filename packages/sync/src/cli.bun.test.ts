import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { CliEvent } from "@lumen-build/sync-contracts"
import { Schema } from "effect"

const cliPath = join(import.meta.dir, "cli.ts")

const runCli = async (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const child = Bun.spawn([process.execPath, cliPath, ...arguments_], {
    cwd: join(import.meta.dir, "../../.."),
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { exitCode, stderr, stdout }
}

const parseEvents = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .map((event) => {
      expect(Schema.is(CliEvent)(event)).toBe(true)
      return event as typeof CliEvent.Type
    })

test("rejects collector upload intervals below one second", async () => {
  const result = await runCli(["collector", "run", "--upload-interval", "0"])

  expect(result.exitCode).not.toBe(0)
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "Upload interval must be at least 1 second",
  )
})

test("writes versioned JSONL for harness configure and remove", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-"))
  try {
    const configPath = join(home, "config.toml")
    const configHome = join(home, ".config")
    await writeFile(
      configPath,
      ["[collector]", 'listen_url = "http://127.0.0.1:4318"', ""].join("\n"),
    )
    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
    }

    const configured = await runCli(
      ["--config", configPath, "--json", "harness", "configure", "--agent", "claude"],
      environment,
    )
    expect(configured.exitCode).toBe(0)
    const [configuredEvent] = parseEvents(configured.stdout)
    expect(configuredEvent).toMatchObject({
      command: "harness.configure",
      data: {
        changed: [
          "env.CLAUDE_CODE_ENABLE_TELEMETRY",
          "env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
          "env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
          "env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
          "env.OTEL_LOG_ASSISTANT_RESPONSES",
          "env.OTEL_LOG_RAW_API_BODIES",
          "env.OTEL_LOG_TOOL_CONTENT",
          "env.OTEL_LOG_TOOL_DETAILS",
          "env.OTEL_LOG_USER_PROMPTS",
          "env.OTEL_METRICS_EXPORTER",
        ],
        harness: "claude",
        path: join(home, ".claude", "settings.json"),
        state: "missing",
      },
      protocolVersion: 1,
      sequence: 1,
      type: "result",
    })

    const removed = await runCli(
      ["--config", configPath, "--json", "harness", "remove", "--agent", "claude"],
      environment,
    )
    expect(removed.exitCode).toBe(0)
    const [removedEvent] = parseEvents(removed.stdout)
    expect(removedEvent).toMatchObject({
      command: "harness.remove",
      data: {
        harness: "claude",
        preserved: [],
        restored: [
          "env.CLAUDE_CODE_ENABLE_TELEMETRY",
          "env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
          "env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
          "env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
          "env.OTEL_LOG_ASSISTANT_RESPONSES",
          "env.OTEL_LOG_RAW_API_BODIES",
          "env.OTEL_LOG_TOOL_CONTENT",
          "env.OTEL_LOG_TOOL_DETAILS",
          "env.OTEL_LOG_USER_PROMPTS",
          "env.OTEL_METRICS_EXPORTER",
        ],
      },
      protocolVersion: 1,
      sequence: 1,
      type: "result",
    })
    expect(await Bun.file(join(dirname(configPath), "harness-ownership.json")).exists()).toBe(true)
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})

test("reports a missing endpoint as a structured error without inventing a default", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-empty-"))
  try {
    const result = await runCli(["--json", "collector", "status"], {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
    })

    expect(result.exitCode).not.toBe(0)
    expect(parseEvents(result.stdout)).toMatchObject([
      {
        command: "collector.status",
        error: {
          code: "Configuration.Missing",
          message: "Missing configuration: collector.listen_url",
          retryable: false,
        },
        protocolVersion: 1,
        sequence: 1,
        type: "error",
      },
    ])
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})
