#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

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
import {
  load as loadConfig,
  requireAuth,
  requireCollector,
  requireDestination,
  resolveConfigPath,
  type Configuration,
} from "@lumen-build/sync-config"
import { DeviceId } from "@lumen-build/sync-contracts"
import { layer as destinationLayer } from "@lumen-build/sync-destination"
import {
  configureHarness,
  Harness,
  makeHarnessPaths,
  removeHarness,
} from "@lumen-build/sync-harness"
import {
  installService,
  liveServiceCommandRunnerLayer,
  makeServiceDefinition,
  uninstallService,
} from "@lumen-build/sync-service"
import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { parseCollectorAddress, runCollector, runLocalCollector, syncDaily } from "./runtime"

const VERSION = "0.1.0"
const environment = process.env as Readonly<Record<string, string | undefined>>

const root = Command.make("lumen-sync").pipe(
  Command.withSharedFlags({
    config: Flag.string("config").pipe(
      Flag.optional,
      Flag.withDescription("Path to a TOML configuration file"),
    ),
  }),
  Command.withDescription("Collect and synchronize usage from AI coding agents"),
)

const selectedConfigPath = Effect.fn("Cli.selectedConfigPath")(function* () {
  const parent = yield* root
  return Option.getOrElse(parent.config, () =>
    resolveConfigPath({
      environment,
      homeDirectory: homedir(),
      platform: process.platform,
    }),
  )
})

const configuration = Effect.fn("Cli.configuration")(function* () {
  const path = yield* selectedConfigPath()
  return yield* loadConfig({ environment, path })
})

const hostPaths = () => ({
  ...(environment.APPDATA === undefined ? {} : { appData: environment.APPDATA }),
  ...(environment.XDG_CONFIG_HOME === undefined ? {} : { configHome: environment.XDG_CONFIG_HOME }),
  ...(environment.COPILOT_HOME === undefined ? {} : { copilotHome: environment.COPILOT_HOME }),
  home: homedir(),
  platform: process.platform as "darwin" | "linux" | "win32",
})

const credentialLayer = (
  config: Configuration,
  configPath: string,
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

    const receiver = localAuthorizationCodeReceiverLayer
    const assertions = environmentAssertionLayer(environment)
    const secrets = fileSecretStoreLayer(join(dirname(configPath), "credentials.json"))
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
  configPath: string,
) {
  const destination = yield* requireDestination(config)
  const credentials = yield* credentialLayer(config, configPath)
  return destinationLayer({ baseUrl: destination.baseUrl }).pipe(
    Layer.provide(Layer.merge(BunHttpClient.layer, credentials)),
  )
})

const loadDeviceId = Effect.fn("Cli.loadDeviceId")(function* (configPath: string) {
  const explicit = environment.LUMEN_DEVICE_ID
  if (explicit !== undefined) {
    return yield* Schema.decodeUnknownEffect(DeviceId)(explicit)
  }
  const path = join(dirname(configPath), "device-id")
  const existing = yield* Effect.tryPromise({
    try: async () => {
      try {
        return (await readFile(path, "utf8")).trim()
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return undefined
        }
        throw cause
      }
    },
    catch: (cause) => cause,
  })
  if (existing !== undefined) return yield* Schema.decodeUnknownEffect(DeviceId)(existing)

  const created = crypto.randomUUID()
  const persisted = yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { mode: 0o700, recursive: true })
      try {
        await writeFile(path, `${created}\n`, { flag: "wx", mode: 0o600 })
        return created
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "EEXIST"
        ) {
          return (await readFile(path, "utf8")).trim()
        }
        throw cause
      }
    },
    catch: (cause) => cause,
  })
  return yield* Schema.decodeUnknownEffect(DeviceId)(persisted)
})

const configPathCommand = Command.make("path", {}, () =>
  selectedConfigPath().pipe(Effect.flatMap(Console.log)),
).pipe(Command.withDescription("Print the selected configuration path"))

const configCheckCommand = Command.make("check", {}, () =>
  Effect.gen(function* () {
    const path = yield* selectedConfigPath()
    const loaded = yield* configuration()
    yield* Console.log(`Valid configuration: ${path}`)
    yield* Console.log(
      `Endpoints: collector=${loaded.collector?.listenUrl ?? "unset"}, destination=${loaded.destination?.baseUrl ?? "unset"}`,
    )
  }),
).pipe(Command.withDescription("Validate TOML and environment configuration"))

const configCommand = Command.make("config").pipe(
  Command.withDescription("Inspect configuration"),
  Command.withSubcommands([configPathCommand, configCheckCommand]),
)

const harnessChoice = Harness.literals
const harnessFlags = {
  agent: Flag.choice("agent", harnessChoice).pipe(
    Flag.between(0, harnessChoice.length),
    Flag.withDescription("Agent harness to configure; repeat to select multiple"),
  ),
}

const selectedHarnesses = (values: ReadonlyArray<Harness>): ReadonlyArray<Harness> =>
  values.length === 0 ? harnessChoice : [...new Set(values)]

const harnessSetupCommand = Command.make(
  "setup",
  {
    ...harnessFlags,
    force: Flag.boolean("force").pipe(Flag.withDescription("Replace conflicting managed fields")),
  },
  ({ agent, force }) =>
    Effect.gen(function* () {
      const config = yield* configuration()
      const collector = yield* requireCollector(config)
      const paths = makeHarnessPaths(hostPaths())
      for (const harness of selectedHarnesses(agent)) {
        const result = yield* configureHarness({
          collectorUrl: collector.listenUrl,
          force,
          harness,
          paths,
        })
        yield* Console.log(`${harness}: ${result.state}`)
      }
      yield* Console.log(
        "OpenCode also needs LUMEN_COLLECTOR_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT in its environment.",
      )
    }),
).pipe(Command.withDescription("Configure privacy-safe OTLP export"))

