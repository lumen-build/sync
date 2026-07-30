import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Effect, Layer, Redacted, Ref } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import {
  AssertionProvider,
  AuthenticationFailed,
  CredentialProvider,
  MissingCredential,
  OidcClient,
  SecretStore,
  bearerCredentialLayer,
  oidcCredentialLayer,
  oidcRefreshTokenKey,
  storedBearerCredentialLayer,
} from "./index.js"

const oidc: OidcConfiguration = {
  audience: "https://usage.lumen.build",
  clientId: "sync-cli",
  issuer: "https://identity.lumen.build",
  redirectUri: "http://127.0.0.1:9876/callback",
  scopes: ["openid", "offline_access"],
  validation: "jwks",
}

it.effect("reads bearer credentials from an injected secret source", () =>
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider
    const token = yield* credentials.accessToken()
    expect(Redacted.value(token)).toBe("opaque-token")
  }).pipe(
    Effect.provide(
      bearerCredentialLayer({
        token: Effect.succeed(Redacted.make("opaque-token")),
      }),
    ),
  ),
)

it.effect("fails safely when no bearer credential is available", () =>
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider
    const failure = yield* Effect.flip(credentials.accessToken())
    expect(failure).toBeInstanceOf(MissingCredential)
  }).pipe(
    Effect.provide(
      bearerCredentialLayer({
        token: Effect.fail(new MissingCredential({ source: "environment" })),
      }),
    ),
  ),
)

it.effect("persists a bearer login for a clean background-service environment", () =>
  Effect.gen(function* () {
    const liveToken = yield* Ref.make<Redacted.Redacted<string> | undefined>(
      Redacted.make("service-token"),
    )
    const values = yield* Ref.make(new Map<string, string>())
    const secrets = Layer.succeed(
      SecretStore,
      SecretStore.of({
        get: (key) => Ref.get(values).pipe(Effect.map((entries) => entries.get(key))),
        remove: (key) =>
          Ref.update(values, (entries) => {
            const next = new Map(entries)
            next.delete(key)
            return next
          }),
        set: (key, value) => Ref.update(values, (entries) => new Map(entries).set(key, value)),
      }),
    )
    const layer = storedBearerCredentialLayer({
      credentialKey: "bearer",
      token: Ref.get(liveToken),
    }).pipe(Layer.provide(secrets))

    yield* Effect.gen(function* () {
      const credentials = yield* CredentialProvider
      yield* credentials.login()
      yield* Ref.set(liveToken, undefined)
      expect(Redacted.value(yield* credentials.accessToken())).toBe("service-token")
      yield* credentials.logout()
      expect(yield* Effect.flip(credentials.accessToken())).toBeInstanceOf(MissingCredential)
    }).pipe(Effect.provide(layer))
  }),
)

it("scopes refresh-token keys to the OIDC provider and client", () => {
  const original = oidcRefreshTokenKey(oidc, "oidc")
  expect(
    oidcRefreshTokenKey(
      {
        ...oidc,
        clientId: "replacement-client",
        issuer: "https://replacement-identity.lumen.build",
      },
      "oidc",
    ),
  ).not.toBe(original)
})

it.effect("uses a stored refresh token locally and a JWT assertion in CI", () =>
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider

    const refreshed = yield* credentials.accessToken()
    expect(Redacted.value(refreshed)).toBe("refreshed-access")

    yield* credentials.logout()
    const exchanged = yield* credentials.accessToken()
    expect(Redacted.value(exchanged)).toBe("ci-access")

    const secrets = yield* SecretStore
    expect(yield* secrets.get(oidcRefreshTokenKey(oidc, "oidc"))).toBeUndefined()
  }).pipe(
    Effect.provide(
      oidcCredentialLayer({
        config: oidc,
        credentialNamespace: "oidc",
      }),
    ),
    Effect.provide(
      Layer.effect(
        SecretStore,
        Effect.gen(function* () {
          const values = yield* Ref.make(
            new Map<string, string>([[oidcRefreshTokenKey(oidc, "oidc"), "stored-refresh"]]),
          )
          return SecretStore.of({
            get: (key) => Ref.get(values).pipe(Effect.map((map) => map.get(key))),
            remove: (key) =>
              Ref.update(values, (map) => {
                const next = new Map(map)
                next.delete(key)
                return next
              }),
            set: (key, value) => Ref.update(values, (map) => new Map(map).set(key, value)),
          })
        }),
      ),
    ),
    Effect.provide(
      Layer.succeed(
        AssertionProvider,
        AssertionProvider.of({
          get: () => Effect.succeed(Redacted.make("ci-assertion")),
        }),
      ),
    ),
    Effect.provide(
      Layer.succeed(
        OidcClient,
        OidcClient.of({
          authorize: () =>
            Effect.succeed({
              accessToken: Redacted.make("interactive-access"),
              refreshToken: Redacted.make("interactive-refresh"),
            }),
          exchangeAssertion: (_config, assertion) => {
            expect(Redacted.value(assertion)).toBe("ci-assertion")
            return Effect.succeed({ accessToken: Redacted.make("ci-access") })
          },
          refresh: (_config, token) => {
            expect(Redacted.value(token)).toBe("stored-refresh")
            return Effect.succeed({
              accessToken: Redacted.make("refreshed-access"),
              refreshToken: Redacted.make("rotated-refresh"),
            })
          },
          revoke: () => Effect.void,
        }),
      ),
    ),
  ),
)

it.effect("retains a refresh token after failed revocation so logout can retry", () => {
  const refreshKey = oidcRefreshTokenKey(oidc, "oidc")
  let revocations = 0
  return Effect.gen(function* () {
    const credentials = yield* CredentialProvider
    const failure = yield* Effect.flip(credentials.logout())
    expect(failure).toBeInstanceOf(AuthenticationFailed)

    const secrets = yield* SecretStore
    expect(yield* secrets.get(refreshKey)).toBe("stored-refresh")
    yield* credentials.logout()
    expect(yield* secrets.get(refreshKey)).toBeUndefined()
    expect(revocations).toBe(2)
  }).pipe(
    Effect.provide(
      oidcCredentialLayer({
        config: oidc,
        credentialNamespace: "oidc",
      }),
    ),
    Effect.provide(
      Layer.effect(
        SecretStore,
        Effect.gen(function* () {
          const values = yield* Ref.make(new Map<string, string>([[refreshKey, "stored-refresh"]]))
          return SecretStore.of({
            get: (key) => Ref.get(values).pipe(Effect.map((map) => map.get(key))),
            remove: (key) =>
              Ref.update(values, (map) => {
                const next = new Map(map)
                next.delete(key)
                return next
              }),
            set: (key, value) => Ref.update(values, (map) => new Map(map).set(key, value)),
          })
        }),
      ),
    ),
    Effect.provide(
      Layer.succeed(
        AssertionProvider,
        AssertionProvider.of({
          get: () => Effect.succeed(Redacted.make("unused-assertion")),
        }),
      ),
    ),
    Effect.provide(
      Layer.succeed(
        OidcClient,
        OidcClient.of({
          authorize: () => Effect.die("not used"),
          exchangeAssertion: () => Effect.die("not used"),
          refresh: () => Effect.die("not used"),
          revoke: () =>
            Effect.suspend(() => {
              revocations += 1
              return revocations === 1
                ? Effect.fail(
                    new AuthenticationFailed({
                      operation: "test revoke",
                      reason: "identity provider unavailable",
                    }),
                  )
                : Effect.void
            }),
        }),
      ),
    ),
  )
})
