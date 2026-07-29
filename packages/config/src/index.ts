import { Effect, Schema } from "effect"

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

const isSecureOrLoopbackUrl = (value: string): boolean => {
  const url = parseUrl(value)
  if (url === undefined) return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && loopbackHosts.has(url.hostname)
}

const isLoopbackRedirect = (value: string): boolean => {
  const url = parseUrl(value)
  return (
    url !== undefined &&
    ((url.protocol === "http:" && loopbackHosts.has(url.hostname)) || url.protocol === "https:")
  )
}

export const NetworkUrl = Schema.NonEmptyString.check(
  Schema.makeFilter(isSecureOrLoopbackUrl, {
    message: "expected an HTTPS URL or an HTTP loopback URL",
  }),
)

const RedirectUrl = Schema.NonEmptyString.check(
  Schema.makeFilter(isLoopbackRedirect, {
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
  Schema.Struct({
    mode: Schema.Literal("oidc"),
    oidc: RawOidc,
  }),
])

const RawConfiguration = Schema.Struct({
  auth: Schema.optionalKey(RawAuth),
  collector: Schema.optionalKey(
    Schema.Struct({
      listen_url: NetworkUrl,
    }),
  ),
  destination: Schema.optionalKey(
    Schema.Struct({
      base_url: NetworkUrl,
    }),
  ),
  model_catalog: Schema.optionalKey(
    Schema.Struct({
      url: NetworkUrl,
    }),
  ),
  privacy: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.Literals(["none", "usage-only", "sanitized-telemetry"]),
    }),
  ),
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
  | {
      readonly mode: "oidc"
      readonly oidc: OidcConfiguration
    }

export interface Configuration {
  readonly auth?: AuthConfiguration
  readonly collector?: { readonly listenUrl: string }
  readonly destination?: { readonly baseUrl: string }
  readonly modelCatalog?: { readonly url: string }
  readonly privacy: {
    readonly mode: "none" | "usage-only" | "sanitized-telemetry"
  }
}

export class InvalidConfiguration extends Schema.TaggedErrorClass<InvalidConfiguration>()(
  "InvalidConfiguration",
  {
    reason: Schema.String,
  },
) {}

export class MissingConfiguration extends Schema.TaggedErrorClass<MissingConfiguration>()(
  "MissingConfiguration",
  {
    key: Schema.String,
  },
) {}

const toAuthConfiguration = (raw: typeof RawAuth.Type): AuthConfiguration => {
  if (raw.mode === "bearer") return { mode: "bearer" }

  return {
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
}

export const decode = Effect.fn("Configuration.decode")(function* (input: unknown) {
  const raw = yield* Schema.decodeUnknownEffect(RawConfiguration, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      (error) =>
        new InvalidConfiguration({
          reason: error.message,
        }),
    ),
  )

  return {
    ...(raw.auth === undefined ? {} : { auth: toAuthConfiguration(raw.auth) }),
    ...(raw.collector === undefined ? {} : { collector: { listenUrl: raw.collector.listen_url } }),
    ...(raw.destination === undefined
      ? {}
      : { destination: { baseUrl: raw.destination.base_url } }),
    ...(raw.model_catalog === undefined ? {} : { modelCatalog: { url: raw.model_catalog.url } }),
    privacy: {
      mode: raw.privacy?.mode ?? "usage-only",
    },
  } satisfies Configuration
})

const environmentUrl = (
  value: string | undefined,
  key: string,
): Effect.Effect<string | undefined, InvalidConfiguration> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(NetworkUrl)(value).pipe(
        Effect.as(value),
        Effect.mapError(
          (error) =>
            new InvalidConfiguration({
              reason: `${key}: ${error.message}`,
            }),
        ),
      )

const invalidEnvironment = (key: string, value: string): InvalidConfiguration =>
  new InvalidConfiguration({
    reason: `${key}: unsupported value ${JSON.stringify(value)}`,
  })

export const decodeWithEnvironment = Effect.fn("Configuration.decodeWithEnvironment")(function* (
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const base = yield* decode(input)
  const collectorUrl = yield* environmentUrl(
    environment.LUMEN_COLLECTOR_LISTEN_URL,
    "LUMEN_COLLECTOR_LISTEN_URL",
  )
  const destinationUrl = yield* environmentUrl(
    environment.LUMEN_DESTINATION_BASE_URL,
    "LUMEN_DESTINATION_BASE_URL",
  )
  const catalogUrl = yield* environmentUrl(
    environment.LUMEN_MODEL_CATALOG_URL,
    "LUMEN_MODEL_CATALOG_URL",
  )

  const authMode = environment.LUMEN_AUTH_MODE ?? base.auth?.mode
  let auth: AuthConfiguration | undefined
  if (authMode === "bearer") {
    auth = { mode: "bearer" }
  } else if (authMode === "oidc") {
    const existing = base.auth?.mode === "oidc" ? base.auth.oidc : undefined
    const issuer =
      (yield* environmentUrl(environment.LUMEN_OIDC_ISSUER, "LUMEN_OIDC_ISSUER")) ??
      existing?.issuer
    const redirectUri =
      (yield* environmentUrl(environment.LUMEN_OIDC_REDIRECT_URI, "LUMEN_OIDC_REDIRECT_URI")) ??
      existing?.redirectUri
    const clientId = environment.LUMEN_OIDC_CLIENT_ID ?? existing?.clientId
    const scopes =
      environment.LUMEN_OIDC_SCOPES === undefined
        ? existing?.scopes
        : environment.LUMEN_OIDC_SCOPES.split(",")
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0)
    const validation = environment.LUMEN_OIDC_VALIDATION ?? existing?.validation

    if (issuer === undefined) {
      return yield* new MissingConfiguration({ key: "auth.oidc.issuer" })
    }
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
      return yield* invalidEnvironment("LUMEN_OIDC_VALIDATION", validation ?? "")
    }

    const audience = environment.LUMEN_OIDC_AUDIENCE ?? existing?.audience
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
    return yield* invalidEnvironment("LUMEN_AUTH_MODE", authMode)
  }

  const privacyMode = environment.LUMEN_PRIVACY_MODE ?? base.privacy.mode
  if (
    privacyMode !== "none" &&
    privacyMode !== "usage-only" &&
    privacyMode !== "sanitized-telemetry"
  ) {
    return yield* invalidEnvironment("LUMEN_PRIVACY_MODE", privacyMode)
  }

  return {
    ...(auth === undefined ? {} : { auth }),
    ...(collectorUrl === undefined && base.collector === undefined
      ? {}
      : { collector: { listenUrl: collectorUrl ?? base.collector?.listenUrl ?? "" } }),
    ...(destinationUrl === undefined && base.destination === undefined
      ? {}
      : {
          destination: {
            baseUrl: destinationUrl ?? base.destination?.baseUrl ?? "",
          },
        }),
    ...(catalogUrl === undefined && base.modelCatalog === undefined
      ? {}
      : { modelCatalog: { url: catalogUrl ?? base.modelCatalog?.url ?? "" } }),
    privacy: { mode: privacyMode },
  } satisfies Configuration
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

  if (platform === "win32") {
    const root = environment.APPDATA ?? `${homeDirectory}\\AppData\\Roaming`
    return `${root}\\lumen\\config.toml`
  }

  const root = environment.XDG_CONFIG_HOME ?? `${homeDirectory}/.config`
  return `${root}/lumen/config.toml`
}
