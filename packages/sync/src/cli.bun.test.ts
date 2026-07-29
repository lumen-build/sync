import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { CliEvent } from "@lumen-build/sync-contracts"
import { makeServiceDefinition, type ServiceHost } from "@lumen-build/sync-service"
import { Effect, Schema } from "effect"

const cliPath = join(import.meta.dir, "cli.ts")

const runCli = async (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = join(import.meta.dir, "../../.."),
) => {
  const child = Bun.spawn([process.execPath, cliPath, ...arguments_], {
    cwd,
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

test("reports the package manifest version", async () => {
  const manifest = (await import("../package.json")) as { readonly version: string }
  const result = await runCli(["--version"])

  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe(`lumen-sync v${manifest.version}`)
})

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
    await writeFile(configPath, "")
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

test("resolves a bare config filename before deriving private and service paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-relative-config-"))
  try {
    const canonicalHome = await realpath(home)
    const configPath = join(canonicalHome, "config.toml")
    const executablePath = join(canonicalHome, "bin", "lumen-sync")
    await writeFile(configPath, "")
    const environment = {
      ...process.env,
      HOME: canonicalHome,
      LUMEN_EXECUTABLE_PATH: executablePath,
      USERPROFILE: canonicalHome,
      XDG_CONFIG_HOME: join(canonicalHome, ".config"),
    }
    const pathResult = await runCli(
      ["--config", "config.toml", "--json", "config", "path"],
      environment,
      canonicalHome,
    )
    expect(pathResult.exitCode).toBe(0)
    expect(parseEvents(pathResult.stdout)[0]).toMatchObject({
      command: "config.path",
      data: { path: configPath },
      type: "result",
    })

    const definition = await Effect.runPromise(
      makeServiceDefinition({
        configPath,
        executablePath,
        host: {
          ...(process.env.APPDATA === undefined ? {} : { appData: process.env.APPDATA }),
          configHome: join(canonicalHome, ".config"),
          home: canonicalHome,
          platform:
            process.platform === "win32"
              ? "win32"
              : process.platform === "darwin"
                ? "darwin"
                : "linux",
          ...(process.getuid === undefined ? {} : { userId: process.getuid() }),
        },
      }),
    )
    await mkdir(dirname(definition.artifact.path), { recursive: true })
    await writeFile(definition.artifact.path, definition.artifact.contents)
    const serviceResult = await runCli(
      ["--config", "config.toml", "--json", "service", "status"],
      environment,
      canonicalHome,
    )
    expect(serviceResult.exitCode).toBe(0)
    expect(parseEvents(serviceResult.stdout)[0]).toMatchObject({
      data: { status: "exact" },
      type: "result",
    })
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})

test("maps OIDC init flags, deduplicates scopes, and writes private non-secret TOML", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-oidc-init-"))
  try {
    const configPath = join(home, "config.toml")
    const environment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    }
    const common = [
      "--config",
      configPath,
      "--json",
      "config",
      "init",
      "--collector",
      "http://127.0.0.1:4318",
      "--destination",
      "https://usage.lumen.build",
      "--auth",
      "oidc",
    ]
    const missing = await runCli(
      [...common, "--oidc-issuer", "https://identity.lumen.build"],
      environment,
    )
    expect(missing.exitCode).not.toBe(0)
    expect(parseEvents(missing.stdout)[0]).toMatchObject({
      command: "config.init",
      error: { code: "Configuration.Invalid" },
      type: "error",
    })

    const initialized = await runCli(
      [
        ...common,
        "--oidc-issuer",
        "https://identity.lumen.build",
        "--oidc-client-id",
        "sync-cli",
        "--oidc-redirect-uri",
        "http://127.0.0.1:9876/callback",
        "--oidc-scope",
        "openid",
        "--oidc-scope",
        "openid",
        "--oidc-scope",
        "offline_access",
      ],
      environment,
    )
    expect(initialized.exitCode).toBe(0)
    expect(parseEvents(initialized.stdout)[0]).toMatchObject({
      command: "config.init",
      data: {
        configuration: {
          auth: {
            mode: "oidc",
            oidc: {
              scopes: ["openid", "offline_access"],
            },
          },
        },
      },
      type: "result",
    })
    const contents = await readFile(configPath, "utf8")
    expect(contents).not.toContain("password")
    if (process.platform !== "win32") expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})

test("doctor reports missing, healthy, and conflicting harness states", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-doctor-"))
  try {
    const configPath = join(home, "config.toml")
    const environment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    }
    await writeFile(configPath, "")
    const missing = await runCli(["--config", configPath, "--json", "doctor"], environment)
    expect(missing.exitCode).toBe(0)
    expect(parseEvents(missing.stdout)).toMatchObject([
      {
        command: "doctor",
        data: { issue: "collector.listen_url is not configured" },
        type: "warning",
      },
      {
        command: "doctor",
        data: { ok: false },
        type: "result",
      },
    ])

    await writeFile(
      configPath,
      ["[collector]", 'listen_url = "http://127.0.0.1:4318"', ""].join("\n"),
    )
    const healthy = await runCli(["--config", configPath, "--json", "doctor"], environment)
    expect(healthy.exitCode).toBe(0)
    expect(parseEvents(healthy.stdout)).toMatchObject([
      {
        command: "doctor",
        data: { issues: [], ok: true },
        type: "result",
      },
    ])

    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" } }),
    )
    const conflicting = await runCli(["--config", configPath, "--json", "doctor"], environment)
    expect(conflicting.exitCode).toBe(0)
    expect(parseEvents(conflicting.stdout)).toMatchObject([
      {
        command: "doctor",
        data: { issue: "claude: conflicting" },
        type: "warning",
      },
      {
        command: "doctor",
        data: { issues: ["claude: conflicting"], ok: false },
        type: "result",
      },
    ])
  } finally {
    await rm(home, { force: true, recursive: true })
  }
})

test("rejects credentialed configuration without printing embedded credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumen-sync-cli-secret-url-"))
  try {
    const configPath = join(home, "config.toml")
    const secret = "must-not-appear"
    await writeFile(
      configPath,
      ["[destination]", `base_url = "https://user:${secret}@usage.lumen.build"`, ""].join("\n"),
    )
    const result = await runCli(["--config", configPath, "--json", "config", "show"], {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    })
    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret)
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
