import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { Effect, Layer, Redacted, Schema } from "effect"

import { AuthenticationFailed, MissingCredential, SecretStoreError } from "./errors.js"
import { AuthorizationCodeReceiver } from "./oidc-client.js"
import { AssertionProvider, SecretStore } from "./ports.js"

const StoredSecrets = Schema.Record(Schema.String, Schema.String)

const secretError = (operation: string, cause: unknown): SecretStoreError =>
  new SecretStoreError({ cause, operation })

const readSecrets = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const contents = await readFile(path, "utf8")
        return await Schema.decodeUnknownPromise(StoredSecrets)(JSON.parse(contents))
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return {}
        }
        throw cause
      }
    },
    catch: (cause) => secretError("read secret store", cause),
  })

const writeSecrets = (path: string, secrets: Readonly<Record<string, string>>) =>
  Effect.tryPromise({
    try: async () => {
      const directory = dirname(path)
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        await writeFile(temporary, `${JSON.stringify(secrets, undefined, 2)}\n`, { mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    catch: (cause) => secretError("write secret store", cause),
  })

export const fileSecretStoreLayer = (path: string): Layer.Layer<SecretStore> =>
  Layer.succeed(
    SecretStore,
    SecretStore.of({
      get: Effect.fn("SecretStore.file.get")(function* (key) {
        const secrets = yield* readSecrets(path)
        return secrets[key]
      }),
      remove: Effect.fn("SecretStore.file.remove")(function* (key) {
        const secrets = yield* readSecrets(path)
        if (secrets[key] === undefined) return
        const updated = { ...secrets }
        delete updated[key]
        yield* writeSecrets(path, updated)
      }),
      set: Effect.fn("SecretStore.file.set")(function* (key, value) {
        const secrets = yield* readSecrets(path)
        yield* writeSecrets(path, { ...secrets, [key]: value })
      }),
    }),
  )

const githubAssertion = Effect.fn("AssertionProvider.github")(function* (
  environment: Readonly<Record<string, string | undefined>>,
  audience?: string,
) {
  const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (requestUrl === undefined || requestToken === undefined) return undefined

  const url = new URL(requestUrl)
  if (audience !== undefined) url.searchParams.set("audience", audience)
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        headers: { authorization: `Bearer ${requestToken}` },
        signal,
      }),
    catch: (cause) =>
      new AuthenticationFailed({
        operation: "request GitHub Actions OIDC assertion",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })
  if (!response.ok) {
    return yield* new AuthenticationFailed({
      operation: "request GitHub Actions OIDC assertion",
      reason: `HTTP ${response.status}`,
    })
  }
  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      new AuthenticationFailed({
        operation: "decode GitHub Actions OIDC assertion",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })
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
  return decoded.value
})

export const environmentAssertionLayer = (
  environment: Readonly<Record<string, string | undefined>>,
): Layer.Layer<AssertionProvider> =>
  Layer.succeed(
    AssertionProvider,
    AssertionProvider.of({
      get: Effect.fn("AssertionProvider.environment")(function* (audience) {
        const assertion =
          environment.LUMEN_OIDC_ASSERTION ??
          environment.CIRCLE_OIDC_TOKEN_V2 ??
          environment.CI_JOB_JWT_V2 ??
          environment.CI_JOB_JWT ??
          (yield* githubAssertion(environment, audience))
        if (assertion === undefined || assertion.length === 0) {
          return yield* new MissingCredential({
            source: "LUMEN_OIDC_ASSERTION, GitHub Actions OIDC, GitLab CI JWT, or CircleCI OIDC",
          })
        }
        return Redacted.make(assertion)
      }),
    }),
  )

const browserCommand = (url: string): Array<string> => {
  switch (process.platform) {
    case "darwin":
      return ["open", url]
    case "win32":
      return ["cmd.exe", "/c", "start", "", url]
    default:
      return ["xdg-open", url]
  }
}

const openBrowser = (url: string) =>
  Effect.try({
    try: () => {
      const child = Bun.spawn(browserCommand(url), {
        stderr: "ignore",
        stdout: "ignore",
      })
      child.unref()
    },
    catch: (cause) =>
      new AuthenticationFailed({
        operation: "open authorization URL",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

interface PendingAuthorization {
  readonly promise: Promise<{ readonly code: string; readonly state: string }>
  readonly reject: (cause: Error) => void
  readonly resolve: (value: { readonly code: string; readonly state: string }) => void
}

const pendingAuthorization = (): PendingAuthorization => {
  let resolve!: PendingAuthorization["resolve"]
  let reject!: PendingAuthorization["reject"]
  const promise = new Promise<{ readonly code: string; readonly state: string }>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    },
  )
  return { promise, reject, resolve }
}

export const localAuthorizationCodeReceiverLayer: Layer.Layer<AuthorizationCodeReceiver> =
  Layer.succeed(
    AuthorizationCodeReceiver,
    AuthorizationCodeReceiver.of({
      authorize: Effect.fn("AuthorizationCodeReceiver.local")(
        function* (authorizationUrl, expectedState) {
          const request = new URL(authorizationUrl)
          const redirectValue = request.searchParams.get("redirect_uri")
          if (redirectValue === null) {
            return yield* new AuthenticationFailed({
              operation: "start authorization callback",
              reason: "authorization request has no redirect_uri",
            })
          }
          const redirect = new URL(redirectValue)
          if (
            redirect.protocol !== "http:" ||
            !["127.0.0.1", "::1", "localhost"].includes(redirect.hostname)
          ) {
            return yield* new AuthenticationFailed({
              operation: "start authorization callback",
              reason: "redirect_uri must use an HTTP loopback address",
            })
          }

          const pending = pendingAuthorization()
          return yield* Effect.acquireUseRelease(
            Effect.try({
              try: () =>
                Bun.serve({
                  fetch: (incoming) => {
                    const callback = new URL(incoming.url)
                    if (callback.pathname !== redirect.pathname)
                      return new Response("Not found", { status: 404 })
                    const error = callback.searchParams.get("error")
                    const code = callback.searchParams.get("code")
                    const state = callback.searchParams.get("state")
                    if (error !== null) {
                      pending.reject(new Error(error))
                      return new Response("Authorization failed. You can close this window.", {
                        status: 400,
                      })
                    }
                    if (code === null || state === null || state !== expectedState) {
                      pending.reject(new Error("invalid authorization callback"))
                      return new Response("Invalid authorization callback.", { status: 400 })
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
                yield* openBrowser(authorizationUrl).pipe(
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
            (server) => Effect.sync(() => server.stop(true)),
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
    }),
  )
