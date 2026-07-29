import { join } from "node:path"

import { expect, it } from "bun:test"
import { Effect, Schema } from "effect"

import {
  aimock,
  HarnessAgent,
  type HarnessAgent as HarnessAgentType,
  type HarnessDependencies,
  type ExternalCommandResult,
  harnessDependencies,
  HarnessE2eError,
  linkPackedOpenCodePlugin,
  loopbackPort,
  readJsonFile,
  runExternal,
} from "./support/harness-runtime.js"
import { mockDestination, type MockDestination } from "./support/mock-destination.js"
import {
  configArguments,
  isolatedEnvironment,
  nextCollectorEvent,
  packedCli,
  readyUrl,
  startCollector,
  type PackedCli,
} from "./support/packed-cli.js"

const versions: Readonly<Record<HarnessAgentType, string>> = {
  claude: "2.1.220",
  codex: "0.146.0",
  gemini: "0.53.0",
  opencode: "1.18.9",
}

const nativeLiveProof: Readonly<Record<HarnessAgentType, "envelope" | "none" | "tokens">> = {
  claude: "tokens",
  codex: "tokens",
  gemini: "none",
  opencode: "envelope",
}

const canaryFor = (agent: HarnessAgentType): string => `LUMEN_E2E_${agent.toUpperCase()}_CANARY`

const configText = (collectorUrl: string, destinationUrl: string): string =>
  [
    "[collector]",
    `listen_url = ${JSON.stringify(collectorUrl)}`,
    "",
    "[destination]",
    `base_url = ${JSON.stringify(destinationUrl)}`,
    "",
    "[auth]",
    'mode = "bearer"',
    "",
  ].join("\n")

const commandFailure = (operation: string, result: ExternalCommandResult) =>
  new HarnessE2eError({
    operation,
    reason:
      result.stderr.trim() || result.stdout.trim() || `command exited with code ${result.exitCode}`,
  })

const requireCliSuccess = Effect.fn("E2E.Harness.requireCliSuccess")(function* (
  operation: string,
  result: ExternalCommandResult,
) {
  if (result.exitCode !== 0) return yield* commandFailure(operation, result)
  return result
})

const responseFor = (agent: HarnessAgentType): unknown => {
  switch (agent) {
    case "claude":
      return {
        content: "deterministic Claude response",
        model: "claude-e2e-model",
        usage: { input_tokens: 17, output_tokens: 5 },
      }
    case "codex":
      return {
        content: "deterministic Codex response",
        model: "codex-e2e-model",
        usage: { input_tokens: 19, output_tokens: 7 },
      }
    case "gemini":
      return {
        content: "deterministic Gemini response",
        model: "gemini-e2e-model",
        usage: { candidatesTokenCount: 11, promptTokenCount: 23 },
      }
    case "opencode":
      return {
        content: "deterministic OpenCode response",
        model: "opencode-e2e-model",
        usage: { input_tokens: 29, output_tokens: 13 },
      }
  }
}

