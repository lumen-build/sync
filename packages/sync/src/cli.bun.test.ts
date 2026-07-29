import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { CliEvent } from "@lumen-build/sync-contracts"
import { makeServiceDefinition, type ServiceHost } from "@lumen-build/sync-service"
import { Effect, Schema } from "effect"

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
      USERPROFILE: home,
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
        previousState: "missing",
        state: "exact",
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

test("reports the verified post-write harness state in plain output", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-plain-"))
  try {
    const configPath = join(home, "config.toml")
    await writeFile(
      configPath,
      ["[collector]", 'listen_url = "http://127.0.0.1:4318"', ""].join("\n"),
    )
    const result = await runCli(
      ["--config", configPath, "harness", "configure", "--agent", "claude"],
      {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("claude: exact\n")
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})

test("reports Copilot's supported environment without writing user telemetry settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-copilot-"))
  try {
    const configPath = join(home, "config.toml")
    const collectorUrl = "http://127.0.0.1:4318"
    await writeFile(configPath, ["[collector]", `listen_url = "${collectorUrl}"`, ""].join("\n"))
    const telemetryPath = join(home, ".copilot", "otel", "lumen-sync.jsonl")
    const telemetryNames = new Set([
      "COPILOT_OTEL_ENABLED",
      "COPILOT_OTEL_EXPORTER_TYPE",
      "COPILOT_OTEL_FILE_EXPORTER_PATH",
      "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
      "OTEL_SERVICE_NAME",
    ])
    const isolated = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !telemetryNames.has(name)),
    )
    const baseEnvironment = {
      ...isolated,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    }
    const missing = await runCli(
      ["--config", configPath, "--json", "harness", "configure", "--agent", "copilot"],
      baseEnvironment,
    )
    expect(missing.exitCode).toBe(0)
    expect(parseEvents(missing.stdout)[0]).toMatchObject({
      command: "harness.configure",
      data: {
        changed: [],
        environment: {
          COPILOT_OTEL_ENABLED: "true",
          COPILOT_OTEL_EXPORTER_TYPE: "file",
          COPILOT_OTEL_FILE_EXPORTER_PATH: telemetryPath,
          OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
          OTEL_SERVICE_NAME: "github-copilot",
        },
        harness: "copilot",
        path: "environment",
        state: "missing",
      },
      type: "result",
    })
    expect(await Bun.file(join(home, ".copilot", "settings.json")).exists()).toBe(false)

    const exact = await runCli(
      ["--config", configPath, "--json", "harness", "status", "--agent", "copilot"],
      {
        ...baseEnvironment,
        COPILOT_OTEL_ENABLED: "true",
        COPILOT_OTEL_EXPORTER_TYPE: "file",
        COPILOT_OTEL_FILE_EXPORTER_PATH: telemetryPath,
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
        OTEL_SERVICE_NAME: "github-copilot",
      },
    )
    expect(exact.exitCode).toBe(0)
    expect(parseEvents(exact.stdout)[0]).toMatchObject({
      command: "harness.status",
      data: {
        harness: "copilot",
        path: "environment",
        state: "exact",
      },
      type: "result",
    })
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})

test("service status uses Bun plus the absolute CLI script unless explicitly overridden", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-service-"))
  try {
    const configPath = join(home, "config.toml")
    const configHome = join(home, ".config")
    await writeFile(configPath, "")
    const host: ServiceHost = {
      ...(process.env.APPDATA === undefined ? {} : { appData: process.env.APPDATA }),
      configHome,
      home,
      platform:
        process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      ...(process.getuid === undefined ? {} : { userId: process.getuid() }),
    }
    const bunDefinition = await Effect.runPromise(
      makeServiceDefinition({
        configPath,
        executablePath: process.execPath,
        host,
        prefixArguments: [cliPath],
      }),
    )
    expect(bunDefinition.artifact.contents).toContain(process.execPath)
    expect(bunDefinition.artifact.contents).toContain(cliPath)
    await mkdir(dirname(bunDefinition.artifact.path), { recursive: true })
    await writeFile(bunDefinition.artifact.path, bunDefinition.artifact.contents)

    const environment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
    }
    const bunStatus = await runCli(
      ["--config", configPath, "--json", "service", "status"],
      environment,
    )
    expect(bunStatus.exitCode).toBe(0)
    expect(parseEvents(bunStatus.stdout)[0]).toMatchObject({
      command: "service.status",
      data: { path: bunDefinition.artifact.path, status: "exact" },
      type: "result",
    })

    const nativeExecutable = join(home, "bin", "lumen-sync")
    const nativeDefinition = await Effect.runPromise(
      makeServiceDefinition({
        configPath,
        executablePath: nativeExecutable,
        host,
      }),
    )
    await writeFile(nativeDefinition.artifact.path, nativeDefinition.artifact.contents)
    const nativeStatus = await runCli(["--config", configPath, "--json", "service", "status"], {
      ...environment,
      LUMEN_EXECUTABLE_PATH: nativeExecutable,
    })
    expect(nativeStatus.exitCode).toBe(0)
    expect(parseEvents(nativeStatus.stdout)[0]).toMatchObject({
      command: "service.status",
      data: { path: nativeDefinition.artifact.path, status: "exact" },
      type: "result",
    })
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
      USERPROFILE: home,
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

test("reports the command when an explicit config path has no TOML suffix", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-config-path-"))
  try {
    const configPath = join(home, "settings")
    await writeFile(configPath, "")
    const result = await runCli(["--config", configPath, "--json", "collector", "status"], {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"),
    })

    expect(result.exitCode).not.toBe(0)
    expect(parseEvents(result.stdout)[0]).toMatchObject({
      command: "collector.status",
      type: "error",
    })
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})
