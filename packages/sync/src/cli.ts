#!/usr/bin/env bun

/* oxlint-disable no-underscore-dangle -- Effect tagged errors expose _tag. */

import { createRequire } from "node:module"
import { homedir } from "node:os"
import { resolve } from "node:path"

import {
  AssertionProvider,
  CredentialProvider,
  MissingCredential,
  SecretStore,
  bearerCredentialLayer,
  environmentAssertionLayer,
  fileSecretStoreLayer,
  liveOidcClientLayer,
  localAuthorizationCodeReceiverLayer,
  oidcCredentialLayer,
} from "@lumen-build/sync-auth"
import {
  CcusageAgent,
  commandLayer as ccusageCommandLayer,
  importerLayer,
} from "@lumen-build/sync-ccusage"
import { collectorLayer } from "@lumen-build/sync-collector"
import { bunCollectorServerLayer } from "@lumen-build/sync-collector/bun"
import {
  InvalidConfiguration,
  Service as ConfigurationService,
  initialize as initializeConfiguration,
  layer as configurationLayer,
  requireAuth,
  requireCollector,
  requireDestination,
  resolveRuntimePaths,
  type AuthConfiguration,
  type Configuration,
  type RuntimeHost,
  type RuntimePaths,
} from "@lumen-build/sync-config"
import { DeviceId } from "@lumen-build/sync-contracts"
import { layer as destinationLayer } from "@lumen-build/sync-destination"
import {
  Harness,
  configureHarness,
  harnessRegistry,
  harnesses,
  inspectHarness,
  makeHarnessPaths,
  removeHarness,
} from "@lumen-build/sync-harness"
import { bunHarnessFileSystemLayer } from "@lumen-build/sync-harness/bun"
import {
  inspectService,
  installService,
  liveServiceCommandRunnerLayer,
  makeServiceDefinition,
  uninstallService,
} from "@lumen-build/sync-service"
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Clock, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { CliOutput, layer as cliOutputLayer } from "./cli-output"
import { DeviceIdentity } from "./device-identity"
import { bunSyncPlatformLayer } from "./platform-bun"
import {
  DailySyncIdJournalFactory,
  parseCollectorAddress,
  runCollector,
  runLocalCollector,
  syncDaily,
  type RuntimeReporter,
} from "./runtime"

const VERSION = "0.1.0"
const environment = process.env as Readonly<Record<string, string | undefined>>
const platform: RuntimeHost["platform"] =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"

const root = Command.make("lumen-sync").pipe(
  Command.withSharedFlags({
    config: Flag.string("config").pipe(
      Flag.optional,
      Flag.withDescription("Path to a TOML configuration file"),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Write versioned newline-delimited JSON events"),
    ),
  }),
  Command.withDescription("Collect and synchronize usage from AI coding agents"),
)

const runtimeHost = (): RuntimeHost => ({
  ...(environment.APPDATA === undefined ? {} : { appData: environment.APPDATA }),
  ...(environment.XDG_CONFIG_HOME === undefined ? {} : { configHome: environment.XDG_CONFIG_HOME }),
  ...(environment.XDG_DATA_HOME === undefined ? {} : { dataHome: environment.XDG_DATA_HOME }),
  homeDirectory: homedir(),
  ...(environment.LOCALAPPDATA === undefined ? {} : { localAppData: environment.LOCALAPPDATA }),
  platform,
  ...(environment.XDG_STATE_HOME === undefined ? {} : { stateHome: environment.XDG_STATE_HOME }),
})

const hostPaths = () => ({
  ...(environment.APPDATA === undefined ? {} : { appData: environment.APPDATA }),
  ...(environment.XDG_CONFIG_HOME === undefined ? {} : { configHome: environment.XDG_CONFIG_HOME }),
  ...(environment.COPILOT_HOME === undefined ? {} : { copilotHome: environment.COPILOT_HOME }),
  home: homedir(),
  platform,
  ...(process.getuid === undefined ? {} : { userId: process.getuid() }),
})

const selectedRuntimePaths = Effect.fn("Cli.selectedRuntimePaths")(function* () {
  const parent = yield* root
  const flag = Option.getOrUndefined(parent.config)
  const environmentPath = environment.LUMEN_CONFIG
  return resolveRuntimePaths({
    configPath:
      flag ??
      (environmentPath === undefined || environmentPath.length === 0 ? undefined : environmentPath),
    host: runtimeHost(),
  })
})