const vendorConfiguration = Effect.fn("E2E.Harness.vendorConfiguration")(function* (
  agent: HarnessAgentType,
  cli: PackedCli,
  home: string,
  mockUrl: string,
) {
  switch (agent) {
    case "claude":
      yield* cli.write(
        join(home, ".claude", "settings.json"),
        `${JSON.stringify(
          {
            env: {
              OTEL_METRIC_EXPORT_INTERVAL: "100",
            },
          },
          null,
          2,
        )}\n`,
      )
      return
    case "codex":
      yield* cli.write(
        join(home, ".codex", "config.toml"),
        [
          'model = "lumen-e2e-model"',
          'model_provider = "aimock"',
          'approval_policy = "never"',
          'sandbox_mode = "read-only"',
          "",
          "[model_providers.aimock]",
          'name = "aimock"',
          `base_url = ${JSON.stringify(`${mockUrl}/v1`)}`,
          'env_key = "OPENAI_API_KEY"',
          'wire_api = "responses"',
          "",
        ].join("\n"),
      )
      return
    case "gemini":
      yield* cli.write(
        join(home, ".gemini", "settings.json"),
        `${JSON.stringify(
          {
            general: {
              disableAutoUpdate: true,
            },
            security: {
              auth: {
                selectedType: "gemini-api-key",
              },
            },
          },
          null,
          2,
        )}\n`,
      )
      return
    case "opencode":
      yield* cli.write(
        join(home, ".config", "opencode", "opencode.json"),
        `${JSON.stringify(
          {
            provider: {
              openai: {
                models: {
                  "lumen-e2e-model": {
                    name: "Lumen E2E model",
                  },
                },
                options: {
                  apiKey: "sk-aimock-test",
                  baseURL: `${mockUrl}/v1`,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      )
      yield* linkPackedOpenCodePlugin(cli, home)
      yield* cli.write(join(home, ".npmrc"), "@lumen-build:registry=http://127.0.0.1:9\n")
      return
  }
})

const vendorEnvironment = (
  agent: HarnessAgentType,
  home: string,
  binDirectory: string,
  mockUrl: string,
  collectorUrl: string,
): Readonly<Record<string, string>> => {
  const common = isolatedEnvironment(home, {
    CI: "true",
    LUMEN_BEARER_TOKEN: "harness-e2e-destination-token",
    LUMEN_DEVICE_ID: "ae330c59-cf8e-4f89-901a-a948c4906a7d",
    NO_COLOR: "1",
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
  })
  switch (agent) {
    case "claude":
      return {
        ...common,
        ANTHROPIC_API_KEY: "sk-aimock-test",
        ANTHROPIC_BASE_URL: mockUrl,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        DISABLE_AUTOUPDATER: "1",
      }
    case "codex":
      return {
        ...common,
        CODEX_HOME: join(home, ".codex"),
        OPENAI_API_KEY: "sk-aimock-test",
      }
    case "gemini":
      return {
        ...common,
        GEMINI_API_KEY: "sk-aimock-test",
        GEMINI_CLI_HOME: home,
        GEMINI_CLI_NO_RELAUNCH: "true",
        GOOGLE_GEMINI_BASE_URL: mockUrl,
        OTEL_METRIC_EXPORT_INTERVAL: "100",
      }
    case "opencode":
      return {
        ...common,
        LUMEN_COLLECTOR_OTLP_ENDPOINT: collectorUrl,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      }
  }
}

const vendorArguments = (
  agent: HarnessAgentType,
  executable: string,
  home: string,
  canary: string,
): ReadonlyArray<string> => {
  switch (agent) {
    case "claude":
      return [
        executable,
        "--bare",
        "--settings",
        join(home, ".claude", "settings.json"),
        "--print",
        canary,
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--output-format",
        "json",
      ]
    case "codex":
      return [
        executable,
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        canary,
      ]
    case "gemini":
      return [
        executable,
        "--prompt",
        canary,
        "--skip-trust",
        "--approval-mode",
        "plan",
        "--output-format",
        "json",
      ]
    case "opencode":
      return [executable, "run", "--model", "openai/lumen-e2e-model", "--format", "json", canary]
  }
}

const selectedHarnesses = Effect.gen(function* () {
  const selected = process.env.LUMEN_HARNESS_AGENT
  if (selected === undefined || selected.length === 0) return HarnessAgent.literals
  return [yield* Schema.decodeUnknownEffect(HarnessAgent)(selected)]
})

const verifyConfiguration = Effect.fn("E2E.Harness.verifyConfiguration")(function* (
  agent: HarnessAgentType,
  cli: PackedCli,
  configPath: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const configured = yield* cli.run(
    configArguments(configPath, "harness", "configure", "--agent", agent),
    environment,
  )
  yield* requireCliSuccess(`configure ${agent} harness`, configured)
  expect(configured.events).toMatchObject([
    {
      command: "harness.configure",
      data: {
        harness: agent,
        state: "exact",
      },
      type: "result",
    },
  ])

  const status = yield* cli.run(
    configArguments(configPath, "harness", "status", "--agent", agent),
    environment,
  )
  yield* requireCliSuccess(`inspect ${agent} harness`, status)
  expect(status.events).toMatchObject([
    {
      command: "harness.status",
      data: {
        harness: agent,
        state: "exact",
      },
      type: "result",
    },
  ])
})

const verifyDailyImport = Effect.fn("E2E.Harness.verifyDailyImport")(function* (
  agent: HarnessAgentType,
  cli: PackedCli,
  configPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  destination: MockDestination,
) {
  const day = new Date().toISOString().slice(0, 10)
  const result = yield* cli.run(
    configArguments(configPath, "sync", "daily", "--agent", agent, "--since", day, "--until", day),
    environment,
  )
  yield* requireCliSuccess(`import ${agent} daily usage`, result)
  expect(result.events).toMatchObject([
    {
      command: "sync.daily",
      data: {
        agent,
      },
      type: "result",
    },
  ])
  const event = result.events[0]
  if (event === undefined || !("data" in event) || event.data?.snapshots === 0) {
    return yield* new HarnessE2eError({
      operation: `import ${agent} daily usage`,
      reason: "the real harness session produced no ccusage daily snapshots",
    })
  }
  const batches = yield* destination.dailyBatches
  expect(batches.at(-1)?.snapshots.length).toBeGreaterThan(0)
  expect(batches.at(-1)?.snapshots.every((snapshot) => snapshot.agent === agent)).toBe(true)
})

const verifyHarness = Effect.fn("E2E.Harness.verify")(function* (
  agent: HarnessAgentType,
  cli: PackedCli,
  dependencies: HarnessDependencies,
) {
  const destination = yield* mockDestination
  const home = yield* cli.makeHome(`harness-${agent}`)
  const port = yield* loopbackPort
  const collectorUrl = `http://127.0.0.1:${port}`
  const configPath = join(home, "lumen-sync.toml")
  const canary = canaryFor(agent)
  const mock = yield* aimock(dependencies, canary, responseFor(agent))
  const environment = vendorEnvironment(
    agent,
    home,
    dependencies.binDirectory,
    mock.url,
    collectorUrl,
  )

  yield* cli.write(configPath, configText(collectorUrl, destination.url))
  yield* vendorConfiguration(agent, cli, home, mock.url)
  yield* verifyConfiguration(agent, cli, configPath, environment)
  if (agent === "gemini") {
    expect(
      (yield* readJsonFile<{
        readonly security?: { readonly auth?: { readonly selectedType?: string } }
      }>(join(home, ".gemini", "settings.json"))).security?.auth?.selectedType,
    ).toBe("gemini-api-key")
  }

  const version = yield* runExternal([dependencies.executable[agent], "--version"], {
    cwd: cli.consumer,
    environment,
  })
  if (version.exitCode !== 0) return yield* commandFailure(`read ${agent} version`, version)
  expect(`${version.stdout}\n${version.stderr}`).toContain(versions[agent])

  const collector = yield* Effect.acquireRelease(
    startCollector(cli, configPath, environment),
    ({ stop }) => stop.pipe(Effect.ignore),
  )
  const listening = readyUrl(yield* nextCollectorEvent(collector, "ready"))
  expect(new URL(listening).origin).toBe(collectorUrl)

  const invocation = yield* runExternal(
    vendorArguments(agent, dependencies.executable[agent], home, canary),
    {
      cwd: cli.consumer,
      environment,
    },
  )
  if (invocation.exitCode !== 0) {
    return yield* commandFailure(`invoke real ${agent} CLI`, invocation)
  }

  const requests = yield* mock.requests
  const successfulFixtureRequests = requests.filter(
    (request) => request.response.status === 200 && JSON.stringify(request.body).includes(canary),
  )
  expect(successfulFixtureRequests.length).toBeGreaterThan(0)

  if (nativeLiveProof[agent] !== "none") {
    const live = yield* destination.takeLive
    expect(live.snapshots.length).toBeGreaterThan(0)
    expect(live.snapshots.every((snapshot) => snapshot.agent === agent)).toBe(true)
    if (nativeLiveProof[agent] === "tokens") {
      expect(
        live.snapshots.some(
          (snapshot) =>
            snapshot.tokens.input > 0 ||
            snapshot.tokens.output > 0 ||
            snapshot.tokens.cacheCreationInput > 0 ||
            snapshot.tokens.cacheReadInput > 0 ||
            snapshot.tokens.reasoningOutput > 0,
        ),
      ).toBe(true)
    }
  }

  yield* verifyDailyImport(agent, cli, configPath, environment, destination)

  const destinationRequests = yield* destination.requests
  expect(JSON.stringify(destinationRequests)).not.toContain(canary)
})

it(
  "runs the packed CLI through the pinned real agent harness matrix",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dependencies = yield* harnessDependencies
          const nodeVersion = yield* runExternal([dependencies.node, "--version"], {
            cwd: dependencies.root,
            environment: process.env,
          })
          expect(nodeVersion.exitCode).toBe(0)
          expect(nodeVersion.stdout.trim()).toBe("v22.23.1")

          const cli = yield* packedCli
          for (const agent of yield* selectedHarnesses) {
            yield* Effect.scoped(verifyHarness(agent, cli, dependencies))
          }
        }),
      ),
    )
  },
  10 * 60_000,
)
