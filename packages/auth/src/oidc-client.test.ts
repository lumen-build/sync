import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Effect, Layer, Redacted } from "effect"
import { it } from "@effect/vitest"
import { Events, OAuth2Server } from "oauth2-mock-server"
import { afterAll, beforeAll, expect } from "vitest"

import {
  AuthenticationFailed,
  AuthorizationCodeReceiver,
  OidcClient,
  RequestAuthenticator,
  liveOidcClientLayer,
  oidcIntrospectionAuthenticatorLayer,
  oidcJwtAuthenticatorLayer,
} from "./index.js"

let server: OAuth2Server
let issuer: string

beforeAll(async () => {
  server = new OAuth2Server()
  await server.issuer.keys.generate("RS256")
  await server.start(undefined, "127.0.0.1")
  issuer = server.issuer.url ?? ""
})

afterAll(async () => {
  await server.stop()
})

const configuration = (): OidcConfiguration => ({
  audience: "https://usage.lumen.build",
  clientId: "sync-cli",
  issuer,
  redirectUri: "http://127.0.0.1:9876/callback",
  scopes: ["openid", "offline_access"],
  validation: "jwks",
})

const receiverLayer = Layer.succeed(
  AuthorizationCodeReceiver,
  AuthorizationCodeReceiver.of({
    authorize: (authorizationUrl, expectedState) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(authorizationUrl, {
            redirect: "manual",
            signal,
          })
          const location = response.headers.get("location")
          if (location === null) throw new Error("missing authorization redirect")
          const redirect = new URL(location)
          return {
            code: redirect.searchParams.get("code") ?? "",
            state: redirect.searchParams.get("state") ?? expectedState,
          }
        },
        catch: (cause) =>
          new AuthenticationFailed({
            operation: "test authorization receiver",
            reason: String(cause),
          }),
      }),
  }),
)

const buildAssertion = () =>
  server.issuer.buildToken({
    scopesOrTransform: (_header, payload) => {
      payload.sub = "ci-job"
    },
  })

it.effect("completes PKCE and JWT bearer grants against the local OAuth mock", () =>
  Effect.gen(function* () {
    const client = yield* OidcClient
    const interactive = yield* client.authorize(configuration())
    expect(Redacted.value(interactive.accessToken).length).toBeGreaterThan(20)

    const assertion = yield* Effect.tryPromise({
      try: buildAssertion,
      catch: (cause) =>
        new AuthenticationFailed({
          operation: "build test assertion",
          reason: String(cause),
        }),
    })
    const ci = yield* client.exchangeAssertion(configuration(), Redacted.make(assertion))
    expect(Redacted.value(ci.accessToken).length).toBeGreaterThan(20)

    const refreshed = yield* client.refresh(configuration(), Redacted.make("mock-refresh-token"))
    expect(Redacted.value(refreshed.accessToken).length).toBeGreaterThan(20)
    yield* client.revoke(configuration(), refreshed.accessToken)
  }).pipe(Effect.provide(liveOidcClientLayer), Effect.provide(receiverLayer)),
)

it.effect("validates signed OIDC access tokens into destination principals", () =>
  Effect.gen(function* () {
    server.service.once(Events.BeforeTokenSigning, (token) => {
      token.payload.sub = "user-123"
      token.payload.aud = "https://usage.lumen.build"
    })

    const client = yield* OidcClient
    const assertion = yield* Effect.tryPromise({
      try: buildAssertion,
      catch: (cause) =>
        new AuthenticationFailed({
          operation: "build test assertion",
          reason: String(cause),
        }),
    })
    const tokens = yield* client.exchangeAssertion(configuration(), Redacted.make(assertion))
    const authenticator = yield* RequestAuthenticator
    const principal = yield* authenticator.authenticate(tokens.accessToken)
    expect(principal.subjectId).toBe("user-123")
    expect(principal.scheme).toBe("oidc")
  }).pipe(
    Effect.provide(
      oidcJwtAuthenticatorLayer({
        audience: "https://usage.lumen.build",
        issuer: () => issuer,
      }),
    ),
    Effect.provide(liveOidcClientLayer),
    Effect.provide(receiverLayer),
  ),
)

it.effect("rejects the wrong audience and supports configured introspection", () =>
  Effect.gen(function* () {
    server.service.once(Events.BeforeTokenSigning, (token) => {
      token.payload.sub = "user-456"
      token.payload.aud = "https://usage.lumen.build"
    })
    const client = yield* OidcClient
    const assertion = yield* Effect.tryPromise({
      try: buildAssertion,
      catch: (cause) =>
        new AuthenticationFailed({
          operation: "build test assertion",
          reason: String(cause),
        }),
    })
    const tokens = yield* client.exchangeAssertion(configuration(), Redacted.make(assertion))
    const wrongAudienceFailure = yield* Effect.gen(function* () {
      const authenticator = yield* RequestAuthenticator
      return yield* Effect.flip(authenticator.authenticate(tokens.accessToken))
    }).pipe(
      Effect.provide(
        oidcJwtAuthenticatorLayer({
          audience: "https://other.lumen.build",
          issuer: () => issuer,
        }),
      ),
    )
    expect(wrongAudienceFailure).toBeInstanceOf(AuthenticationFailed)

    server.service.once(Events.BeforeIntrospect, (response) => {
      response.body = {
        active: true,
        scope: "usage:write",
        sub: "user-456",
      }
    })
    const principal = yield* Effect.gen(function* () {
      const authenticator = yield* RequestAuthenticator
      return yield* authenticator.authenticate(tokens.accessToken)
    }).pipe(
      Effect.provide(
        oidcIntrospectionAuthenticatorLayer({
          issuer: () => issuer,
          subjectClaim: "sub",
        }),
      ),
    )
    expect(principal.subjectId).toBe("user-456")
  }).pipe(Effect.provide(liveOidcClientLayer), Effect.provide(receiverLayer)),
)
