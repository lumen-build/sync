import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

test("rejects collector upload intervals below one second", async () => {
  const result = await runCli(["collector", "start", "--upload-interval", "0"])

  expect(result.exitCode).not.toBe(0)
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "Upload interval must be at least 1 second",
  )
})

test("prints stable JSON for harness setup and removal", async () => {
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

    const setup = await runCli(
      ["--config", configPath, "harness", "setup", "--agent", "claude", "--json"],
      environment,
    )
    expect(setup.exitCode).toBe(0)
    expect(JSON.parse(setup.stdout)).toEqual({
      operation: "setup",
      results: [
        {
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
          paths: {
            configuration: join(home, ".claude", "settings.json"),
            ownership: join(configHome, "lumen-build", "sync", "harness-ownership.json"),
          },
          state: "missing",
        },
      ],
      version: 1,
    })

    const remove = await runCli(
      ["--config", configPath, "harness", "remove", "--agent", "claude", "--json"],
      environment,
    )
    expect(remove.exitCode).toBe(0)
    expect(JSON.parse(remove.stdout)).toEqual({
      operation: "remove",
      results: [
        {
          harness: "claude",
          paths: {
            configuration: join(home, ".claude", "settings.json"),
            ownership: join(configHome, "lumen-build", "sync", "harness-ownership.json"),
          },
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
      ],
      version: 1,
    })
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})