const harnessRemoveCommand = Command.make("remove", harnessFlags, ({ agent }) =>
  Effect.gen(function* () {
    const paths = makeHarnessPaths(hostPaths())
    for (const harness of selectedHarnesses(agent)) {
      const result = yield* removeHarness({ harness, paths })
      yield* Console.log(
        `${harness}: restored ${result.restored.length}, preserved ${result.preserved.length}`,
      )
    }
  }),
).pipe(Command.withDescription("Restore fields previously managed by Lumen Sync"))

const harnessCommand = Command.make("harness").pipe(
  Command.withDescription("Manage agent telemetry harnesses"),
  Command.withSubcommands([harnessSetupCommand, harnessRemoveCommand]),
)

const today = (): string => new Date().toISOString().slice(0, 10)

const syncCommand = Command.make(
  "sync",
  {
    agent: Flag.choice("agent", CcusageAgent.literals).pipe(
      Flag.between(0, CcusageAgent.literals.length),
      Flag.withDescription("ccusage agent source; repeat to select multiple"),
    ),
    since: Flag.string("since").pipe(Flag.optional),
    until: Flag.string("until").pipe(Flag.optional),
  },
  ({ agent, since, until }) =>
    Effect.gen(function* () {
      const configPath = yield* selectedConfigPath()
      const config = yield* configuration()
      const deviceId = yield* loadDeviceId(configPath)
      const destination = yield* configuredDestinationLayer(config, configPath)
      const ccusagePath = createRequire(import.meta.url).resolve("ccusage/src/cli.js")
      const selectedAgents = agent.length === 0 ? [...CcusageAgent.literals] : [...new Set(agent)]
      const results = yield* syncDaily({
        agents: selectedAgents,
        capturedAt: new Date().toISOString(),
        deviceId,
        since: Option.getOrElse(since, today),
        until: Option.getOrElse(until, today),
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
        yield* Console.log(
          `${result.agent}: committed ${result.committed} snapshots (${result.syncId})`,
        )
      }
    }),
).pipe(Command.withDescription("Import UTC daily usage through ccusage and upload it"))

const collectorStartCommand = Command.make(
  "start",
  {
    localOnly: Flag.boolean("local-only").pipe(
      Flag.withDescription("Collect in memory without uploading"),
    ),
    uploadInterval: Flag.integer("upload-interval").pipe(
      Flag.withDefault(30),
      Flag.withDescription("Live upload interval in seconds"),
    ),
  },
  ({ localOnly, uploadInterval }) =>
    Effect.gen(function* () {
      const configPath = yield* selectedConfigPath()
      const config = yield* configuration()
      const collector = yield* requireCollector(config)
      const deviceId = yield* loadDeviceId(configPath)
      const address = parseCollectorAddress(collector.listenUrl)
      const collectorServices = collectorLayer({ deviceId, maxBodyBytes: 10 * 1024 * 1024 })
      if (localOnly) {
        return yield* runLocalCollector(address).pipe(Effect.provide(collectorServices))
      }
      const destination = yield* configuredDestinationLayer(config, configPath)
      return yield* runCollector({
        ...address,
        uploadIntervalMilliseconds: uploadInterval * 1_000,
      }).pipe(Effect.provide(Layer.merge(collectorServices, destination)))
    }),
).pipe(Command.withDescription("Run the explicit loopback OTLP collector"))

const collectorCommand = Command.make("collector").pipe(
  Command.withDescription("Run the OTLP collector"),
  Command.withSubcommands([collectorStartCommand]),
)

const authAction = (action: "login" | "logout") =>
  Effect.gen(function* () {
    const configPath = yield* selectedConfigPath()
    const config = yield* configuration()
    const credentials = yield* credentialLayer(config, configPath)
    yield* Effect.gen(function* () {
      const service = yield* CredentialProvider
      yield* service[action]()
    }).pipe(Effect.provide(credentials))
    yield* Console.log(action === "login" ? "Authentication complete" : "Credentials removed")
  })

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage destination credentials"),
  Command.withSubcommands([
    Command.make("login", {}, () => authAction("login")),
    Command.make("logout", {}, () => authAction("logout")),
  ]),
)

const serviceDefinition = Effect.fn("Cli.serviceDefinition")(function* () {
  const configPath = yield* selectedConfigPath()
  return yield* makeServiceDefinition({
    configPath,
    executablePath: resolve(environment.LUMEN_EXECUTABLE_PATH ?? process.argv[1] ?? "lumen-sync"),
    host: hostPaths(),
  })
})

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the collector as a user service"),
  Command.withSubcommands([
    Command.make("install", {}, () =>
      Effect.gen(function* () {
        yield* requireCollector(yield* configuration())
        const definition = yield* serviceDefinition()
        yield* installService(definition)
        yield* Console.log(`Installed ${definition.artifact.path}`)
      }).pipe(Effect.provide(liveServiceCommandRunnerLayer)),
    ),
    Command.make("uninstall", {}, () =>
      Effect.gen(function* () {
        const definition = yield* serviceDefinition()
        yield* uninstallService(definition)
        yield* Console.log(`Removed ${definition.artifact.path}`)
      }).pipe(Effect.provide(liveServiceCommandRunnerLayer)),
    ),
  ]),
)

const application = root.pipe(
  Command.withSubcommands([
    authCommand,
    collectorCommand,
    configCommand,
    harnessCommand,
    serviceCommand,
    syncCommand,
  ]),
)

Command.run(application, { version: VERSION }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
