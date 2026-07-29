import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import {
  InvalidConfiguration,
  MissingConfiguration,
  decode,
  decodeWithEnvironment,
  load,
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

it.effect("accepts collector listen URLs at the origin root", () =>
  Effect.gen(function* () {
    for (const listenUrl of ["http://127.0.0.1:4318", "http://localhost:4318/"]) {
      const config = yield* decode({
        collector: { listen_url: listenUrl },
      })

      expect(config.collector?.listenUrl).toBe(listenUrl)
    }
  }),
)

it.effect("rejects collector listen URLs with unsupported TOML URL components", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-config-"))),
    (directory) =>
      Effect.gen(function* () {
        const path = join(directory, "config.toml")
        const invalidListenUrls = [
          "http://127.0.0.1:4318/v1/traces",
          "http://127.0.0.1:4318?transport=http",
          "http://127.0.0.1:4318#collector",
          "http://user:password@127.0.0.1:4318",
        ]

        for (const listenUrl of invalidListenUrls) {
          yield* Effect.promise(() =>
            writeFile(path, ["[collector]", `listen_url = "${listenUrl}"`, ""].join("\n")),
          )

          const failure = yield* Effect.flip(load({ environment: {}, path }))
          expect(failure).toBeInstanceOf(InvalidConfiguration)
        }
      }),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  ),
)

it.effect("rejects collector environment overrides with unsupported URL components", () =>
  Effect.gen(function* () {
    const invalidListenUrls = [
      "http://localhost:4318/v1/traces",
      "http://localhost:4318?transport=http",
      "http://localhost:4318#collector",
      "http://user:password@localhost:4318",
    ]

    for (const listenUrl of invalidListenUrls) {
      const failure = yield* Effect.flip(
        decodeWithEnvironment(
          { collector: { listen_url: "http://127.0.0.1:4318" } },
          { LUMEN_COLLECTOR_LISTEN_URL: listenUrl },
        ),
      )

      expect(failure).toBeInstanceOf(InvalidConfiguration)
    }
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

it.effect("loads TOML while letting the environment override it", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-config-"))),
    (directory) =>
      Effect.gen(function* () {
        const path = join(directory, "config.toml")
        yield* Effect.promise(() =>
          writeFile(
            path,
            [
              "[destination]",
              'base_url = "https://old.lumen.build"',
              "",
              "[privacy]",
              'mode = "usage-only"',
              "",
            ].join("\n"),
          ),
        )
        const configuration = yield* load({
          environment: {
            LUMEN_DESTINATION_BASE_URL: "https://usage.lumen.build",
          },
          path,
        })
        expect(configuration.destination?.baseUrl).toBe("https://usage.lumen.build")
      }),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  ),
)
