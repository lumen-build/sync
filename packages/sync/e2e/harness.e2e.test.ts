import { join } from "node:path"

import { requiredHarnessEnvironment } from "@lumen-build/sync-harness"
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
  readTextFile,
  runExternal,
} from "./support/harness-runtime.js"
import {
  type AimockCompletionRequest,
  countOccurrences,
  measureHarnessInteraction,
} from "./support/harness-interaction.js"
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

interface ExpectedUsage {
  readonly input: number
  readonly output: number
}

interface HarnessFixtureExpectation {
  readonly models: ReadonlyArray<string>
  readonly nativeLiveProof: "file" | "none" | "tokens"
  readonly providerUsage: ReadonlyArray<ExpectedUsage>
  readonly requestPath: RegExp
  readonly requestShapes: ReadonlyArray<{
    readonly inputTokenUnits: number
    readonly messageRoles: ReadonlyArray<string>
    readonly overheadTokenUnits: number
    readonly systemMessages: number
    readonly systemTokenUnits: number
    readonly toolDefinitions: number
  }>
  readonly responseContent: string
  readonly version: string
}

const expectations = {
  claude: {
    models: ["claude-opus-5", "claude-opus-5"],
    nativeLiveProof: "tokens",
    providerUsage: [
      { input: 391, output: 3 },
      { input: 141, output: 3 },
    ],
    requestPath: /^\/v1\/messages(?:\?.*)?$/u,
    requestShapes: [
      {
        inputTokenUnits: 391,
        messageRoles: ["system", "user"],
        overheadTokenUnits: 390,
        systemMessages: 1,
        systemTokenUnits: 349,
        toolDefinitions: 0,
      },
      {
        inputTokenUnits: 141,
        messageRoles: ["system", "user"],
        overheadTokenUnits: 140,
        systemMessages: 1,
        systemTokenUnits: 70,
        toolDefinitions: 0,
      },
    ],
    responseContent: "deterministic Claude response",
    version: "2.1.220",
  },
  codex: {
    models: ["lumen-e2e-model"],
    nativeLiveProof: "tokens",
    providerUsage: [{ input: 6540, output: 3 }],
    requestPath: /^\/v1\/responses$/u,
    requestShapes: [
      {
        inputTokenUnits: 6540,
        messageRoles: ["system", "system", "user", "user"],
        overheadTokenUnits: 6539,
        systemMessages: 2,
        systemTokenUnits: 5260,
        toolDefinitions: 8,
      },
    ],
    responseContent: "deterministic Codex response",
    version: "0.146.0",
  },
  copilot: {
    models: ["lumen-e2e-model"],
    nativeLiveProof: "file",
    providerUsage: [{ input: 12479, output: 3 }],
    requestPath: /^\/v1\/responses$/u,
    requestShapes: [
      {
        inputTokenUnits: 12479,
        messageRoles: ["system", "user"],
        overheadTokenUnits: 12478,
        systemMessages: 1,
        systemTokenUnits: 6804,
        toolDefinitions: 16,
      },
    ],
    responseContent: "deterministic Copilot response",
    version: "1.0.75",
  },
  gemini: {
    models: ["gemini-3.1-pro-preview-customtools"],
    nativeLiveProof: "none",
    providerUsage: [{ input: 7522, output: 3 }],
    requestPath: /^\/v1beta\/models\/[^/?]+:(?:generateContent|streamGenerateContent)(?:\?.*)?$/u,
    requestShapes: [
      {
        inputTokenUnits: 7522,
        messageRoles: ["system", "user"],
        overheadTokenUnits: 7521,
        systemMessages: 1,
        systemTokenUnits: 6502,
        toolDefinitions: 10,
      },
    ],
    responseContent: "deterministic Gemini response",
    version: "0.53.0",
  },
  opencode: {
    models: ["gpt-5.4-nano", "lumen-e2e-model"],
    nativeLiveProof: "tokens",
    providerUsage: [
      { input: 493, output: 3 },
      { input: 5782, output: 3 },
    ],
    requestPath: /^\/v1\/responses$/u,
    requestShapes: [
      {
        inputTokenUnits: 493,
        messageRoles: ["system", "user", "user"],
        overheadTokenUnits: 492,
        systemMessages: 1,
        systemTokenUnits: 485,
        toolDefinitions: 0,
      },
      {
        inputTokenUnits: 5782,
        messageRoles: ["system", "user"],
        overheadTokenUnits: 5781,
        systemMessages: 1,
        systemTokenUnits: 2027,
        toolDefinitions: 10,
      },
    ],
    responseContent: "deterministic OpenCode response",
    version: "1.18.9",
  },
} as const satisfies Readonly<Record<HarnessAgentType, HarnessFixtureExpectation>>