const configurationService = Effect.fn("Cli.configuration")(function* () {
  const paths = yield* selectedRuntimePaths()
  return yield* ConfigurationService.pipe(
    Effect.provide(
      configurationLayer({
        host: runtimeHost(),
        paths,
      }),
    ),
  )
})

const output = (
  command: string,
  type: "progress" | "ready" | "result" | "shutdown" | "warning",
  data: Readonly<Record<string, unknown>>,
  plain: string,
) =>
  CliOutput.pipe(
    Effect.flatMap((writer) =>
      writer.emit({
        command,
        data,
        plain,
        type,
      }),
    ),
  )

const credentialLayer = (
  config: Configuration,
  paths: RuntimePaths,
): Effect.Effect<
  Layer.Layer<CredentialProvider>,
  import("@lumen-build/sync-config").MissingConfiguration
> =>
  Effect.gen(function* () {
    const auth = yield* requireAuth(config)
    if (auth.mode === "bearer") {
      const token = environment.LUMEN_BEARER_TOKEN
      return bearerCredentialLayer({
        token:
          token === undefined || token.length === 0
            ? Effect.fail(new MissingCredential({ source: "LUMEN_BEARER_TOKEN" }))
            : Effect.succeed(Redacted.make(token)),
      })
    }

    const receiver = localAuthorizationCodeReceiverLayer({ platform })
    const assertions = environmentAssertionLayer(environment)
    const secrets = fileSecretStoreLayer(paths.credentialsFile)
    const oidc = liveOidcClientLayer.pipe(Layer.provide(receiver))
    return oidcCredentialLayer({
      config: auth.oidc,
      credentialKeyPrefix: "lumen.sync",
    }).pipe(
      Layer.provide(
        Layer.mergeAll(assertions, secrets, oidc) as Layer.Layer<
          AssertionProvider | SecretStore | import("@lumen-build/sync-auth").OidcClient
        >,
      ),
    )
  })

const configuredDestinationLayer = Effect.fn("Cli.destinationLayer")(function* (
  config: Configuration,
  paths: RuntimePaths,
) {
  const destination = yield* requireDestination(config)
  const credentials = yield* credentialLayer(config, paths)
  return destinationLayer({ baseUrl: destination.baseUrl }).pipe(
    Layer.provide(Layer.merge(BunHttpClient.layer, credentials)),
  )
})

const loadDeviceId = Effect.fn("Cli.loadDeviceId")(function* (paths: RuntimePaths) {
  const explicit = environment.LUMEN_DEVICE_ID
  if (explicit !== undefined) return yield* Schema.decodeUnknownEffect(DeviceId)(explicit)
  const identity = yield* DeviceIdentity
  return yield* identity.loadOrCreate(paths.deviceIdFile)
})

const configPathCommand = Command.make("path", {}, () =>
  Effect.gen(function* () {
    const paths = yield* selectedRuntimePaths()
    yield* output("config.path", "result", { path: paths.configFile }, paths.configFile)
  }),
).pipe(Command.withDescription("Print the selected configuration path"))

const configShowCommand = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const service = yield* configurationService()
    yield* output(
      "config.show",
      "result",
      {
        configuration: service.configuration,
        paths: service.paths,
      },
      `Valid configuration: ${service.paths.configFile}`,
    )
  }),
).pipe(Command.withDescription("Validate and print non-secret configuration"))

const authChoices = ["bearer", "oidc"] as const
const validationChoices = ["jwks", "introspection"] as const

