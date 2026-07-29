import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

import { AuthenticationFailed } from "./errors.js"
import { OidcClient } from "./ports.js"

const DiscoveryDocument = Schema.Struct({
  authorization_endpoint: Schema.NonEmptyString,
  introspection_endpoint: Schema.optionalKey(Schema.NonEmptyString),
  issuer: Schema.NonEmptyString,
  jwks_uri: Schema.NonEmptyString,
  revocation_endpoint: Schema.optionalKey(Schema.NonEmptyString),
  token_endpoint: Schema.NonEmptyString,
})

export interface DiscoveryDocument extends Schema.Schema.Type<typeof DiscoveryDocument> {}

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optionalKey(Schema.Number),
  id_token: Schema.optionalKey(Schema.NonEmptyString),
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  token_type: Schema.optionalKey(Schema.NonEmptyString),
})

export interface AuthorizationCode {
  readonly code: string
  readonly state: string
}

export interface AuthorizationCodeReceiverInterface {
  readonly authorize: (
    authorizationUrl: string,
    expectedState: string,
  ) => Effect.Effect<AuthorizationCode, AuthenticationFailed>
}

export class AuthorizationCodeReceiver extends Context.Service<
  AuthorizationCodeReceiver,
  AuthorizationCodeReceiverInterface
>()("@lumen-build/sync/AuthorizationCodeReceiver") {}

const authenticationFailed = (operation: string, reason: unknown): AuthenticationFailed =>
  new AuthenticationFailed({
    operation,
    reason: reason instanceof Error ? reason.message : String(reason),
  })

const requestJson = Effect.fn("OidcClient.requestJson")(function* (
  operation: string,
  url: string,
  init?: RequestInit,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) => authenticationFailed(operation, cause),
  })
  if (!response.ok) {
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => authenticationFailed(`${operation}.readErrorBody`, cause),
    }).pipe(Effect.orElseSucceed(() => ""))
    return yield* Effect.fail(
      authenticationFailed(
        operation,
        `HTTP ${response.status}${body.length === 0 ? "" : `: ${body.slice(0, 512)}`}`,
      ),
    )
  }
  return yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => authenticationFailed(`${operation}.decodeJson`, cause),
  })
})

const requestVoid = Effect.fn("OidcClient.requestVoid")(function* (
  operation: string,
  url: string,
  init: RequestInit,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) => authenticationFailed(operation, cause),
  })
  if (!response.ok) {
    return yield* Effect.fail(authenticationFailed(operation, `HTTP ${response.status}`))
  }
})

export const discover = Effect.fn("OidcClient.discover")(function* (issuer: string) {
  const url = new URL(
    "/.well-known/openid-configuration",
    issuer.endsWith("/") ? issuer : `${issuer}/`,
  )
  const json = yield* requestJson("OidcClient.discover", url.toString())
  const document = yield* Schema.decodeUnknownEffect(DiscoveryDocument)(json).pipe(
    Effect.mapError((error) => authenticationFailed("OidcClient.decodeDiscovery", error)),
  )
  if (document.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    return yield* Effect.fail(
      authenticationFailed(
        "OidcClient.discover",
        "discovered issuer does not match configured issuer",
      ),
    )
  }
  return document
})

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url")

const randomValue = Effect.fn("OidcClient.randomValue")(function* () {
  const bytes = new Uint8Array(32)
  yield* Effect.try({
    try: () => crypto.getRandomValues(bytes),
    catch: (cause) => authenticationFailed("OidcClient.randomValue", cause),
  })
  return base64Url(bytes)
})

const codeChallenge = Effect.fn("OidcClient.codeChallenge")(function* (verifier: string) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    catch: (cause) => authenticationFailed("OidcClient.codeChallenge", cause),
  })
  return base64Url(new Uint8Array(digest))
})

const requestToken = Effect.fn("OidcClient.requestToken")(function* (
  endpoint: string,
  body: URLSearchParams,
) {
  const json = yield* requestJson("OidcClient.token", endpoint, {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  })
  const token = yield* Schema.decodeUnknownEffect(TokenResponse)(json).pipe(
    Effect.mapError((error) => authenticationFailed("OidcClient.decodeToken", error)),
  )
  return {
    accessToken: Redacted.make(token.access_token),
    ...(token.refresh_token === undefined
      ? {}
      : { refreshToken: Redacted.make(token.refresh_token) }),
  }
})

export const liveOidcClientLayer = Layer.effect(
  OidcClient,
  Effect.gen(function* () {
    const receiver = yield* AuthorizationCodeReceiver

    const authorize = Effect.fn("OidcClient.authorize")(function* (config: OidcConfiguration) {
      const discovery = yield* discover(config.issuer)
      const verifier = yield* randomValue()
      const challenge = yield* codeChallenge(verifier)
      const state = yield* randomValue()
      const nonce = yield* randomValue()
      const authorizationUrl = new URL(discovery.authorization_endpoint)
      authorizationUrl.searchParams.set("client_id", config.clientId)
      authorizationUrl.searchParams.set("code_challenge", challenge)
      authorizationUrl.searchParams.set("code_challenge_method", "S256")
      authorizationUrl.searchParams.set("nonce", nonce)
      authorizationUrl.searchParams.set("redirect_uri", config.redirectUri)
      authorizationUrl.searchParams.set("response_type", "code")
      authorizationUrl.searchParams.set("scope", config.scopes.join(" "))
      authorizationUrl.searchParams.set("state", state)
      if (config.audience !== undefined) {
        authorizationUrl.searchParams.set("aud", config.audience)
      }

      const authorization = yield* receiver.authorize(authorizationUrl.toString(), state)
      if (authorization.state !== state) {
        return yield* Effect.fail(
          authenticationFailed("OidcClient.authorize", "authorization state did not match"),
        )
      }
      if (authorization.code.length === 0) {
        return yield* Effect.fail(
          authenticationFailed(
            "OidcClient.authorize",
            "authorization response did not include a code",
          ),
        )
      }

      const body = new URLSearchParams({
        client_id: config.clientId,
        code: authorization.code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      })
      if (config.audience !== undefined) body.set("aud", config.audience)
      return yield* requestToken(discovery.token_endpoint, body)
    })

    const exchangeAssertion = Effect.fn("OidcClient.exchangeAssertion")(function* (
      config: OidcConfiguration,
      assertion: Redacted.Redacted<string>,
    ) {
      const discovery = yield* discover(config.issuer)
      const body = new URLSearchParams({
        assertion: Redacted.value(assertion),
        client_id: config.clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: config.scopes.join(" "),
      })
      if (config.audience !== undefined) body.set("aud", config.audience)
      return yield* requestToken(discovery.token_endpoint, body)
    })

    const refresh = Effect.fn("OidcClient.refresh")(function* (
      config: OidcConfiguration,
      refreshToken: Redacted.Redacted<string>,
    ) {
      const discovery = yield* discover(config.issuer)
      const body = new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: Redacted.value(refreshToken),
      })
      return yield* requestToken(discovery.token_endpoint, body)
    })

    const revoke = Effect.fn("OidcClient.revoke")(function* (
      config: OidcConfiguration,
      token: Redacted.Redacted<string>,
    ) {
      const discovery = yield* discover(config.issuer)
      if (discovery.revocation_endpoint === undefined) return
      yield* requestVoid("OidcClient.revoke", discovery.revocation_endpoint, {
        body: new URLSearchParams({
          client_id: config.clientId,
          token: Redacted.value(token),
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      })
    })

    return OidcClient.of({ authorize, exchangeAssertion, refresh, revoke })
  }),
)
