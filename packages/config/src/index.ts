import { stringify, TomlDocument } from "@decimalturn/toml-patch"
import {
  Config,
  ConfigProvider,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect"

const parseUrl = (value: string): URL | undefined => URL.parse(value) ?? undefined
const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

const isSecureOrLoopbackUrl = (value: string): boolean => {
  const url = parseUrl(value)
  return (
    url !== undefined &&
    url.username === "" &&
    url.password === "" &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname)))
  )
}

export const NetworkUrl = Schema.NonEmptyString.check(
  Schema.makeFilter(isSecureOrLoopbackUrl, {
    message: "expected an HTTPS URL or an HTTP loopback URL",
  }),
)

export const CollectorListenUrl = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      const url = parseUrl(value)
      return (
        url !== undefined &&
        url.protocol === "http:" &&
        loopbackHosts.has(url.hostname) &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      )
    },
    {
      message: "expected an HTTP loopback URL without credentials, path, query, or fragment",
    },
  ),
)

export const RedirectUrl = Schema.NonEmptyString.check(
  Schema.makeFilter(isSecureOrLoopbackUrl, {
    message: "expected an HTTPS or loopback redirect URL",
  }),
)

const RawOidc = Schema.Struct({
  audience: Schema.optionalKey(Schema.NonEmptyString),
  client_id: Schema.NonEmptyString,
  issuer: NetworkUrl,
  redirect_uri: RedirectUrl,
  scopes: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  validation: Schema.Literals(["jwks", "introspection"]),
})

const RawAuth = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("bearer") }),
  Schema.Struct({ mode: Schema.Literal("oidc"), oidc: RawOidc }),
])

const RawConfiguration = Schema.Struct({
  auth: Schema.optionalKey(RawAuth),
  collector: Schema.optionalKey(Schema.Struct({ listen_url: CollectorListenUrl })),
  destination: Schema.optionalKey(Schema.Struct({ base_url: NetworkUrl })),
})

export interface OidcConfiguration {
  readonly audience?: string
  readonly clientId: string
  readonly issuer: string
  readonly redirectUri: string
  readonly scopes: ReadonlyArray<string>
  readonly validation: "jwks" | "introspection"
}

export type AuthConfiguration =
  | { readonly mode: "bearer" }
  | { readonly mode: "oidc"; readonly oidc: OidcConfiguration }

export interface Configuration {
  readonly auth?: AuthConfiguration
  readonly collector?: { readonly listenUrl: string }
  readonly destination?: { readonly baseUrl: string }
}

export class InvalidConfiguration extends Schema.TaggedError<InvalidConfiguration>()(
  "Configuration.Invalid",
  { reason: Schema.String },
) {}

export class MissingConfiguration extends Schema.TaggedError<MissingConfiguration>()(
  "Configuration.Missing",
  { key: Schema.String },
) {}

export class ConfigurationFileError extends Schema.TaggedError<ConfigurationFileError>()(
  "Configuration.FileError",
  { path: Schema.String, reason: Schema.String },
) {}

export class ConfigurationInitError extends Schema.TaggedError<ConfigurationInitError>()(
  "Configuration.InitError",
  { path: Schema.String, reason: Schema.String },
) {}

const toAuthConfiguration = (raw: typeof RawAuth.Type): AuthConfiguration =>
  raw.mode === "bearer"
    ? { mode: "bearer" }
    : {
        mode: "oidc",
        oidc: {
          ...(raw.oidc.audience === undefined ? {} : { audience: raw.oidc.audience }),
          clientId: raw.oidc.client_id,
          issuer: raw.oidc.issuer,
          redirectUri: raw.oidc.redirect_uri,
          scopes: raw.oidc.scopes,
          validation: raw.oidc.validation,
        },
      }

export const decode = Effect.fn("Configuration.decode")(function* (input: unknown) {
  const raw = yield* Schema.decodeUnknownEffect(RawConfiguration, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError((error) => new InvalidConfiguration({ reason: error.message })))
  return {
    ...(raw.auth === undefined ? {} : { auth: toAuthConfiguration(raw.auth) }),
    ...(raw.collector === undefined ? {} : { collector: { listenUrl: raw.collector.listen_url } }),
    ...(raw.destination === undefined
      ? {}
      : { destination: { baseUrl: raw.destination.base_url } }),
  } satisfies Configuration
})