const configInitCommand = Command.make(
  "init",
  {
    auth: Flag.choice("auth", authChoices).pipe(
      Flag.optional,
      Flag.withDescription("Destination authentication mode"),
    ),
    collector: Flag.string("collector").pipe(
      Flag.withDescription("Explicit loopback OTLP listener URL"),
    ),
    destination: Flag.string("destination").pipe(
      Flag.optional,
      Flag.withDescription("Explicit receiver base URL"),
    ),
    force: Flag.boolean("force").pipe(Flag.withDescription("Replace an existing configuration")),
    oidcAudience: Flag.string("oidc-audience").pipe(Flag.optional),
    oidcClientId: Flag.string("oidc-client-id").pipe(Flag.optional),
    oidcIssuer: Flag.string("oidc-issuer").pipe(Flag.optional),
    oidcRedirectUri: Flag.string("oidc-redirect-uri").pipe(Flag.optional),
    oidcScope: Flag.string("oidc-scope").pipe(Flag.between(0, 32)),
    oidcValidation: Flag.choice("oidc-validation", validationChoices).pipe(
      Flag.withDefault("jwks"),
    ),
  },
  ({
    auth,
    collector,
    destination,
    force,
    oidcAudience,
    oidcClientId,
    oidcIssuer,
    oidcRedirectUri,
    oidcScope,
    oidcValidation,
  }) =>
    Effect.gen(function* () {
      const paths = yield* selectedRuntimePaths()
      const authMode = Option.getOrUndefined(auth)
      let authConfiguration: AuthConfiguration | undefined
      if (authMode === "bearer") {
        authConfiguration = { mode: "bearer" }
      } else if (authMode === "oidc") {
        const issuer = Option.getOrUndefined(oidcIssuer)
        const clientId = Option.getOrUndefined(oidcClientId)
        const redirectUri = Option.getOrUndefined(oidcRedirectUri)
        if (
          issuer === undefined ||
          clientId === undefined ||
          redirectUri === undefined ||
          oidcScope.length === 0
        ) {
          return yield* new InvalidConfiguration({
            reason:
              "OIDC init requires --oidc-issuer, --oidc-client-id, --oidc-redirect-uri, and at least one --oidc-scope",
          })
        }
        const audience = Option.getOrUndefined(oidcAudience)
        authConfiguration = {
          mode: "oidc",
          oidc: {
            ...(audience === undefined ? {} : { audience }),
            clientId,
            issuer,
            redirectUri,
            scopes: [...new Set(oidcScope)],
            validation: oidcValidation,
          },
        }
      }
      const initialized = yield* initializeConfiguration({
        ...(authConfiguration === undefined ? {} : { auth: authConfiguration }),
        collectorListenUrl: collector,
        ...(Option.isNone(destination)
          ? {}
          : { destinationBaseUrl: Option.getOrThrow(destination) }),
        force,
        path: paths.configFile,
      })
      yield* output(
        "config.init",
        "result",
        {
          configuration: initialized.configuration,
          path: initialized.path,
        },
        `Created ${initialized.path}`,
      )
    }),
).pipe(Command.withDescription("Create a private TOML configuration"))

const configCommand = Command.make("config").pipe(
  Command.withDescription("Initialize and inspect configuration"),
  Command.withSubcommands([configInitCommand, configPathCommand, configShowCommand]),
)

const harnessChoice = Harness.literals
const harnessSelectionFlag = Flag.choice("agent", harnessChoice).pipe(
  Flag.between(0, harnessChoice.length),
  Flag.withDescription("Agent harness; repeat to select multiple"),
)
const selectedHarnesses = (values: ReadonlyArray<Harness>): ReadonlyArray<Harness> =>
  values.length === 0 ? harnessChoice : [...new Set(values)]

const configuredHarnessPaths = (runtimePaths: RuntimePaths) => ({
  ...makeHarnessPaths(hostPaths()),
  ownership: runtimePaths.harnessOwnershipFile,
})

const harnessListCommand = Command.make("list", {}, () =>
  output(
    "harness.list",
    "result",
    { harnesses },
    harnesses
      .map(
        ({ displayName, id, integration, signals }) =>
          `${id}: ${displayName} (${integration}; ${signals.join(",")})`,
      )
      .join("\n"),
  ),
).pipe(Command.withDescription("List supported agent harnesses"))

const harnessConfigureCommand = Command.make(
  "configure",
  {
    agent: harnessSelectionFlag,
    force: Flag.boolean("force").pipe(Flag.withDescription("Replace conflicting managed fields")),
  },
  ({ agent, force }) =>
    Effect.gen(function* () {
      const service = yield* configurationService()
      const collector = yield* requireCollector(service.configuration)
      const paths = configuredHarnessPaths(service.paths)
      for (const harness of selectedHarnesses(agent)) {
        const result = yield* configureHarness({
          collectorUrl: collector.listenUrl,
          force,
          harness,
          paths,
        })
        const status = yield* inspectHarness({
          collectorUrl: collector.listenUrl,
          harness,
          paths,
        })
        yield* output(
          "harness.configure",
          "result",
          {
            changed: result.changes.map((change) => change.path.join(".")),
            harness,
            path: paths.configurations[harness],
            previousState: result.state,
            state: status.state,
          },
          `${harness}: ${status.state}`,
        )
      }
    }),
).pipe(Command.withDescription("Configure privacy-safe telemetry export"))

