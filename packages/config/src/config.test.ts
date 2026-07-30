import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import {
  ConfigurationInitError,
  InvalidConfiguration,
  MissingConfiguration,
  decode,
  decodeWithEnvironment,
  initialize,
  load,
  requireCollector,
  resolveConfigPath,
  resolveRuntimePaths,
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

it.effect("rejects credentials embedded in destination and OIDC URLs", () =>
  Effect.gen(function* () {
    const inputs = [
      {
        auth: {
          mode: "oidc",
          oidc: {
            client_id: "client",
            issuer: "https://user:password@identity.lumen.build",
            redirect_uri: "http://127.0.0.1:9876/callback",
            scopes: ["openid"],
            validation: "jwks",
          },
        },
      },
      {
        auth: {
          mode: "oidc",
          oidc: {
            client_id: "client",
            issuer: "https://identity.lumen.build",
            redirect_uri: "http://user:password@127.0.0.1:9876/callback",
            scopes: ["openid"],
            validation: "jwks",
          },
        },
      },
      { destination: { base_url: "https://user:password@usage.lumen.build" } },
    ]

    for (const input of inputs) {
      expect(yield* Effect.flip(decode(input))).toBeInstanceOf(InvalidConfiguration)
    }
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
  ).pipe(Effect.provide(BunServices.layer)),
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

it.effect("rejects removed privacy and model catalog settings", () =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(decode({ privacy: { mode: "usage-only" } }))).toBeInstanceOf(
      InvalidConfiguration,
    )
    expect(
      yield* Effect.flip(decode({ model_catalog: { url: "https://usage.lumen.build" } })),
    ).toBeInstanceOf(InvalidConfiguration)
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

it.effect("rejects credentialed URL environment overrides", () =>
  Effect.gen(function* () {
    for (const environment of [
      { LUMEN_DESTINATION_BASE_URL: "https://user:password@usage.lumen.build" },
      {
        LUMEN_AUTH_MODE: "oidc",
        LUMEN_OIDC_CLIENT_ID: "client",
        LUMEN_OIDC_ISSUER: "https://user:password@identity.lumen.build",
        LUMEN_OIDC_REDIRECT_URI: "http://127.0.0.1:9876/callback",
        LUMEN_OIDC_SCOPES: "openid",
        LUMEN_OIDC_VALIDATION: "jwks",
      },
    ]) {
      expect(yield* Effect.flip(decodeWithEnvironment({}, environment))).toBeInstanceOf(
        InvalidConfiguration,
      )
    }
  }),
)

it("uses XDG on Unix and APPDATA on Windows", () => {
  expect(
    resolveConfigPath({
      environment: { XDG_CONFIG_HOME: "/tmp/config" },
      homeDirectory: "/home/dev",
      platform: "linux",
    }),
  ).toBe("/tmp/config/lumen-build/sync/config.toml")

  expect(
    resolveConfigPath({
      environment: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\dev",
      platform: "win32",
    }),
  ).toBe("C:\\Users\\dev\\AppData\\Roaming\\lumen-build\\sync\\config.toml")
})

it("separates default state and data while isolating explicit configuration", () => {
  expect(
    resolveRuntimePaths({
      host: {
        configHome: "/home/dev/.config",
        dataHome: "/home/dev/.local/share",
        homeDirectory: "/home/dev",
        platform: "linux",
        stateHome: "/home/dev/.local/state",
      },
    }),
  ).toEqual({
    collectorStateFile: "/home/dev/.local/state/lumen-build/sync/collector.json",
    configDirectory: "/home/dev/.config/lumen-build/sync",
    configFile: "/home/dev/.config/lumen-build/sync/config.toml",
    credentialsFile: "/home/dev/.local/share/lumen-build/sync/credentials.json",
    dailySyncDirectory: "/home/dev/.local/state/lumen-build/sync/daily-sync",
    deviceIdFile: "/home/dev/.local/share/lumen-build/sync/device-id",
    harnessOwnershipFile: "/home/dev/.config/lumen-build/sync/harness-ownership.json",
    serviceStateDirectory: "/home/dev/.local/state/lumen-build/sync/service",
    stateDirectory: "/home/dev/.local/state/lumen-build/sync",
  })

  expect(
    resolveRuntimePaths({
      configPath: "/tmp/lumen/config.toml",
      host: { homeDirectory: "/home/dev", platform: "linux" },
    }),
  ).toEqual({
    collectorStateFile: "/tmp/lumen/state/collector.json",
    configDirectory: "/tmp/lumen",
    configFile: "/tmp/lumen/config.toml",
    credentialsFile: "/tmp/lumen/credentials.json",
    dailySyncDirectory: "/tmp/lumen/state/daily-sync",
    deviceIdFile: "/tmp/lumen/device-id",
    harnessOwnershipFile: "/tmp/lumen/harness-ownership.json",
    serviceStateDirectory: "/tmp/lumen/state/service",
    stateDirectory: "/tmp/lumen/state",
  })

  expect(
    resolveRuntimePaths({
      configPath: "config.toml",
      host: { homeDirectory: "/home/dev", platform: "linux" },
    }),
  ).toMatchObject({
    configDirectory: ".",
    configFile: "config.toml",
    credentialsFile: "./credentials.json",
    stateDirectory: "./state",
  })

  expect(
    resolveRuntimePaths({
      configPath: "config.toml",
      host: { homeDirectory: "C:\\Users\\dev", platform: "win32" },
    }),
  ).toMatchObject({
    configDirectory: ".",
    configFile: "config.toml",
    credentialsFile: ".\\credentials.json",
    stateDirectory: ".\\state",
  })
})

it.effect("loads TOML while letting the environment override it", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-config-"))),
    (directory) =>
      Effect.gen(function* () {
        const path = join(directory, "config.toml")
        yield* Effect.promise(() =>
          writeFile(path, ["[destination]", 'base_url = "https://old.lumen.build"', ""].join("\n")),
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
  ).pipe(Effect.provide(BunServices.layer)),
)

it.effect("initializes explicit usage-only configuration without persisting bearer secrets", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-config-"))),
    (directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = join(directory, "config.toml")
        const created = yield* initialize({
          auth: { mode: "bearer" },
          collectorListenUrl: "http://127.0.0.1:4318",
          destinationBaseUrl: "https://usage.lumen.build",
          path,
        })
        expect(created.path).toBe(path)

        const configuration = yield* load({
          environment: { LUMEN_BEARER_TOKEN: "must-not-be-persisted" },
          path,
        })
        expect(configuration).toEqual({
          auth: { mode: "bearer" },
          collector: { listenUrl: "http://127.0.0.1:4318" },
          destination: { baseUrl: "https://usage.lumen.build" },
        })
        const contents = yield* fs.readFileString(path)
        expect(contents).not.toContain("must-not-be-persisted")

        const failure = yield* Effect.flip(
          initialize({
            collectorListenUrl: "http://127.0.0.1:4318",
            path,
          }),
        )
        expect(failure).toBeInstanceOf(ConfigurationInitError)
      }),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  ).pipe(Effect.provide(BunServices.layer)),
)

it.effect("rejects a destination without matching authentication during init", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      initialize({
        collectorListenUrl: "http://127.0.0.1:4318",
        destinationBaseUrl: "https://usage.lumen.build",
        path: "/tmp/unused-config.toml",
      }),
    )
    expect(failure).toBeInstanceOf(InvalidConfiguration)
  }).pipe(Effect.provide(BunServices.layer)),
)