interface EnvironmentOverrides {
  readonly authMode: string | undefined
  readonly collectorUrl: string | undefined
  readonly destinationUrl: string | undefined
  readonly oidcAudience: string | undefined
  readonly oidcClientId: string | undefined
  readonly oidcIssuer: string | undefined
  readonly oidcRedirectUri: string | undefined
  readonly oidcScopes: string | undefined
  readonly oidcValidation: string | undefined
}

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((error) => new InvalidConfiguration({ reason: `${name}: ${error.message}` })),
  )

const readEnvironmentOverrides = Effect.fn("Configuration.readEnvironmentOverrides")(function* () {
  return {
    authMode: yield* optionalString("LUMEN_AUTH_MODE"),
    collectorUrl: yield* optionalString("LUMEN_COLLECTOR_LISTEN_URL"),
    destinationUrl: yield* optionalString("LUMEN_DESTINATION_BASE_URL"),
    oidcAudience: yield* optionalString("LUMEN_OIDC_AUDIENCE"),
    oidcClientId: yield* optionalString("LUMEN_OIDC_CLIENT_ID"),
    oidcIssuer: yield* optionalString("LUMEN_OIDC_ISSUER"),
    oidcRedirectUri: yield* optionalString("LUMEN_OIDC_REDIRECT_URI"),
    oidcScopes: yield* optionalString("LUMEN_OIDC_SCOPES"),
    oidcValidation: yield* optionalString("LUMEN_OIDC_VALIDATION"),
  } satisfies EnvironmentOverrides
})

const decodeOptional = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: string | undefined,
  key: string,
): Effect.Effect<A | undefined, InvalidConfiguration> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          (error) => new InvalidConfiguration({ reason: `${key}: ${error.message}` }),
        ),
      )

const applyEnvironment = Effect.fn("Configuration.applyEnvironment")(function* (
  base: Configuration,
  environment: EnvironmentOverrides,
) {
  const collectorUrl = yield* decodeOptional(
    CollectorListenUrl,
    environment.collectorUrl,
    "LUMEN_COLLECTOR_LISTEN_URL",
  )
  const destinationUrl = yield* decodeOptional(
    NetworkUrl,
    environment.destinationUrl,
    "LUMEN_DESTINATION_BASE_URL",
  )
  const authMode = environment.authMode ?? base.auth?.mode
  let auth: AuthConfiguration | undefined
  if (authMode === "bearer") {
    auth = { mode: "bearer" }
  } else if (authMode === "oidc") {
    const existing = base.auth?.mode === "oidc" ? base.auth.oidc : undefined
    const issuer = yield* decodeOptional(
      NetworkUrl,
      environment.oidcIssuer ?? existing?.issuer,
      "LUMEN_OIDC_ISSUER",
    )
    const redirectUri = yield* decodeOptional(
      RedirectUrl,
      environment.oidcRedirectUri ?? existing?.redirectUri,
      "LUMEN_OIDC_REDIRECT_URI",
    )
    const clientId = environment.oidcClientId ?? existing?.clientId
    const scopes =
      environment.oidcScopes === undefined
        ? existing?.scopes
        : environment.oidcScopes
            .split(",")
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0)
    const validation = environment.oidcValidation ?? existing?.validation
    if (issuer === undefined) return yield* new MissingConfiguration({ key: "auth.oidc.issuer" })
    if (redirectUri === undefined) {
      return yield* new MissingConfiguration({ key: "auth.oidc.redirect_uri" })
    }
    if (clientId === undefined || clientId.length === 0) {
      return yield* new MissingConfiguration({ key: "auth.oidc.client_id" })
    }
    if (scopes === undefined || scopes.length === 0) {
      return yield* new MissingConfiguration({ key: "auth.oidc.scopes" })
    }
    if (validation !== "jwks" && validation !== "introspection") {
      return yield* new InvalidConfiguration({
        reason: `LUMEN_OIDC_VALIDATION: unsupported value ${JSON.stringify(validation ?? "")}`,
      })
    }
    const audience = environment.oidcAudience ?? existing?.audience
    auth = {
      mode: "oidc",
      oidc: {
        ...(audience === undefined ? {} : { audience }),
        clientId,
        issuer,
        redirectUri,
        scopes,
        validation,
      },
    }
  } else if (authMode !== undefined) {
    return yield* new InvalidConfiguration({
      reason: `LUMEN_AUTH_MODE: unsupported value ${JSON.stringify(authMode)}`,
    })
  }
  return {
    ...(auth === undefined ? {} : { auth }),
    ...(collectorUrl === undefined && base.collector === undefined
      ? {}
      : { collector: { listenUrl: collectorUrl ?? base.collector?.listenUrl ?? "" } }),
    ...(destinationUrl === undefined && base.destination === undefined
      ? {}
      : { destination: { baseUrl: destinationUrl ?? base.destination?.baseUrl ?? "" } }),
  } satisfies Configuration
})