const harnessStatusCommand = Command.make("status", { agent: harnessSelectionFlag }, ({ agent }) =>
  Effect.gen(function* () {
    const service = yield* configurationService()
    const collector = yield* requireCollector(service.configuration)
    const paths = configuredHarnessPaths(service.paths)
    for (const harness of selectedHarnesses(agent)) {
      const status = yield* inspectHarness({
        collectorUrl: collector.listenUrl,
        harness,
        paths,
      })
      yield* output(
        "harness.status",
        "result",
        { ...status, descriptor: harnessRegistry[harness] },
        `${harness}: ${status.state}${status.managed ? " (managed)" : ""}`,
      )
    }
  }),
).pipe(Command.withDescription("Inspect telemetry configuration without changing it"))

const harnessRemoveCommand = Command.make("remove", { agent: harnessSelectionFlag }, ({ agent }) =>
  Effect.gen(function* () {
    const paths = configuredHarnessPaths(yield* selectedRuntimePaths())
    for (const harness of selectedHarnesses(agent)) {
      const result = yield* removeHarness({ harness, paths })
      yield* output(
        "harness.remove",
        "result",
        {
          harness,
          preserved: result.preserved,
          restored: result.restored,
        },
        `${harness}: restored ${result.restored.length}, preserved ${result.preserved.length}`,
      )
    }
  }),
).pipe(Command.withDescription("Restore fields previously managed by Lumen Sync"))

const harnessCommand = Command.make("harness").pipe(
  Command.withDescription("Manage agent telemetry harnesses"),
  Command.withSubcommands([
    harnessConfigureCommand,
    harnessListCommand,
    harnessRemoveCommand,
    harnessStatusCommand,
  ]),
)

const utcNow = Clock.currentTimeMillis.pipe(
  Effect.map((milliseconds) => new Date(milliseconds).toISOString()),
)

const syncDailyCommand = Command.make(
  "daily",
  {
    agent: Flag.choice("agent", CcusageAgent.literals).pipe(
      Flag.between(0, CcusageAgent.literals.length),
      Flag.withDescription("ccusage source; repeat to select multiple"),
    ),
    since: Flag.string("since").pipe(Flag.optional),
    until: Flag.string("until").pipe(Flag.optional),
  },
  ({ agent, since, until }) =>
    Effect.gen(function* () {
      const service = yield* configurationService()
      const paths = service.paths
      const deviceId = yield* loadDeviceId(paths)
      const destination = yield* configuredDestinationLayer(service.configuration, paths)
      const ccusagePath = createRequire(import.meta.url).resolve("ccusage/src/cli.js")
      const selectedAgents = agent.length === 0 ? [...CcusageAgent.literals] : [...new Set(agent)]
      const capturedAt = yield* utcNow
      const day = capturedAt.slice(0, 10)
      const journals = yield* DailySyncIdJournalFactory
      const results = yield* syncDaily({
        agents: selectedAgents,
        capturedAt,
        deviceId,
        since: Option.getOrElse(since, () => day),
        syncIds: journals.make(paths.dailySyncDirectory),
        until: Option.getOrElse(until, () => day),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ccusageCommandLayer({
              executable: process.execPath,
              prefixArguments: [ccusagePath],
            }),
            importerLayer,
            destination,
          ),
        ),
      )
      for (const result of results) {
        yield* output(
          "sync.daily",
          "result",
          result,
          `${result.agent}: committed ${result.committed} snapshots (${result.syncId})`,
        )
      }
    }),
).pipe(Command.withDescription("Import UTC daily usage through ccusage"))

const syncCommand = Command.make("sync").pipe(
  Command.withDescription("Synchronize usage"),
  Command.withSubcommands([syncDailyCommand]),
)

const collectorReporter = Effect.gen(function* () {
  const writer = yield* CliOutput
  return {
    listening: (url) =>
      writer.emit({
        command: "collector.run",
        data: { url },
        plain: `OTLP collector listening on ${url}`,
        type: "ready",
      }),
    uploadFailed: (error) => {
      const reason = error instanceof Error ? error.message : String(error)
      return writer.emit({
        command: "collector.run",
        data: { reason },
        plain: `Live usage upload failed: ${reason}`,
        type: "warning",
      })
    },
    uploadSucceeded: (accepted) =>
      writer.emit({
        command: "collector.run",
        data: { accepted },
        plain: `Uploaded ${accepted} live usage snapshots`,
        type: "progress",
      }),
  } satisfies RuntimeReporter
})

