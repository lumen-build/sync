import { Effect, Schema } from "effect"
import { Events, OAuth2Server } from "oauth2-mock-server"

export class MockOidcError extends Schema.TaggedError<MockOidcError>()("MockOidcError", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

export interface MockCiAssertionRequest {
  readonly audience: string | null
  readonly authorization: string | null
}

export interface MockTokenRequest {
  readonly accessToken: string | undefined
  readonly grantType: string | undefined
  readonly refreshToken: string | undefined
}

export interface MockOidc {
  readonly assertion: string
  readonly ciAssertionRequests: ReadonlyArray<MockCiAssertionRequest>
  readonly ciAssertionUrl: string
  readonly issuer: string
  readonly refreshToken: string
  readonly revocations: ReadonlyArray<string>
  readonly tokenRequests: ReadonlyArray<MockTokenRequest>
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
    const tokenRequests: Array<MockTokenRequest> = []
    const ciAssertionRequests: Array<MockCiAssertionRequest> = []
    yield* Effect.tryPromise({
      try: async () => {
        await server.issuer.keys.generate("RS256")
        await server.start(undefined, "127.0.0.1")
      },
      catch: (cause) => oidcError("start mock OIDC server", cause),
    })
    server.service.on(Events.BeforeResponse, (response, request) => {
      if (typeof response.body === "object" && response.body !== null) {
        const requestBody =
          typeof request.body === "object" && request.body !== null ? request.body : {}
        const grantType =
          "grant_type" in requestBody && typeof requestBody.grant_type === "string"
            ? requestBody.grant_type
            : undefined
        tokenRequests.push({
          accessToken:
            "access_token" in response.body && typeof response.body.access_token === "string"
              ? response.body.access_token
              : undefined,
          grantType,
          refreshToken:
            "refresh_token" in requestBody && typeof requestBody.refresh_token === "string"
              ? requestBody.refresh_token
              : undefined,
        })
        response.body = {
          ...response.body,
          expires_in: grantType === "authorization_code" ? 0 : 3_600,
          refresh_token: refreshToken,
        }
      }
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
    const providerIssuer = server.issuer.url
    if (providerIssuer === undefined) {
      return yield* new MockOidcError({
        operation: "read mock OIDC issuer",
        reason: "server did not publish its issuer URL",
      })
    }
    let facadeUrl = ""
    const facadeServer = yield* Effect.try({
      try: () =>
        Bun.serve({
          fetch: async (request) => {
            const url = new URL(request.url)
            if (url.pathname === "/oidc") {
              ciAssertionRequests.push({
                audience: url.searchParams.get("audience"),
                authorization: request.headers.get("authorization"),
              })
              return Response.json({ value: assertion })
            }
            if (url.pathname === "/.well-known/openid-configuration") {
              return Response.json({
                authorization_endpoint: `${providerIssuer}/authorize`,
                issuer: facadeUrl,
                jwks_uri: `${providerIssuer}/jwks`,
                revocation_endpoint: `${facadeUrl}/revoke`,
                token_endpoint: `${providerIssuer}/token`,
              })
            }
            if (url.pathname === "/revoke" && request.method === "POST") {
              const token = new URLSearchParams(await request.text()).get("token")
              if (token !== null) revocations.push(token)
              return new Response(null, { status: 200 })
            }
            return new Response("Not Found", { status: 404 })
          },
          hostname: "127.0.0.1",
          port: 0,
        }),
      catch: (cause) => oidcError("start mock OIDC facade", cause),
    })
    facadeUrl = `http://${facadeServer.hostname}:${facadeServer.port}`
    return {
      public: {
        assertion,
        ciAssertionRequests,
        ciAssertionUrl: `${facadeUrl}/oidc?existing=preserved`,
        issuer: facadeUrl,
        refreshToken,
        revocations,
        tokenRequests,
      } satisfies MockOidc,
      shutdown: Effect.sync(() => facadeServer.stop(true)).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => server.stop(),
            catch: (cause) => oidcError("stop mock OIDC server", cause),
          }),
        ),
      ),
    }
  }),
  ({ shutdown }) => shutdown.pipe(Effect.ignore),
).pipe(Effect.map(({ public: value }) => value))