const decodeWithProvider = Effect.fn("Configuration.decodeWithProvider")(function* (
  input: unknown,
) {
  const base = yield* decode(input)
  return yield* applyEnvironment(base, yield* readEnvironmentOverrides())
})

const definedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

export const decodeWithEnvironment = (
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
) =>
  decodeWithProvider(input).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: definedEnvironment(environment) })),
    ),
  )

export interface RuntimeHost {
  readonly appData?: string
  readonly configHome?: string
  readonly dataHome?: string
  readonly homeDirectory: string
  readonly localAppData?: string
  readonly platform: "darwin" | "linux" | "win32"
  readonly stateHome?: string
}

export interface RuntimePaths {
  readonly collectorStateFile: string
  readonly configDirectory: string
  readonly configFile: string
  readonly credentialsFile: string
  readonly dailySyncDirectory: string
  readonly deviceIdFile: string
  readonly harnessOwnershipFile: string
  readonly serviceStateDirectory: string
  readonly stateDirectory: string
}

const joinHost = (platform: RuntimeHost["platform"], ...parts: ReadonlyArray<string>): string => {
  const separator = platform === "win32" ? "\\" : "/"
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0
        ? part.replace(new RegExp(`${separator === "\\" ? "\\\\" : separator}+$`, "u"), "")
        : part.replace(
            new RegExp(
              `^${separator === "\\" ? "\\\\" : separator}+|${separator === "\\" ? "\\\\" : separator}+$`,
              "gu",
            ),
            "",
          ),
    )
    .join(separator)
}

const dirnameHost = (platform: RuntimeHost["platform"], value: string): string => {
  const separator = platform === "win32" ? "\\" : "/"
  const index = value.lastIndexOf(separator)
  if (index < 0) return "."
  return index === 0 ? separator : value.slice(0, index)
}

export interface ResolveRuntimePathsInput {
  readonly configPath?: string | undefined
  readonly host: RuntimeHost
}

export const resolveRuntimePaths = ({
  configPath,
  host,
}: ResolveRuntimePathsInput): RuntimePaths => {
  const configDirectory =
    configPath === undefined
      ? joinHost(
          host.platform,
          host.platform === "win32"
            ? (host.appData ?? joinHost(host.platform, host.homeDirectory, "AppData", "Roaming"))
            : (host.configHome ?? joinHost(host.platform, host.homeDirectory, ".config")),
          "lumen-build",
          "sync",
        )
      : dirnameHost(host.platform, configPath)
  const configFile = configPath ?? joinHost(host.platform, configDirectory, "config.toml")
  const explicit = configPath !== undefined
  let dataDirectory: string
  if (explicit) {
    dataDirectory = configDirectory
  } else if (host.platform === "win32") {
    dataDirectory = joinHost(
      host.platform,
      host.localAppData ?? joinHost(host.platform, host.homeDirectory, "AppData", "Local"),
      "lumen-build",
      "sync",
    )
  } else if (host.platform === "darwin") {
    dataDirectory = joinHost(
      host.platform,
      host.homeDirectory,
      "Library",
      "Application Support",
      "lumen-build",
      "sync",
    )
  } else {
    dataDirectory = joinHost(
      host.platform,
      host.dataHome ?? joinHost(host.platform, host.homeDirectory, ".local", "share"),
      "lumen-build",
      "sync",
    )
  }

  let stateDirectory: string
  if (explicit) {
    stateDirectory = joinHost(host.platform, configDirectory, "state")
  } else if (host.platform === "win32" || host.platform === "darwin") {
    stateDirectory = dataDirectory
  } else {
    stateDirectory = joinHost(
      host.platform,
      host.stateHome ?? joinHost(host.platform, host.homeDirectory, ".local", "state"),
      "lumen-build",
      "sync",
    )
  }
  return {
    collectorStateFile: joinHost(host.platform, stateDirectory, "collector.json"),
    configDirectory,
    configFile,
    credentialsFile: joinHost(host.platform, dataDirectory, "credentials.json"),
    dailySyncDirectory: joinHost(host.platform, stateDirectory, "daily-sync"),
    deviceIdFile: joinHost(host.platform, dataDirectory, "device-id"),
    harnessOwnershipFile: joinHost(host.platform, configDirectory, "harness-ownership.json"),
    serviceStateDirectory: joinHost(host.platform, stateDirectory, "service"),
    stateDirectory,
  }
}

