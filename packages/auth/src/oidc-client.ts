import type { OidcConfiguration } from "@lumen-build/sync-config"
import {
  Clock,
  Context,
  Crypto,
  Effect,
  Encoding,
  Layer,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import { withAuthenticationDeadline } from "./deadline.js"
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
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient
  return yield* withAuthenticationDeadline(
    operation,
    Effect.gen(function* () {
      const response = yield* client
        .execute(HttpClientRequest.acceptJson(request))
        .pipe(Effect.mapError((error) => authenticationFailed(operation, error)))
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* authenticationFailed(
          operation,
          `HTTP ${response.status}${body.length === 0 ? "" : `: ${body.slice(0, 512)}`}`,
        )
      }
      return yield* response.json.pipe(
        Effect.mapError((error) => authenticationFailed(`${operation}.decodeJson`, error)),
      )
    }),
  )
})

const requestVoid = Effect.fn("OidcClient.requestVoid")(function* (
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient
  const response = yield* withAuthenticationDeadline(
    operation,
    client
      .execute(request)
      .pipe(Effect.mapError((error) => authenticationFailed(operation, error))),
  )
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(authenticationFailed(operation, `HTTP ${response.status}`))
  }
})

export const discover = Effect.fn("OidcClient.discover")(function* (issuer: string) {
  const url = new URL(
    ".well-known/openid-configuration",
    issuer.endsWith("/") ? issuer : `${issuer}/`,
  )
  const json = yield* requestJson("OidcClient.discover", HttpClientRequest.get(url))
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

const randomValue = Effect.fn("OidcClient.randomValue")(function* () {
  const crypto = yield* Crypto.Crypto
  const bytes = yield* crypto
    .randomBytes(32)
    .pipe(Effect.mapError((error) => authenticationFailed("OidcClient.randomValue", error)))
  return Encoding.encodeBase64Url(bytes)
})

const codeChallenge = Effect.fn("OidcClient.codeChallenge")(function* (verifier: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .pipe(Effect.mapError((error) => authenticationFailed("OidcClient.codeChallenge", error)))
  return Encoding.encodeBase64Url(digest)
})

const requestToken = Effect.fn("OidcClient.requestToken")(function* (
  endpoint: string,
  body: URLSearchParams,
) {
  const json = yield* requestJson(
    "OidcClient.token",
    HttpClientRequest.post(endpoint).pipe(HttpClientRequest.bodyUrlParams(body)),
  )
  const token = yield* Schema.decodeUnknownEffect(TokenResponse)(json).pipe(
    Effect.mapError((error) => authenticationFailed("OidcClient.decodeToken", error)),
  )
  const now = yield* Clock.currentTimeMillis
  return {
    accessToken: Redacted.make(token.access_token),
    ...(token.expires_in === undefined
      ? {}
      : { expiresAt: now + Math.max(0, token.expires_in) * 1_000 }),
    ...(token.refresh_token === undefined
      ? {}
      : { refreshToken: Redacted.make(token.refresh_token) }),
  }
})

export const liveOidcClientLayer = Layer.effect(
  OidcClient,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const httpClient = yield* HttpClient.HttpClient
    const receiver = yield* AuthorizationCodeReceiver
    const discoveryCache = yield* Ref.make(new Map<string, DiscoveryDocument>())
    const discoveryLock = yield* Semaphore.make(1)
    const discoverWithRuntime = (issuer: string) =>
      discover(issuer).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
    const randomValueWithRuntime = () =>
      randomValue().pipe(Effect.provideService(Crypto.Crypto, crypto))
    const codeChallengeWithRuntime = (verifier: string) =>
      codeChallenge(verifier).pipe(Effect.provideService(Crypto.Crypto, crypto))
    const requestTokenWithRuntime = (endpoint: string, body: URLSearchParams) =>
      requestToken(endpoint, body).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
    const requestVoidWithRuntime = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
    ) =>
      requestVoid(operation, request).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
    const cachedDiscovery = Effect.fn("OidcClient.cachedDiscovery")((issuer: string) =>
      discoveryLock.withPermit(
        Effect.gen(function* () {
          const key = issuer.replace(/\/$/u, "")
          const cached = (yield* Ref.get(discoveryCache)).get(key)
          if (cached !== undefined) return cached
          const document = yield* discoverWithRuntime(issuer)
          yield* Ref.update(discoveryCache, (current) => new Map(current).set(key, document))
          return document
        }),
      ),
    )

    const authorize = Effect.fn("OidcClient.authorize")(function* (config: OidcConfiguration) {
      const discovery = yield* cachedDiscovery(config.issuer)
      const verifier = yield* randomValueWithRuntime()
      const challenge = yield* codeChallengeWithRuntime(verifier)
      const state = yield* randomValueWithRuntime()
      const nonce = yield* randomValueWithRuntime()
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
      return yield* requestTokenWithRuntime(discovery.token_endpoint, body)
    })

    const exchangeAssertion = Effect.fn("OidcClient.exchangeAssertion")(function* (
      config: OidcConfiguration,
      assertion: Redacted.Redacted<string>,
    ) {
      const discovery = yield* cachedDiscovery(config.issuer)
      const body = new URLSearchParams({
        assertion: Redacted.value(assertion),
        client_id: config.clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: config.scopes.join(" "),
      })
      if (config.audience !== undefined) body.set("aud", config.audience)
      return yield* requestTokenWithRuntime(discovery.token_endpoint, body)
    })

    const refresh = Effect.fn("OidcClient.refresh")(function* (
      config: OidcConfiguration,
      refreshToken: Redacted.Redacted<string>,
    ) {
      const discovery = yield* cachedDiscovery(config.issuer)
      const body = new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: Redacted.value(refreshToken),
      })
      return yield* requestTokenWithRuntime(discovery.token_endpoint, body)
    })

    const revoke = Effect.fn("OidcClient.revoke")(function* (
      config: OidcConfiguration,
      token: Redacted.Redacted<string>,
    ) {
      const discovery = yield* cachedDiscovery(config.issuer)
      if (discovery.revocation_endpoint === undefined) return
      yield* requestVoidWithRuntime(
        "OidcClient.revoke",
        HttpClientRequest.post(discovery.revocation_endpoint).pipe(
          HttpClientRequest.bodyUrlParams(
            new URLSearchParams({
              client_id: config.clientId,
              token: Redacted.value(token),
            }),
          ),
        ),
      )
    })

    return OidcClient.of({ authorize, exchangeAssertion, refresh, revoke })
  }),
)
