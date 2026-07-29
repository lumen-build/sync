import type { OidcConfiguration } from "@lumen-build/sync-config"
import { Context, type Effect, type Redacted } from "effect"

import type { AuthenticationFailed, MissingCredential, SecretStoreError } from "./errors.js"

export interface TokenSet {
  readonly accessToken: Redacted.Redacted<string>
  readonly refreshToken?: Redacted.Redacted<string>
}

export interface SecretStoreInterface {
  readonly get: (key: string) => Effect.Effect<string | undefined, SecretStoreError>
  readonly remove: (key: string) => Effect.Effect<void, SecretStoreError>
  readonly set: (key: string, value: string) => Effect.Effect<void, SecretStoreError>
}

export class SecretStore extends Context.Service<SecretStore, SecretStoreInterface>()(
  "@lumen-build/sync/SecretStore",
) {}

export interface AssertionProviderInterface {
  readonly get: (
    audience?: string,
  ) => Effect.Effect<Redacted.Redacted<string>, MissingCredential | AuthenticationFailed>
}

export class AssertionProvider extends Context.Service<
  AssertionProvider,
  AssertionProviderInterface
>()("@lumen-build/sync/AssertionProvider") {}

export interface OidcClientInterface {
  readonly authorize: (config: OidcConfiguration) => Effect.Effect<TokenSet, AuthenticationFailed>
  readonly exchangeAssertion: (
    config: OidcConfiguration,
    assertion: Redacted.Redacted<string>,
  ) => Effect.Effect<TokenSet, AuthenticationFailed>
  readonly refresh: (
    config: OidcConfiguration,
    refreshToken: Redacted.Redacted<string>,
  ) => Effect.Effect<TokenSet, AuthenticationFailed>
  readonly revoke: (
    config: OidcConfiguration,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AuthenticationFailed>
}

export class OidcClient extends Context.Service<OidcClient, OidcClientInterface>()(
  "@lumen-build/sync/OidcClient",
) {}
