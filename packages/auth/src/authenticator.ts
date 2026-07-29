import { UsagePrincipal } from "@lumen-build/sync-contracts"
import type { UsagePrincipal as UsagePrincipalType } from "@lumen-build/sync-contracts"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { createRemoteJWKSet, jwtVerify } from "jose"

import { AuthenticationFailed } from "./errors.js"
import { discover } from "./oidc-client.js"

export interface Interface {
  readonly authenticate: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<UsagePrincipalType, AuthenticationFailed>
}

export class RequestAuthenticator extends Context.Service<RequestAuthenticator, Interface>()(
  "@lumen-build/sync/RequestAuthenticator",
) {}

export interface OidcJwtAuthenticatorOptions {
  readonly audience: string
  readonly issuer: string | (() => string)
}

export const oidcJwtAuthenticatorLayer = ({
  audience,
  issuer,
}: OidcJwtAuthenticatorOptions): Layer.Layer<RequestAuthenticator, AuthenticationFailed> =>
  Layer.effect(
    RequestAuthenticator,
    Effect.gen(function* () {
      const configuredIssuer = typeof issuer === "string" ? issuer : issuer()
      const discovery = yield* discover(configuredIssuer)
      const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri))

      const authenticate = Effect.fn("RequestAuthenticator.oidcJwt.authenticate")(function* (
        token: Redacted.Redacted<string>,
      ) {
        const verified = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(Redacted.value(token), jwks, {
              audience,
              issuer: configuredIssuer,
            }),
          catch: (cause) =>
            new AuthenticationFailed({
              operation: "RequestAuthenticator.oidcJwt.authenticate",
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        })
        if (verified.payload.sub === undefined || verified.payload.sub.length === 0) {
          return yield* new AuthenticationFailed({
            operation: "RequestAuthenticator.oidcJwt.authenticate",
            reason: "token does not contain a subject",
          })
        }

        return yield* Schema.decodeUnknownEffect(UsagePrincipal)({
          claims: verified.payload,
          scheme: "oidc",
          subjectId: verified.payload.sub,
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthenticationFailed({
                operation: "RequestAuthenticator.oidcJwt.decodePrincipal",
                reason: error.message,
              }),
          ),
        )
      })

      return RequestAuthenticator.of({ authenticate })
    }),
  )

export interface BearerAuthenticatorOptions {
  readonly verify: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<UsagePrincipalType, AuthenticationFailed>
}

export const bearerAuthenticatorLayer = ({
  verify,
}: BearerAuthenticatorOptions): Layer.Layer<RequestAuthenticator> =>
  Layer.succeed(
    RequestAuthenticator,
    RequestAuthenticator.of({
      authenticate: Effect.fn("RequestAuthenticator.bearer.authenticate")(verify),
    }),
  )

export interface OidcIntrospectionAuthenticatorOptions {
  readonly clientId?: string
  readonly issuer: string | (() => string)
  readonly subjectClaim: string
}

const IntrospectionClaims = Schema.Record(Schema.String, Schema.Unknown)

export const oidcIntrospectionAuthenticatorLayer = ({
  clientId,
  issuer,
  subjectClaim,
}: OidcIntrospectionAuthenticatorOptions): Layer.Layer<
  RequestAuthenticator,
  AuthenticationFailed
> =>
  Layer.effect(
    RequestAuthenticator,
    Effect.gen(function* () {
      const configuredIssuer = typeof issuer === "string" ? issuer : issuer()
      const discovery = yield* discover(configuredIssuer)
      if (discovery.introspection_endpoint === undefined) {
        return yield* new AuthenticationFailed({
          operation: "RequestAuthenticator.introspection.acquire",
          reason: "issuer does not advertise an introspection endpoint",
        })
      }
      const endpoint = discovery.introspection_endpoint

      const authenticate = Effect.fn("RequestAuthenticator.introspection.authenticate")(function* (
        token: Redacted.Redacted<string>,
      ) {
        const body = new URLSearchParams({ token: Redacted.value(token) })
        if (clientId !== undefined) body.set("client_id", clientId)
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(endpoint, {
              body,
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              method: "POST",
              signal,
            }),
          catch: (cause) =>
            new AuthenticationFailed({
              operation: "RequestAuthenticator.introspection.request",
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        })
        if (!response.ok) {
          return yield* new AuthenticationFailed({
            operation: "RequestAuthenticator.introspection.request",
            reason: `HTTP ${response.status}`,
          })
        }
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new AuthenticationFailed({
              operation: "RequestAuthenticator.introspection.decodeJson",
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        })
        const claims = yield* Schema.decodeUnknownEffect(IntrospectionClaims)(json).pipe(
          Effect.mapError(
            (error) =>
              new AuthenticationFailed({
                operation: "RequestAuthenticator.introspection.decode",
                reason: error.message,
              }),
          ),
        )
        if (claims.active !== true) {
          return yield* new AuthenticationFailed({
            operation: "RequestAuthenticator.introspection.authenticate",
            reason: "token is inactive",
          })
        }
        const subject = claims[subjectClaim]
        if (typeof subject !== "string" || subject.length === 0) {
          return yield* new AuthenticationFailed({
            operation: "RequestAuthenticator.introspection.authenticate",
            reason: `introspection response does not contain ${subjectClaim}`,
          })
        }

        return UsagePrincipal.make({
          claims,
          scheme: "oidc",
          subjectId: subject,
        })
      })

      return RequestAuthenticator.of({ authenticate })
    }),
  )
