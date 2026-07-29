import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Context, Effect, Layer, Redacted } from "effect"

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

      const persistRefresh = Effect.fn("CredentialProvider.oidc.persistRefresh")(
        function* (tokenSet: { readonly refreshToken?: Redacted.Redacted<string> }) {
          if (tokenSet.refreshToken !== undefined) {
            yield* secrets.set(refreshKey, Redacted.value(tokenSet.refreshToken))
          }
        },
      )

      const accessToken = Effect.fn("CredentialProvider.oidc.accessToken")(function* () {
        const storedRefresh = yield* secrets.get(refreshKey)
        if (storedRefresh !== undefined) {
          const tokenSet = yield* client.refresh(config, Redacted.make(storedRefresh))
          yield* persistRefresh(tokenSet)
          return tokenSet.accessToken
        }

        const assertion = yield* assertions.get(config.audience)
        const tokenSet = yield* client.exchangeAssertion(config, assertion)
        yield* persistRefresh(tokenSet)
        return tokenSet.accessToken
      })

      const login = Effect.fn("CredentialProvider.oidc.login")(function* () {
        const tokenSet = yield* client.authorize(config)
        yield* persistRefresh(tokenSet)
      })

      const logout = Effect.fn("CredentialProvider.oidc.logout")(function* () {
        const storedRefresh = yield* secrets.get(refreshKey)
        yield* secrets.remove(refreshKey)
        if (storedRefresh !== undefined) {
          yield* client.revoke(config, Redacted.make(storedRefresh))
        }
      })

      return CredentialProvider.of({ accessToken, login, logout })
    }),
  )
