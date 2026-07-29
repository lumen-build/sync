import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Effect, Layer, Redacted, Ref } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import {
  AssertionProvider,
  CredentialProvider,
  MissingCredential,
  OidcClient,
  SecretStore,
  bearerCredentialLayer,
  oidcCredentialLayer,
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

it.effect("uses a stored refresh token locally and a JWT assertion in CI", () =>
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider

    const refreshed = yield* credentials.accessToken()
    expect(Redacted.value(refreshed)).toBe("refreshed-access")

    yield* credentials.logout()
    const exchanged = yield* credentials.accessToken()
    expect(Redacted.value(exchanged)).toBe("ci-access")

    const secrets = yield* SecretStore
    expect(yield* secrets.get("oidc.refresh_token")).toBeUndefined()
  }).pipe(
    Effect.provide(
      oidcCredentialLayer({
        config: oidc,
        credentialKeyPrefix: "oidc",
      }),
    ),
    Effect.provide(
      Layer.effect(
        SecretStore,
        Effect.gen(function* () {
          const values = yield* Ref.make(
            new Map<string, string>([["oidc.refresh_token", "stored-refresh"]]),
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