const interactionFor = (
  request: AimockCompletionRequest,
  agent: HarnessAgentType,
  canary: string,
) => measureHarnessInteraction(request, canary, expectations[agent].responseContent)

const CopilotTokenMetric = Schema.Struct({
  dataPoints: Schema.Array(
    Schema.Struct({
      attributes: Schema.Struct({
        "gen_ai.token.type": Schema.Literals(["input", "output"]),
      }),
      value: Schema.Struct({ sum: Schema.Number }),
    }),
  ),
  name: Schema.Literal("gen_ai.client.token.usage"),
  type: Schema.Literal("metric"),
})

const canonicalUsage = (usage: ReadonlyArray<ExpectedUsage>): ReadonlyArray<ExpectedUsage> =>
  usage.toSorted((left, right) => left.input - right.input || left.output - right.output)

const snapshotUsage = (
  snapshots: ReadonlyArray<{
    readonly tokens: { readonly input: number; readonly output: number }
  }>,
): ReadonlyArray<ExpectedUsage> =>
  canonicalUsage(
    snapshots.map((snapshot) => ({
      input: snapshot.tokens.input,
      output: snapshot.tokens.output,
    })),
  )

const responseFor = (
  agent: HarnessAgentType,
  tokens: ExpectedUsage,
): {
  readonly content: string
  readonly model: string
  readonly usage: Readonly<Record<string, number>>
} => {
  const response = {
    content: expectations[agent].responseContent,
    model: `${agent}-e2e-model`,
  }
  switch (agent) {
    case "claude":
    case "codex":
    case "copilot":
    case "opencode":
      return {
        ...response,
        usage: { input_tokens: tokens.input, output_tokens: tokens.output },
      }
    case "gemini":
      return {
        ...response,
        usage: { candidatesTokenCount: tokens.output, promptTokenCount: tokens.input },
      }
  }
}

const responseFactory = (
  agent: HarnessAgentType,
): ((request: AimockCompletionRequest) => unknown) => {
  let requestIndex = 0
  return () => {
    const usage = expectations[agent].providerUsage[requestIndex]
    requestIndex += 1
    if (usage === undefined) {
      throw new Error(`received an unexpected ${agent} model request`)
    }
    return responseFor(agent, usage)
  }
}

const expectedUsageFor = (agent: HarnessAgentType, requestIndex: number): ExpectedUsage => {
  const usage = expectations[agent].providerUsage[requestIndex]
  if (usage === undefined) throw new Error(`missing ${agent} provider usage fixture`)
  return usage
}

const requestProofFor = (
  request: AimockCompletionRequest,
  agent: HarnessAgentType,
  canary: string,
) => interactionFor(request, agent, canary).proof

const isCopilotTokenMetric = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "metric" &&
  "name" in value &&
  value.name === "gen_ai.client.token.usage"

const copilotFileUsage = Effect.fn("E2E.Harness.copilotFileUsage")(function* (contents: string) {
  const records = yield* Effect.forEach(
    contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    (line) =>
      Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: (cause) =>
          new HarnessE2eError({
            operation: "decode Copilot file telemetry",
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
  )
  const metrics = yield* Effect.forEach(records.filter(isCopilotTokenMetric), (record) =>
    Schema.decodeUnknownEffect(CopilotTokenMetric)(record).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessE2eError({
            operation: "decode Copilot token telemetry",
            reason: cause.message,
          }),
      ),
    ),
  )
  expect(metrics.length).toBeGreaterThan(0)
  return metrics.map((metric) => {
    expect(
      metric.dataPoints.map((point) => point.attributes["gen_ai.token.type"]).toSorted(),
    ).toEqual(["input", "output"])
    const usage = Object.fromEntries(
      metric.dataPoints.map((point) => [point.attributes["gen_ai.token.type"], point.value.sum]),
    )
    return { input: usage.input ?? 0, output: usage.output ?? 0 }
  })
})

const expectedRequest = (
  agent: HarnessAgentType,
  request: {
    readonly method: string
    readonly path: string
    readonly response: { readonly status: number }
  },
): void => {
  expect(request.method).toBe("POST")
  expect(request.path).toMatch(expectations[agent].requestPath)
  expect(request.response.status).toBe(200)
}

