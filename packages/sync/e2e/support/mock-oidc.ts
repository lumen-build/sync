import { Effect, Schema } from "effect"
import { Events, OAuth2Server } from "oauth2-mock-server"

export class MockOidcError extends Schema.TaggedErrorClass<MockOidcError>()("MockOidcError", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

export interface MockOidc {
  readonly assertion: string
  readonly issuer: string
  readonly refreshToken: string
  readonly revocations: ReadonlyArray<string>
}

const oidcError = (operation: string, cause: unknown): MockOidcError =>
  new MockOidcError({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

export const mockOidc = Effect.acquireRelease(
  Effect.gen(function* () {
    const server = new OAuth2Server()
    const refreshToken = "e2e-refresh-token"
    const revocations: Array<string> = []
    yield* Effect.tryPromise({
      try: async () => {
        await server.issuer.keys.generate("RS256")
        await server.start(undefined, "127.0.0.1")
      },
      catch: (cause) => oidcError("start mock OIDC server", cause),
    })
    server.service.on(Events.BeforeResponse, (response) => {
      if (typeof response.body === "object" && response.body !== null) {
        response.body = { ...response.body, refresh_token: refreshToken }
      }
    })
    server.service.on(Events.BeforeRevoke, (_response, request) => {
      revocations.push(request.url ?? "/revoke")
    })
    const assertion = yield* Effect.tryPromise({
      try: () =>
        server.issuer.buildToken({
          scopesOrTransform: (_header, payload) => {
            payload.aud = "https://usage.lumen.build"
            payload.sub = "ci-e2e"
          },
        }),
      catch: (cause) => oidcError("build mock OIDC assertion", cause),
    })
    const issuer = server.issuer.url
    if (issuer === undefined) {
      return yield* new MockOidcError({
        operation: "read mock OIDC issuer",
        reason: "server did not publish its issuer URL",
      })
    }
    return {
      public: {
        assertion,
        issuer,
        refreshToken,
        revocations,
      } satisfies MockOidc,
      shutdown: Effect.tryPromise({
        try: () => server.stop(),
        catch: (cause) => oidcError("stop mock OIDC server", cause),
      }),
    }
  }),
  ({ shutdown }) => shutdown.pipe(Effect.ignore),
).pipe(Effect.map(({ public: value }) => value))