export interface ConfigPathInput {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly homeDirectory: string
  readonly platform: string
}

export const resolveConfigPath = ({
  environment,
  homeDirectory,
  platform,
}: ConfigPathInput): string => {
  const explicit = environment.LUMEN_CONFIG
  if (explicit !== undefined && explicit.length > 0) return explicit
  const host: RuntimeHost = {
    ...(environment.APPDATA === undefined ? {} : { appData: environment.APPDATA }),
    ...(environment.XDG_CONFIG_HOME === undefined
      ? {}
      : { configHome: environment.XDG_CONFIG_HOME }),
    homeDirectory,
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  }
  return resolveRuntimePaths({ host }).configFile
}

export const parseToml = Effect.fn("Configuration.parseToml")(function* (
  path: string,
  contents: string,
) {
  return yield* Effect.try({
    try: () => new TomlDocument(contents).toJsObject,
    catch: (cause) =>
      new ConfigurationFileError({
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })
})

const readRaw = Effect.fn("Configuration.readRaw")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs
    .exists(path)
    .pipe(Effect.mapError((error) => new ConfigurationFileError({ path, reason: error.message })))
  if (!exists) return {}
  const contents = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((error) => new ConfigurationFileError({ path, reason: error.message })))
  return yield* parseToml(path, contents)
})

export interface LoadConfigurationInput {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly path: string
}

export const load = Effect.fn("Configuration.load")(function* ({
  environment,
  path,
}: LoadConfigurationInput) {
  const raw = yield* readRaw(path)
  return yield* environment === undefined
    ? decodeWithProvider(raw)
    : decodeWithEnvironment(raw, environment)
})

export const requireCollector = (
  configuration: Configuration,
): Effect.Effect<NonNullable<Configuration["collector"]>, MissingConfiguration> =>
  configuration.collector === undefined
    ? Effect.fail(new MissingConfiguration({ key: "collector.listen_url" }))
    : Effect.succeed(configuration.collector)

export const requireDestination = (
  configuration: Configuration,
): Effect.Effect<NonNullable<Configuration["destination"]>, MissingConfiguration> =>
  configuration.destination === undefined
    ? Effect.fail(new MissingConfiguration({ key: "destination.base_url" }))
    : Effect.succeed(configuration.destination)

export const requireAuth = (
  configuration: Configuration,
): Effect.Effect<AuthConfiguration, MissingConfiguration> =>
  configuration.auth === undefined
    ? Effect.fail(new MissingConfiguration({ key: "auth.mode" }))
    : Effect.succeed(configuration.auth)

export interface InitializeConfigurationInput {
  readonly auth?: AuthConfiguration
  readonly collectorListenUrl: string
  readonly destinationBaseUrl?: string
  readonly force?: boolean
  readonly path: string
}

