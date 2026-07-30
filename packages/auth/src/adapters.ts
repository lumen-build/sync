import {
  Config,
  ConfigProvider,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { withAuthenticationDeadline } from "./deadline.js"
import { AuthenticationFailed, MissingCredential, SecretStoreError } from "./errors.js"
import { AuthorizationCodeReceiver } from "./oidc-client.js"
import { AssertionProvider, SecretStore } from "./ports.js"

const StoredSecrets = Schema.Record(Schema.String, Schema.String)
const secretError = (operation: string, cause: unknown): SecretStoreError =>
  new SecretStoreError({ cause, operation })

const readSecrets = Effect.fn("SecretStore.file.read")(function* (filePath: string) {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(filePath))) return {}
    const contents = yield* fs.readFileString(filePath)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (cause) => cause,
    })
    return yield* Schema.decodeUnknownEffect(StoredSecrets)(parsed)
  }).pipe(Effect.mapError((cause) => secretError("read secret store", cause)))
})

const writeSecrets = Effect.fn("SecretStore.file.write")(function* (
  filePath: string,
  secrets: Readonly<Record<string, string>>,
) {
  return yield* Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temporary = `${filePath}.${yield* crypto.randomUUIDv4}.tmp`
    yield* fs.makeDirectory(path.dirname(filePath), {
      recursive: true,
      mode: 0o700,
    })
    yield* fs
      .writeFileString(temporary, `${JSON.stringify(secrets, undefined, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.andThen(fs.rename(temporary, filePath)),
        Effect.andThen(fs.chmod(filePath, 0o600)),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      )
  }).pipe(Effect.mapError((cause) => secretError("write secret store", cause)))
})

export const fileSecretStoreLayer = (
  filePath: string,
): Layer.Layer<SecretStore, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    SecretStore,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const mutationLock = yield* Semaphore.make(1)
      const read = () =>
        readSecrets(filePath).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      const write = (secrets: Readonly<Record<string, string>>) =>
        writeSecrets(filePath, secrets).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        )
      return SecretStore.of({
        get: Effect.fn("SecretStore.file.get")(function* (key) {
          return (yield* read())[key]
        }),
        remove: Effect.fn("SecretStore.file.remove")((key) =>
          mutationLock.withPermit(
            Effect.gen(function* () {
              const secrets = yield* read()
              if (secrets[key] === undefined) return
              const updated = { ...secrets }
              delete updated[key]
              yield* write(updated)
            }),
          ),
        ),
        set: Effect.fn("SecretStore.file.set")((key, value) =>
          mutationLock.withPermit(
            Effect.gen(function* () {
              yield* write({ ...(yield* read()), [key]: value })
            }),
          ),
        ),
      })
    }),
  )

interface AssertionEnvironment {
  readonly circle: Redacted.Redacted<string> | undefined
  readonly githubRequestToken: Redacted.Redacted<string> | undefined
  readonly githubRequestUrl: string | undefined
  readonly gitlab: Redacted.Redacted<string> | undefined
  readonly lumen: Redacted.Redacted<string> | undefined
}

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(
      (error) =>
        new AuthenticationFailed({
          operation: "read OIDC assertion environment",
          reason: `${name}: ${error.message}`,
        }),
    ),
  )

const optionalSecret = (name: string) =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(
      (error) =>
        new AuthenticationFailed({
          operation: "read OIDC assertion environment",
          reason: `${name}: ${error.message}`,
        }),
    ),
  )

const readAssertionEnvironment = Effect.fn("AssertionProvider.readEnvironment")(function* () {
  return {
    circle: yield* optionalSecret("CIRCLE_OIDC_TOKEN_V2"),
    githubRequestToken: yield* optionalSecret("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    githubRequestUrl: yield* optionalString("ACTIONS_ID_TOKEN_REQUEST_URL"),
    gitlab: (yield* optionalSecret("CI_JOB_JWT_V2")) ?? (yield* optionalSecret("CI_JOB_JWT")),
    lumen: yield* optionalSecret("LUMEN_OIDC_ASSERTION"),
  } satisfies AssertionEnvironment
})

const githubAssertion = Effect.fn("AssertionProvider.github")(function* (
  client: HttpClient.HttpClient,
  environment: AssertionEnvironment,
  audience?: string,
) {
  if (environment.githubRequestUrl === undefined || environment.githubRequestToken === undefined) {
    return undefined
  }
  const requestToken = environment.githubRequestToken
  const requestUrlValue = environment.githubRequestUrl

  const requestUrl = yield* Effect.try({
    try: () => new URL(requestUrlValue),
    catch: (cause) =>
      new AuthenticationFailed({
        operation: "request GitHub Actions OIDC assertion",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })
  if (audience !== undefined) requestUrl.searchParams.set("audience", audience)
  const payload = yield* withAuthenticationDeadline(
    "request GitHub Actions OIDC assertion",
    Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.get(requestUrl).pipe(HttpClientRequest.acceptJson, (request) =>
            HttpClientRequest.bearerToken(request, requestToken),
          ),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new AuthenticationFailed({
                operation: "request GitHub Actions OIDC assertion",
                reason: error.message,
              }),
          ),
        )
      if (response.status < 200 || response.status >= 300) {
        return yield* new AuthenticationFailed({
          operation: "request GitHub Actions OIDC assertion",
          reason: `HTTP ${response.status}`,
        })
      }
      return yield* response.json.pipe(
        Effect.mapError(
          (error) =>
            new AuthenticationFailed({
              operation: "decode GitHub Actions OIDC assertion",
              reason: error.message,
            }),
        ),
      )
    }),
  )
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ value: Schema.NonEmptyString }),
  )(payload).pipe(
    Effect.mapError(
      (error) =>
        new AuthenticationFailed({
          operation: "decode GitHub Actions OIDC assertion",
          reason: error.message,
        }),
    ),
  )
  return Redacted.make(decoded.value)
})

const definedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

export const environmentAssertionLayer = (
  environment?: Readonly<Record<string, string | undefined>>,
): Layer.Layer<AssertionProvider, AuthenticationFailed, HttpClient.HttpClient> => {
  const live = Layer.effect(
    AssertionProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const values = yield* readAssertionEnvironment()
      return AssertionProvider.of({
        get: Effect.fn("AssertionProvider.environment")(function* (audience) {
          const assertion =
            values.lumen ??
            values.circle ??
            values.gitlab ??
            (yield* githubAssertion(client, values, audience))
          if (assertion === undefined || Redacted.value(assertion).length === 0) {
            return yield* new MissingCredential({
              source: "LUMEN_OIDC_ASSERTION, GitHub Actions OIDC, GitLab CI JWT, or CircleCI OIDC",
            })
          }
          return assertion
        }),
      })
    }),
  )
  return environment === undefined
    ? live
    : live.pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: definedEnvironment(environment) })),
        ),
      )
}

export type HostPlatform = "darwin" | "linux" | "win32"

export const browserCommand = (url: string, platform: HostPlatform): ReadonlyArray<string> => {
  switch (platform) {
    case "darwin":
      return ["open", url]
    case "win32":
      return ["rundll32.exe", "url.dll,FileProtocolHandler", url]
    case "linux":
      return ["xdg-open", url]
  }
}

const openBrowser = Effect.fn("AuthorizationCodeReceiver.openBrowser")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: HostPlatform,
  url: string,
) {
  return yield* Effect.gen(function* () {
    const [command, ...args] = browserCommand(url, platform)
    const handle = yield* spawner.spawn(
      ChildProcess.make(command as string, args, {
        stderr: "ignore",
        stdout: "ignore",
      }),
    )
    yield* handle.unref.pipe(Effect.asVoid)
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new AuthenticationFailed({
          operation: "open authorization URL",
          reason: cause.message,
        }),
    ),
  )
})

export interface LocalAuthorizationCodeReceiverOptions {
  readonly platform: HostPlatform
}

export const localAuthorizationCodeReceiverLayer = ({
  platform,
}: LocalAuthorizationCodeReceiverOptions): Layer.Layer<
  AuthorizationCodeReceiver,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    AuthorizationCodeReceiver,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return AuthorizationCodeReceiver.of({
        authorize: Effect.fn("AuthorizationCodeReceiver.local")(
          function* (authorizationUrl, expectedState) {
            const request = yield* Effect.try({
              try: () => new URL(authorizationUrl),
              catch: (cause) =>
                new AuthenticationFailed({
                  operation: "start authorization callback",
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
            })
            const redirectValue = request.searchParams.get("redirect_uri")
            if (redirectValue === null) {
              return yield* new AuthenticationFailed({
                operation: "start authorization callback",
                reason: "authorization request has no redirect_uri",
              })
            }
            const redirect = yield* Effect.try({
              try: () => new URL(redirectValue),
              catch: (cause) =>
                new AuthenticationFailed({
                  operation: "start authorization callback",
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
            })
            if (
              redirect.protocol !== "http:" ||
              !["127.0.0.1", "::1", "localhost"].includes(redirect.hostname)
            ) {
              return yield* new AuthenticationFailed({
                operation: "start authorization callback",
                reason: "redirect_uri must use an HTTP loopback address",
              })
            }

            const pending = Promise.withResolvers<{
              readonly code: string
              readonly state: string
            }>()
            return yield* Effect.acquireUseRelease(
              Effect.try({
                try: () =>
                  Bun.serve({
                    fetch: (incoming) => {
                      const callback = new URL(incoming.url)
                      if (callback.pathname !== redirect.pathname) {
                        return new Response("Not found", { status: 404 })
                      }
                      const state = callback.searchParams.get("state")
                      if (state !== expectedState) {
                        return new Response("Invalid authorization callback.", {
                          status: 400,
                        })
                      }
                      const error = callback.searchParams.get("error")
                      const code = callback.searchParams.get("code")
                      if (error !== null) {
                        pending.reject(new Error(error))
                        return new Response("Authorization failed. You can close this window.", {
                          status: 400,
                        })
                      }
                      if (code === null) {
                        pending.reject(new Error("invalid authorization callback"))
                        return new Response("Invalid authorization callback.", {
                          status: 400,
                        })
                      }
                      pending.resolve({ code, state })
                      return new Response("Authorization complete. You can close this window.")
                    },
                    hostname: redirect.hostname,
                    port: redirect.port === "" ? 80 : Number(redirect.port),
                  }),
                catch: (cause) =>
                  new AuthenticationFailed({
                    operation: "start authorization callback",
                    reason: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
              () =>
                Effect.gen(function* () {
                  yield* openBrowser(spawner, platform, authorizationUrl).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning(
                        `Could not open a browser automatically. Open this URL:\n${authorizationUrl}`,
                        error,
                      ),
                    ),
                  )
                  return yield* Effect.tryPromise({
                    try: () => pending.promise,
                    catch: (cause) =>
                      new AuthenticationFailed({
                        operation: "receive authorization callback",
                        reason: cause instanceof Error ? cause.message : String(cause),
                      }),
                  }).pipe(
                    Effect.timeoutOrElse({
                      duration: "5 minutes",
                      orElse: () =>
                        Effect.fail(
                          new AuthenticationFailed({
                            operation: "receive authorization callback",
                            reason: "timed out",
                          }),
                        ),
                    }),
                  )
                }),
              (server) => Effect.promise(() => server.stop()),
            ).pipe(
              Effect.mapError((error) =>
                error instanceof AuthenticationFailed
                  ? error
                  : new AuthenticationFailed({
                      operation: "receive authorization callback",
                      reason: String(error),
                    }),
              ),
            )
          },
        ),
      })
    }),
  )
