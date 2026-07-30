import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"

import { browserCommand, environmentAssertionLayer, fileSecretStoreLayer } from "./adapters"
import { AuthenticationFailed } from "./errors"
import { AssertionProvider, SecretStore } from "./ports"

it("opens Windows URLs without a command shell", () => {
  const url =
    "https://identity.lumen.build/authorize?state=expected&next=^calc.exe|whoami>owned.txt"

  expect(browserCommand(url, "win32")).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", url])
})

it.effect("uses an explicit CI OIDC assertion without exposing it", () =>
  Effect.gen(function* () {
    const provider = yield* AssertionProvider
    const assertion = yield* provider.get("https://usage.lumen.build")
    expect(Redacted.value(assertion)).toBe("mocked-assertion")
    expect(String(assertion)).not.toContain("mocked-assertion")
  }).pipe(
    Effect.provide(
      environmentAssertionLayer({
        LUMEN_OIDC_ASSERTION: "mocked-assertion",
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
  ),
)

it.effect("requests a GitHub Actions OIDC assertion with its bearer token and audience", () => {
  let requestedAuthorization: string | undefined
  let requestedUrl: URL | undefined
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requestedAuthorization = request.headers.authorization
      requestedUrl = url
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ value: "mocked-github-assertion" }),
      )
    }),
  )

  return Effect.gen(function* () {
    const provider = yield* AssertionProvider
    const assertion = yield* provider.get("https://usage.lumen.build")

    expect(requestedAuthorization).toBe("Bearer mocked-github-request-token")
    expect(requestedUrl?.origin).toBe("https://github-actions.example")
    expect(requestedUrl?.pathname).toBe("/oidc")
    expect(requestedUrl?.searchParams.get("existing")).toBe("preserved")
    expect(requestedUrl?.searchParams.get("audience")).toBe("https://usage.lumen.build")
    expect(Redacted.value(assertion)).toBe("mocked-github-assertion")
    expect(String(assertion)).not.toContain("mocked-github-assertion")
  }).pipe(
    Effect.provide(
      environmentAssertionLayer({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "mocked-github-request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://github-actions.example/oidc?existing=preserved",
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, client),
  )
})

it.effect("reports non-success GitHub Actions OIDC responses as AuthenticationFailed", () =>
  Effect.gen(function* () {
    const provider = yield* AssertionProvider
    const failure = yield* Effect.flip(provider.get("https://usage.lumen.build"))

    expect(failure).toBeInstanceOf(AuthenticationFailed)
    if (!(failure instanceof AuthenticationFailed)) {
      throw new Error("expected AuthenticationFailed")
    }
    expect(failure.operation).toBe("request GitHub Actions OIDC assertion")
    expect(failure.reason).toBe("HTTP 403")
  }).pipe(
    Effect.provide(
      environmentAssertionLayer({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "mocked-github-request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://github-actions.example/oidc",
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ message: "forbidden" }, { status: 403 }),
          ),
        ),
      ),
    ),
  ),
)

it.effect("persists refresh tokens in a private file-backed store", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-secrets-"))),
    (directory) =>
      Effect.gen(function* () {
        const secretsPath = join(directory, "nested", "secrets.json")
        yield* Effect.promise(() => mkdir(join(directory, "nested")))
        const store = yield* SecretStore
        yield* store.set("refresh", "mocked-refresh")
        if (process.platform !== "win32") {
          const secretsStat = yield* Effect.promise(() => stat(secretsPath))
          expect(secretsStat.mode & 0o777).toBe(0o600)
        }
        expect(yield* store.get("refresh")).toBe("mocked-refresh")
        yield* store.remove("refresh")
        expect(yield* store.get("refresh")).toBeUndefined()
      }).pipe(
        Effect.provide(fileSecretStoreLayer(join(directory, "nested", "secrets.json"))),
        Effect.provide(BunServices.layer),
      ),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  ),
)
