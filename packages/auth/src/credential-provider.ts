import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Clock, Context, Effect, Layer, Redacted, Ref, Semaphore } from "effect"

import type { AuthenticationFailed, MissingCredential, SecretStoreError } from "./errors.js"
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

export interface OidcOptions {
  readonly config: OidcConfiguration
  readonly credentialKeyPrefix: string
}

export const oidcCredentialLayer = ({
  config,
  credentialKeyPrefix,
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
      const refreshKey = `${credentialKeyPrefix}.refresh_token`
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
        yield* secrets.remove(refreshKey)
        if (storedRefresh !== undefined) {
          yield* client.revoke(config, Redacted.make(storedRefresh))
        }
      })

      return CredentialProvider.of({ accessToken, login, logout })
    }),
  )