const collectorRunCommand = Command.make(
  "run",
  {
    localOnly: Flag.boolean("local-only").pipe(
      Flag.withDescription("Collect without a destination"),
    ),
    uploadInterval: Flag.integer("upload-interval").pipe(
      Flag.filter(
        (seconds) => seconds >= 1,
        () => "Upload interval must be at least 1 second",
      ),
      Flag.withDefault(30),
      Flag.withDescription("Live upload interval in seconds"),
    ),
  },
  ({ localOnly, uploadInterval }) =>
    Effect.gen(function* () {
      const service = yield* configurationService()
      const collector = yield* requireCollector(service.configuration)
      const deviceId = yield* loadDeviceId(service.paths)
      const address = parseCollectorAddress(collector.listenUrl)
      const collectorServices = collectorLayer({
        deviceId,
        maxBodyBytes: 10 * 1024 * 1024,
        statePath: service.paths.collectorStateFile,
      })
      const collectorRuntime = Layer.merge(
        collectorServices,
        bunCollectorServerLayer.pipe(Layer.provide(collectorServices)),
      )
      const reporter = yield* collectorReporter
      if (localOnly) {
        return yield* runLocalCollector({ ...address, reporter }).pipe(
          Effect.provide(collectorRuntime),
        )
      }
      const destination = yield* configuredDestinationLayer(service.configuration, service.paths)
      return yield* runCollector({
        ...address,
        reporter,
        uploadIntervalMilliseconds: uploadInterval * 1_000,
      }).pipe(Effect.provide(Layer.merge(collectorRuntime, destination)))
    }),
).pipe(Command.withDescription("Run the explicit loopback OTLP collector"))

const collectorStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const service = yield* configurationService()
    const collector = yield* requireCollector(service.configuration)
    const fs = yield* FileSystem.FileSystem
    const checkpoint = yield* fs.exists(service.paths.collectorStateFile)
    yield* output(
      "collector.status",
      "result",
      {
        checkpoint,
        checkpointPath: service.paths.collectorStateFile,
        listenUrl: collector.listenUrl,
      },
      `configured at ${collector.listenUrl}; checkpoint ${checkpoint ? "present" : "absent"}`,
    )
  }),
).pipe(Command.withDescription("Inspect collector configuration and checkpoint state"))

const collectorCommand = Command.make("collector").pipe(
  Command.withDescription("Run and inspect the OTLP collector"),
  Command.withSubcommands([collectorRunCommand, collectorStatusCommand]),
)

const authAction = (action: "login" | "logout") =>
  Effect.gen(function* () {
    const service = yield* configurationService()
    const credentials = yield* credentialLayer(service.configuration, service.paths)
    yield* CredentialProvider.pipe(
      Effect.flatMap((provider) => provider[action]()),
      Effect.provide(credentials),
    )
    yield* output(
      `auth.${action}`,
      "result",
      { action },
      action === "login" ? "Authentication complete" : "Credentials removed",
    )
  })

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage destination credentials"),
  Command.withSubcommands([
    Command.make("login", {}, () => authAction("login")),
    Command.make("logout", {}, () => authAction("logout")),
  ]),
)

const serviceDefinition = Effect.fn("Cli.serviceDefinition")(function* () {
  const paths = yield* selectedRuntimePaths()
  const executableOverride = environment.LUMEN_EXECUTABLE_PATH
  return yield* makeServiceDefinition({
    configPath: paths.configFile,
    executablePath: resolve(executableOverride ?? process.execPath),
    host: hostPaths(),
    ...(executableOverride === undefined
      ? { prefixArguments: [resolve(process.argv[1] ?? "lumen-sync")] }
      : {}),
  })
})

const serviceInstallCommand = Command.make("install", {}, () =>
  Effect.gen(function* () {
    yield* requireCollector((yield* configurationService()).configuration)
    const definition = yield* serviceDefinition()
    yield* installService(definition)
    yield* output(
      "service.install",
      "result",
      { path: definition.artifact.path },
      `Installed ${definition.artifact.path}`,
    )
  }).pipe(Effect.provide(liveServiceCommandRunnerLayer)),
)

