import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import {
  InvalidConfiguration,
  MissingConfiguration,
  decode,
  decodeWithEnvironment,
  requireCollector,
  resolveConfigPath,
} from "./index.js"

it.effect("decodes explicit endpoint and OIDC settings without secret material", () =>
  Effect.gen(function* () {
    const config = yield* decode({
      auth: {
        mode: "oidc",
        oidc: {
          audience: "urn:usage",
          client_id: "lumen-cli",
          issuer: "https://identity.lumen.build",
          redirect_uri: "http://127.0.0.1:9876/callback",
          scopes: ["openid", "offline_access"],
          validation: "jwks",
        },
      },
      collector: { listen_url: "http://127.0.0.1:4318" },
      destination: { base_url: "https://usage.lumen.build" },
      privacy: { mode: "usage-only" },
    })

    expect(config).toEqual({
      auth: {
        mode: "oidc",
        oidc: {
          audience: "urn:usage",
          clientId: "lumen-cli",
          issuer: "https://identity.lumen.build",
          redirectUri: "http://127.0.0.1:9876/callback",
          scopes: ["openid", "offline_access"],
          validation: "jwks",
        },
      },
      collector: { listenUrl: "http://127.0.0.1:4318" },
      destination: { baseUrl: "https://usage.lumen.build" },
      privacy: { mode: "usage-only" },
    })
  }),
)

it.effect("rejects unknown keys and non-loopback plaintext endpoints", () =>
  Effect.gen(function* () {
    const unknown = yield* Effect.flip(
      decode({
        collector: {
          listen_url: "http://127.0.0.1:4318",
          surprise: true,
        },
      }),
    )
    expect(unknown).toBeInstanceOf(InvalidConfiguration)

    const insecure = yield* Effect.flip(
      decode({
        destination: { base_url: "http://usage.lumen.build" },
      }),
    )
    expect(insecure).toBeInstanceOf(InvalidConfiguration)
  }),
)

it.effect("fails only when a command requires an absent endpoint", () =>
  Effect.gen(function* () {
    const config = yield* decode({})
    const failure = yield* Effect.flip(requireCollector(config))
    expect(failure).toBeInstanceOf(MissingConfiguration)
  }),
)

it.effect("lets environment variables override TOML without accepting secrets into config", () =>
  Effect.gen(function* () {
    const config = yield* decodeWithEnvironment(
      {
        auth: { mode: "bearer" },
        destination: { base_url: "https://old.lumen.build" },
      },
      {
        LUMEN_AUTH_MODE: "oidc",
        LUMEN_BEARER_TOKEN: "must-not-be-copied",
        LUMEN_DESTINATION_BASE_URL: "https://new.lumen.build",
        LUMEN_OIDC_CLIENT_ID: "ci-client",
        LUMEN_OIDC_ISSUER: "https://identity.lumen.build",
        LUMEN_OIDC_REDIRECT_URI: "http://127.0.0.1:9876/callback",
        LUMEN_OIDC_SCOPES: "openid,offline_access",
        LUMEN_OIDC_VALIDATION: "introspection",
      },
    )

    expect(config.destination?.baseUrl).toBe("https://new.lumen.build")
    expect(config.auth).toEqual({
      mode: "oidc",
      oidc: {
        clientId: "ci-client",
        issuer: "https://identity.lumen.build",
        redirectUri: "http://127.0.0.1:9876/callback",
        scopes: ["openid", "offline_access"],
        validation: "introspection",
      },
    })
    expect(JSON.stringify(config)).not.toContain("must-not-be-copied")
  }),
)

it("uses XDG on Unix and APPDATA on Windows", () => {
  expect(
    resolveConfigPath({
      environment: { XDG_CONFIG_HOME: "/tmp/config" },
      homeDirectory: "/home/dev",
      platform: "linux",
    }),
  ).toBe("/tmp/config/lumen/config.toml")

  expect(
    resolveConfigPath({
      environment: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\dev",
      platform: "win32",
    }),
  ).toBe("C:\\Users\\dev\\AppData\\Roaming\\lumen\\config.toml")
})