const exactFixtureRequest = (
  agent: HarnessAgentType,
  canary: string,
  expectedCount: number,
  requests: ReadonlyArray<{
    readonly body: unknown
    readonly method: string
    readonly path: string
    readonly response: { readonly status: number }
  }>,
) => {
  const matched = requests
    .map((request) => ({
      canaryOccurrences: countOccurrences(JSON.stringify(request.body), canary),
      request,
    }))
    .filter(({ canaryOccurrences, request }) => {
      return request.response.status === 200 && canaryOccurrences > 0
    })
  expect(matched).toHaveLength(expectedCount)
  for (const { canaryOccurrences, request } of matched) {
    expectedRequest(agent, request)
    expect(canaryOccurrences).toBe(1)
  }
}

const exactCompletion = (
  agent: HarnessAgentType,
  canary: string,
  completions: ReadonlyArray<AimockCompletionRequest>,
) => {
  const proofs = completions.map((request) => ({
    model: request.model,
    proof: requestProofFor(request, agent, canary),
  }))
  if (process.env.LUMEN_HARNESS_DEBUG === "1") {
    process.stderr.write(`${JSON.stringify({ agent, completions: proofs }, null, 2)}\n`)
  }
  expect(completions.map((request) => request.model)).toEqual([...expectations[agent].models])
  expect(
    proofs.map(({ proof }) => ({
      inputTokenUnits: proof.inputTokenUnits,
      messageRoles: proof.messageRoles,
      overheadTokenUnits: proof.overheadTokenUnits,
      systemMessages: proof.systemMessages,
      systemTokenUnits: proof.systemTokenUnits,
      toolDefinitions: proof.toolDefinitions,
    })),
  ).toEqual(
    expectations[agent].requestShapes.map((shape) => ({
      inputTokenUnits: shape.inputTokenUnits,
      messageRoles: [...shape.messageRoles],
      overheadTokenUnits: shape.overheadTokenUnits,
      systemMessages: shape.systemMessages,
      systemTokenUnits: shape.systemTokenUnits,
      toolDefinitions: shape.toolDefinitions,
    })),
  )
  for (const { proof } of proofs) {
    expect(proof.canaryOccurrences).toBe(1)
    expect(proof.inputCharacters).toBeGreaterThanOrEqual(canary.length)
    expect(proof.inputTokenUnits).toBeGreaterThan(0)
    expect(proof.overheadCharacters).toBeGreaterThan(0)
    expect(proof.overheadTokenUnits).toBeGreaterThan(0)
  }
  return completions
}

const usageBearingCompletions = (
  agent: HarnessAgentType,
  completions: ReadonlyArray<AimockCompletionRequest>,
): ReadonlyArray<AimockCompletionRequest> => {
  if (agent !== "opencode") return completions
  const usageBearing = completions.filter((request) => request.model === "lumen-e2e-model")
  expect(usageBearing).toHaveLength(1)
  return usageBearing
}

const nativeLiveUsageFor = (
  agent: HarnessAgentType,
  usage: ReadonlyArray<ExpectedUsage>,
): ReadonlyArray<ExpectedUsage> => {
  if (agent !== "claude") return usage
  return [
    {
      input: usage.reduce((total, item) => total + item.input, 0),
      output: usage.reduce((total, item) => total + item.output, 0),
    },
  ]
}