const toRawAuth = (auth: AuthConfiguration) =>
  auth.mode === "bearer"
    ? { mode: "bearer" as const }
    : {
        mode: "oidc" as const,
        oidc: {
          ...(auth.oidc.audience === undefined ? {} : { audience: auth.oidc.audience }),
          client_id: auth.oidc.clientId,
          issuer: auth.oidc.issuer,
          redirect_uri: auth.oidc.redirectUri,
          scopes: [...auth.oidc.scopes],
          validation: auth.oidc.validation,
        },
      }

export const initialize = Effect.fn("Configuration.initialize")(function* (
  input: InitializeConfigurationInput,
) {
  if ((input.destinationBaseUrl === undefined) !== (input.auth === undefined)) {
    return yield* new InvalidConfiguration({
      reason: "destination and authentication must be configured together",
    })
  }
  const configuration = yield* decode({
    ...(input.auth === undefined ? {} : { auth: toRawAuth(input.auth) }),
    collector: { listen_url: input.collectorListenUrl },
    ...(input.destinationBaseUrl === undefined
      ? {}
      : { destination: { base_url: input.destinationBaseUrl } }),
  })
  const collector = yield* requireCollector(configuration)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const exists = yield* fs
    .exists(input.path)
    .pipe(
      Effect.mapError(
        (error) => new ConfigurationInitError({ path: input.path, reason: error.message }),
      ),
    )
  if (exists && input.force !== true) {
    return yield* new ConfigurationInitError({
      path: input.path,
      reason: "configuration already exists",
    })
  }
  const contents = stringify({
    ...(configuration.auth === undefined ? {} : { auth: toRawAuth(configuration.auth) }),
    collector: { listen_url: collector.listenUrl },
    ...(configuration.destination === undefined
      ? {}
      : { destination: { base_url: configuration.destination.baseUrl } }),
  })
  const directory = path.dirname(input.path)
  const identifier = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (error) => new ConfigurationInitError({ path: input.path, reason: error.message }),
    ),
  )
  const temporary = path.join(directory, `.config.${identifier}.tmp`)
  yield* fs
    .makeDirectory(directory, { mode: 0o700, recursive: true })
    .pipe(
      Effect.mapError(
        (error) => new ConfigurationInitError({ path: input.path, reason: error.message }),
      ),
    )
  const publish =
    input.force === true ? fs.rename(temporary, input.path) : fs.link(temporary, input.path)
  yield* fs.writeFileString(temporary, contents, { flag: "wx", mode: 0o600 }).pipe(
    Effect.andThen(publish),
    Effect.andThen(fs.chmod(input.path, 0o600)),
    Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    Effect.mapError(
      (error) => new ConfigurationInitError({ path: input.path, reason: error.message }),
    ),
  )
  return { configuration, path: input.path } as const
})

export interface Interface {
  readonly configuration: Configuration
  readonly paths: RuntimePaths
  readonly reload: () => Effect.Effect<
    Configuration,
    ConfigurationFileError | InvalidConfiguration | MissingConfiguration
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@lumen-build/sync/Configuration",
) {}

export interface LayerOptions {
  readonly configPath?: string | undefined
  readonly host: RuntimeHost
  readonly paths?: RuntimePaths
}

const configuredPath = Effect.fn("Configuration.configuredPath")(function* (
  explicit: string | undefined,
) {
  if (explicit !== undefined) return explicit
  return yield* optionalString("LUMEN_CONFIG")
})

export const layer = ({
  configPath,
  host,
  paths: resolvedPaths,
}: LayerOptions): Layer.Layer<
  Service,
  ConfigurationFileError | InvalidConfiguration | MissingConfiguration,
  FileSystem.FileSystem
> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths =
        resolvedPaths ??
        resolveRuntimePaths({
          configPath: yield* configuredPath(configPath),
          host,
        })
      const configuration = yield* load({ path: paths.configFile })
      const reload = Effect.fn("Configuration.reload")(function* () {
        return yield* load({ path: paths.configFile }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        )
      })
      return Service.of({ configuration, paths, reload })
    }),
  )

export const layerTest = (configuration: Configuration, paths: RuntimePaths) =>
  Layer.succeed(
    Service,
    Service.of({
      configuration,
      paths,
      reload: Effect.fn("Configuration.Test.reload")(() => Effect.succeed(configuration)),
    }),
  )