const serviceUninstallCommand = Command.make("uninstall", {}, () =>
  Effect.gen(function* () {
    const definition = yield* serviceDefinition()
    yield* uninstallService(definition)
    yield* output(
      "service.uninstall",
      "result",
      { path: definition.artifact.path },
      `Removed ${definition.artifact.path}`,
    )
  }).pipe(Effect.provide(liveServiceCommandRunnerLayer)),
)

const serviceStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const definition = yield* serviceDefinition()
    const status = yield* inspectService(definition)
    yield* output(
      "service.status",
      "result",
      {
        path: definition.artifact.path,
        status,
      },
      `${status}: ${definition.artifact.path}`,
    )
  }),
)

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the collector as a user service"),
  Command.withSubcommands([serviceInstallCommand, serviceStatusCommand, serviceUninstallCommand]),
)

const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const service = yield* configurationService()
    const collector = service.configuration.collector
    const destination = service.configuration.destination
    const auth = service.configuration.auth
    const issues = [
      ...(collector === undefined ? ["collector.listen_url is not configured"] : []),
      ...((destination === undefined) !== (auth === undefined)
        ? ["destination and authentication must be configured together"]
        : []),
    ]
    if (collector !== undefined) {
      const paths = configuredHarnessPaths(service.paths)
      const statuses = yield* Effect.forEach(harnessChoice, (harness) =>
        inspectHarness({
          collectorUrl: collector.listenUrl,
          harness,
          paths,
        }),
      )
      for (const status of statuses.filter(
        ({ state }) => state === "conflicting" || state === "unreadable",
      )) {
        issues.push(`${status.harness}: ${status.state}`)
      }
    }
    for (const issue of issues) {
      yield* output("doctor", "warning", { issue }, issue)
    }
    yield* output(
      "doctor",
      "result",
      {
        configPath: service.paths.configFile,
        issues,
        ok: issues.length === 0,
      },
      issues.length === 0 ? "No configuration problems found" : `${issues.length} problem(s) found`,
    )
  }),
).pipe(Command.withDescription("Check configuration and managed harness state"))

const application = root.pipe(
  Command.withSubcommands([
    authCommand,
    collectorCommand,
    configCommand,
    doctorCommand,
    harnessCommand,
    serviceCommand,
    syncCommand,
  ]),
)

const commandName = (): string => {
  const positional: Array<string> = []
  const arguments_ = process.argv.slice(2)
  const flagsWithValues = new Set(["--completions", "--config", "--log-level"])
  for (let index = 0; index < arguments_.length && positional.length < 2; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined) continue
    if (flagsWithValues.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith("-")) continue
    positional.push(argument)
  }
  return positional.length === 0 ? "lumen-sync" : positional.join(".")
}

const taggedErrorCode = (failure: unknown): string => {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
  ) {
    return failure._tag
  }
  return "CliFailure"
}

const failureMessage = (failure: unknown): string | undefined => {
  if (typeof failure !== "object" || failure === null) return undefined
  if ("message" in failure && typeof failure.message === "string" && failure.message.length > 0) {
    return failure.message
  }
  if ("reason" in failure && typeof failure.reason === "string" && failure.reason.length > 0) {
    return failure.reason
  }
  if ("key" in failure && typeof failure.key === "string") {
    return `Missing configuration: ${failure.key}`
  }
  return undefined
}

const run = Effect.gen(function* () {
  const writer = yield* CliOutput
  return yield* Command.run(application, { version: VERSION }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return writer.emit({
          command: commandName(),
          data: {},
          plain: "Shutting down",
          type: "shutdown",
        })
      }
      const failure = Cause.squash(cause)
      const code = taggedErrorCode(failure)
      const message =
        failureMessage(failure) ?? (Cause.pretty(cause).trim() || "CLI command failed")
      return writer
        .emitError({
          command: commandName(),
          error: {
            code,
            message,
            retryable: code === "DestinationUnavailable",
          },
          plain: message,
        })
        .pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        )
    }),
  )
})

run.pipe(
  Effect.provide(cliOutputLayer(process.argv.includes("--json"))),
  Effect.provide(bunHarnessFileSystemLayer),
  Effect.provide(bunSyncPlatformLayer),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
