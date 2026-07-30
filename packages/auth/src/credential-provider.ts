import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Clock, Context, Effect, Encoding, Layer, Redacted, Ref, Semaphore } from "effect"

import { MissingCredential } from "./errors.js"
import type { AuthenticationFailed, SecretStoreError } from "./errors.js"
import { AssertionProvider, OidcClient, SecretStore } from "./ports.js"

export type CredentialError = AuthenticationFailed | MissingCredential | SecretStoreError

export interface Interface {
  readonly accessToken: () => Effect.Effect<Redacted.Redacted<string>, CredentialError>
  readonly login: () => Effect.Effect<void, CredentialError>
  readonly logout: () => Effect.Effect<void, CredentialError>
}

export class CredentialProvider extends Context.Service<CredentialProvider, Interface>()(
  "@lumen-build/sync/CredentialProvider",
) {}

export interface BearerOptions {
  readonly token: Effect.Effect<Redacted.Redacted<string>, MissingCredential | SecretStoreError>
}

export const bearerCredentialLayer = ({ token }: BearerOptions): Layer.Layer<CredentialProvider> =>
  Layer.succeed(
    CredentialProvider,
    CredentialProvider.of({
      accessToken: Effect.fn("CredentialProvider.bearer.accessToken")(() => token),
      login: Effect.fn("CredentialProvider.bearer.login")(function* () {
        yield* token
      }),
      logout: Effect.fn("CredentialProvider.bearer.logout")(() => Effect.void),
    }),
  )

export interface StoredBearerOptions {
  readonly credentialKey?: string
  readonly token: Effect.Effect<Redacted.Redacted<string> | undefined>
}

export const storedBearerCredentialLayer = ({
  credentialKey = "lumen.sync.bearer_token",
  token,
}: StoredBearerOptions): Layer.Layer<CredentialProvider, never, SecretStore> =>
  Layer.effect(
    CredentialProvider,
    Effect.gen(function* () {
      const secrets = yield* SecretStore
      const accessToken = Effect.fn("CredentialProvider.bearer.stored.accessToken")(function* () {
        const live = yield* token
        if (live !== undefined) return live
        const stored = yield* secrets.get(credentialKey)
        if (stored === undefined || stored.length === 0) {
          return yield* new MissingCredential({
            source: "LUMEN_BEARER_TOKEN or stored bearer login",
          })
        }
        return Redacted.make(stored)
      })
      const login = Effect.fn("CredentialProvider.bearer.stored.login")(function* () {
        const live = yield* token
        if (live === undefined || Redacted.value(live).length === 0) {
          return yield* new MissingCredential({ source: "LUMEN_BEARER_TOKEN" })
        }
        yield* secrets.set(credentialKey, Redacted.value(live))
      })
      const logout = Effect.fn("CredentialProvider.bearer.stored.logout")(() =>
        secrets.remove(credentialKey),
      )
      return CredentialProvider.of({ accessToken, login, logout })
    }),
  )

export interface OidcOptions {
  readonly config: OidcConfiguration
  readonly credentialNamespace?: string
}

export const oidcRefreshTokenKey = (
  config: OidcConfiguration,
  credentialNamespace = "lumen.sync",
): string => {
  const binding = JSON.stringify([
    config.issuer.replace(/\/+$/u, ""),
    config.clientId,
    config.audience ?? "",
  ])
  return `${credentialNamespace}.${Encoding.encodeBase64Url(
    new TextEncoder().encode(binding),
  )}.refresh_token`
}

export const oidcCredentialLayer = ({
  config,
  credentialNamespace,
}: OidcOptions): Layer.Layer<
  CredentialProvider,
  never,
  AssertionProvider | OidcClient | SecretStore
> =>
  Layer.effect(
    CredentialProvider,
    Effect.gen(function* () {
      const assertions = yield* AssertionProvider
      const client = yield* OidcClient
      const secrets = yield* SecretStore
      const refreshKey = oidcRefreshTokenKey(config, credentialNamespace)
      const cached = yield* Ref.make<
        | {
            readonly accessToken: Redacted.Redacted<string>
            readonly expiresAt: number
          }
        | undefined
      >(undefined)
      const accessLock = yield* Semaphore.make(1)

      const persistRefresh = Effect.fn("CredentialProvider.oidc.persistRefresh")(function* (
        tokenSet: { readonly refreshToken?: Redacted.Redacted<string> },
        previous?: string,
      ) {
        const next =
          tokenSet.refreshToken === undefined ? undefined : Redacted.value(tokenSet.refreshToken)
        if (next !== undefined && next !== previous) {
          yield* secrets.set(refreshKey, next)
        }
      })

      const cacheToken = Effect.fn("CredentialProvider.oidc.cacheToken")(function* (tokenSet: {
        readonly accessToken: Redacted.Redacted<string>
        readonly expiresAt?: number
      }) {
        if (tokenSet.expiresAt !== undefined) {
          yield* Ref.set(cached, {
            accessToken: tokenSet.accessToken,
            expiresAt: tokenSet.expiresAt,
          })
        }
      })

      const accessToken = Effect.fn("CredentialProvider.oidc.accessToken")(() =>
        accessLock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(cached)
            const now = yield* Clock.currentTimeMillis
            if (current !== undefined && current.expiresAt > now + 30_000) {
              return current.accessToken
            }

            const storedRefresh = yield* secrets.get(refreshKey)
            if (storedRefresh !== undefined) {
              const tokenSet = yield* client.refresh(config, Redacted.make(storedRefresh))
              yield* persistRefresh(tokenSet, storedRefresh)
              yield* cacheToken(tokenSet)
              return tokenSet.accessToken
            }

            const assertion = yield* assertions.get(config.audience)
            const tokenSet = yield* client.exchangeAssertion(config, assertion)
            yield* persistRefresh(tokenSet)
            yield* cacheToken(tokenSet)
            return tokenSet.accessToken
          }),
        ),
      )

      const login = Effect.fn("CredentialProvider.oidc.login")(function* () {
        const tokenSet = yield* client.authorize(config)
        yield* persistRefresh(tokenSet)
        yield* cacheToken(tokenSet)
      })

      const logout = Effect.fn("CredentialProvider.oidc.logout")(function* () {
        const storedRefresh = yield* secrets.get(refreshKey)
        yield* Ref.set(cached, undefined)
        if (storedRefresh !== undefined) {
          yield* client.revoke(config, Redacted.make(storedRefresh))
        }
        yield* secrets.remove(refreshKey)
      })

      return CredentialProvider.of({ accessToken, login, logout })
    }),
  )