const dailyUsageFor = (
  agent: HarnessAgentType,
  usage: ReadonlyArray<ExpectedUsage>,
): ReadonlyArray<ExpectedUsage> => {
  if (agent !== "claude") return usage
  const last = usage.at(-1)
  return last === undefined ? [] : [last]
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
    case "copilot":
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
  const requiredEnvironment = requiredHarnessEnvironment(agent, {
    collectorUrl,
    copilotTelemetryPath: join(home, ".copilot", "otel", "lumen-sync.jsonl"),
  })
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
    case "copilot":
      return {
        ...common,
        COPILOT_HOME: join(home, ".copilot"),
        COPILOT_PROVIDER_API_KEY: "sk-aimock-test",
        COPILOT_PROVIDER_BASE_URL: `${mockUrl}/v1`,
        COPILOT_PROVIDER_MODEL_ID: "gpt-5.4",
        COPILOT_PROVIDER_TYPE: "openai",
        COPILOT_PROVIDER_WIRE_API: "responses",
        COPILOT_PROVIDER_WIRE_MODEL: "lumen-e2e-model",
        ...requiredEnvironment,
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
        ...requiredEnvironment,
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
    case "copilot":
      return [
        executable,
        "--allow-all-tools",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--no-remote",
        "--no-remote-export",
        "--silent",
        "--stream",
        "off",
        "--prompt",
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
  expectedUsage: ReadonlyArray<ExpectedUsage>,
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
  const batch = batches.at(-1)
  expect(batch?.snapshots.length).toBeGreaterThan(0)
  expect(batch?.snapshots.every((snapshot) => snapshot.agent === agent)).toBe(true)
  if (process.env.LUMEN_HARNESS_DEBUG === "1") {
    process.stderr.write(
      `${JSON.stringify(
        {
          agent,
          dailyExpectedUsage: expectedUsage,
          dailyUsage: batch?.snapshots.map((snapshot) => snapshot.tokens),
        },
        null,
        2,
      )}\n`,
    )
  }
  expect(snapshotUsage(batch?.snapshots ?? [])).toEqual(canonicalUsage(expectedUsage))
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
  const mock = yield* aimock(dependencies, canary, responseFactory(agent))
  const environment = vendorEnvironment(
    agent,
    home,
    dependencies.binDirectory,
    mock.url,
    collectorUrl,
  )
  const copilotOtelFile = join(home, ".copilot", "otel", "lumen-sync.jsonl")

  yield* cli.write(configPath, configText(collectorUrl, destination.url))
  if (agent === "copilot") yield* cli.write(copilotOtelFile, "")
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
  expect(`${version.stdout}\n${version.stderr}`).toContain(expectations[agent].version)

  const collector = yield* Effect.acquireRelease(
    startCollector(cli, configPath, environment),
    ({ stop }) => stop.pipe(Effect.ignore),
  )
  const listening = readyUrl(yield* nextCollectorEvent(collector, "ready"))
  expect(new URL(listening).origin).toBe(collectorUrl)

  const liveInvocation = yield* runExternal(
    vendorArguments(agent, dependencies.executable[agent], home, canary),
    {
      cwd: cli.consumer,
      environment,
    },
  )
  if (liveInvocation.exitCode !== 0) {
    return yield* commandFailure(`invoke real ${agent} CLI`, liveInvocation)
  }
  expect(liveInvocation.stdout).toContain(expectations[agent].responseContent)

  const liveRequests = exactCompletion(agent, canary, yield* mock.completions)
  const liveUsage = usageBearingCompletions(agent, liveRequests).map((request) =>
    expectedUsageFor(agent, liveRequests.indexOf(request)),
  )
  const expectedLiveUsage = nativeLiveUsageFor(agent, liveUsage)

  if (expectations[agent].nativeLiveProof === "file") {
    const telemetry = yield* readTextFile(copilotOtelFile)
    expect(telemetry).not.toContain(canary)
    const fileUsage = yield* copilotFileUsage(telemetry)
    expect(fileUsage.every((usage) => usage.input === liveUsage[0]?.input)).toBe(true)
    expect(fileUsage.every((usage) => usage.output === liveUsage[0]?.output)).toBe(true)
  } else if (expectations[agent].nativeLiveProof !== "none") {
    yield* destination.takeLive
    const liveSnapshots = (yield* destination.liveBatches).flatMap((batch) => batch.snapshots)
    expect(liveSnapshots.length).toBeGreaterThan(0)
    expect(liveSnapshots.every((snapshot) => snapshot.agent === agent)).toBe(true)
    if (expectations[agent].nativeLiveProof === "tokens") {
      if (process.env.LUMEN_HARNESS_DEBUG === "1") {
        process.stderr.write(
          `${JSON.stringify(
            {
              agent,
              expectedUsage: expectedLiveUsage,
              liveUsage: liveSnapshots.map((snapshot) => snapshot.tokens),
            },
            null,
            2,
          )}\n`,
        )
      }
      expect(snapshotUsage(liveSnapshots)).toEqual(canonicalUsage(expectedLiveUsage))
    }
  }

  const expectedDailyUsage = dailyUsageFor(agent, liveUsage)
  exactFixtureRequest(agent, canary, liveRequests.length, yield* mock.requests)

  yield* verifyDailyImport(agent, cli, configPath, environment, destination, expectedDailyUsage)

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
