import type { OidcConfiguration } from "@lumen-build/sync-config"
import type { ServerResponse } from "node:http"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { Events, OAuth2Server } from "oauth2-mock-server"
import { afterAll, beforeAll, expect } from "vitest"

import {
  AuthenticationFailed,
  AuthorizationCodeReceiver,
  OidcClient,
  RequestAuthenticator,
  discover,
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

const discoveryDocument = (
  documentIssuer: string,
  overrides: Partial<{
    readonly revocation_endpoint: string
    readonly token_endpoint: string
  }> = {},
) => ({
  authorization_endpoint: `${issuer}/authorize`,
  issuer: documentIssuer,
  jwks_uri: `${issuer}/jwks`,
  revocation_endpoint: `${issuer}/revoke`,
  token_endpoint: `${issuer}/token`,
  ...overrides,
})

const sendJson = (response: ServerResponse, body: unknown) => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

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

it.effect("preserves the issuer path in the discovery document URL", () =>
  Effect.gen(function* () {
    const pathIssuer = `${issuer}/realms/acme`
    let requestedUrl: string | undefined
    server.service.addRoute(
      "GET",
      "/realms/acme/.well-known/openid-configuration",
      (request, response) => {
        requestedUrl = request.url
        sendJson(response, discoveryDocument(pathIssuer))
      },
    )

    const document = yield* discover(pathIssuer)

    expect(requestedUrl).toBe("/realms/acme/.well-known/openid-configuration")
    expect(document.issuer).toBe(pathIssuer)
  }),
)

it.effect("caches discovery documents for repeated operations", () =>
  Effect.gen(function* () {
    const cachedIssuer = `${issuer}/cached-discovery`
    let discoveryRequests = 0
    server.service.addRoute(
      "GET",
      "/cached-discovery/.well-known/openid-configuration",
      (_request, response) => {
        discoveryRequests += 1
        sendJson(response, discoveryDocument(cachedIssuer))
      },
    )

    const assertion = yield* Effect.tryPromise({
      try: buildAssertion,
      catch: (cause) =>
        new AuthenticationFailed({
          operation: "build test assertion",
          reason: String(cause),
        }),
    })
    const client = yield* OidcClient
    const cachedConfiguration = { ...configuration(), issuer: cachedIssuer }
    yield* client.exchangeAssertion(cachedConfiguration, Redacted.make(assertion))
    yield* client.exchangeAssertion(cachedConfiguration, Redacted.make(assertion))

    expect(discoveryRequests).toBe(1)
  }).pipe(Effect.provide(liveOidcClientLayer), Effect.provide(receiverLayer)),
)

it.effect("fails delayed discovery fetches with AuthenticationFailed", () =>
  Effect.gen(function* () {
    const delayedIssuer = `${issuer}/delayed-discovery`
    const requestStarted = yield* Deferred.make<void>()
    server.service.addRoute(
      "GET",
      "/delayed-discovery/.well-known/openid-configuration",
      (_request, response) => {
        Deferred.doneUnsafe(requestStarted, Effect.void)
        return new Promise<void>((resolve) => response.once("close", resolve))
      },
    )

    const failureFiber = yield* Effect.flip(discover(delayedIssuer)).pipe(Effect.forkChild)
    yield* Deferred.await(requestStarted)
    yield* TestClock.adjust("30 seconds")
    const failure = yield* Fiber.join(failureFiber)

    expect(failure).toBeInstanceOf(AuthenticationFailed)
    expect(failure.operation).toBe("OidcClient.discover")
    expect(failure.reason).toBe("timed out after 30 seconds")
  }),
)

it.effect("fails delayed token response bodies with AuthenticationFailed", () =>
  Effect.gen(function* () {
    const delayedIssuer = `${issuer}/delayed-token`
    const responseStarted = yield* Deferred.make<void>()
    server.service.addRoute(
      "GET",
      "/delayed-token/.well-known/openid-configuration",
      (_request, response) => {
        sendJson(
          response,
          discoveryDocument(delayedIssuer, {
            token_endpoint: `${issuer}/delayed-token-response`,
          }),
        )
      },
    )
    server.service.addRoute("POST", "/delayed-token-response", (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.flushHeaders()
      Deferred.doneUnsafe(responseStarted, Effect.void)
      return new Promise<void>((resolve) => response.once("close", resolve))
    })

    const client = yield* OidcClient
    const failureFiber = yield* Effect.flip(
      client.exchangeAssertion(
        { ...configuration(), issuer: delayedIssuer },
        Redacted.make("header.eyJzdWIiOiJjaS1qb2IifQ.signature"),
      ),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(responseStarted)
    yield* TestClock.adjust("30 seconds")
    const failure = yield* Fiber.join(failureFiber)

    expect(failure).toBeInstanceOf(AuthenticationFailed)
    expect(failure.operation).toBe("OidcClient.token")
    expect(failure.reason).toBe("timed out after 30 seconds")
  }).pipe(Effect.provide(liveOidcClientLayer), Effect.provide(receiverLayer)),
)

it.effect("fails delayed revocation fetches with AuthenticationFailed", () =>
  Effect.gen(function* () {
    const delayedIssuer = `${issuer}/delayed-revoke`
    const requestStarted = yield* Deferred.make<void>()
    server.service.addRoute(
      "GET",
      "/delayed-revoke/.well-known/openid-configuration",
      (_request, response) => {
        sendJson(
          response,
          discoveryDocument(delayedIssuer, {
            revocation_endpoint: `${issuer}/delayed-revoke-response`,
          }),
        )
      },
    )
    server.service.addRoute("POST", "/delayed-revoke-response", (_request, response) => {
      Deferred.doneUnsafe(requestStarted, Effect.void)
      return new Promise<void>((resolve) => response.once("close", resolve))
    })

    const client = yield* OidcClient
    const failureFiber = yield* Effect.flip(
      client.revoke({ ...configuration(), issuer: delayedIssuer }, Redacted.make("access-token")),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(requestStarted)
    yield* TestClock.adjust("30 seconds")
    const failure = yield* Fiber.join(failureFiber)

    expect(failure).toBeInstanceOf(AuthenticationFailed)
    expect(failure.operation).toBe("OidcClient.revoke")
    expect(failure.reason).toBe("timed out after 30 seconds")
  }).pipe(Effect.provide(liveOidcClientLayer), Effect.provide(receiverLayer)),
)

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
