import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { expect, it } from "bun:test"
import { Effect } from "effect"

import { logFixture } from "./support/fixtures.js"
import { mockDestination } from "./support/mock-destination.js"
import { mockOidc, type MockOidc } from "./support/mock-oidc.js"
import {
  configArguments,
  isolatedEnvironment,
  nextCollectorEvent,
  packedCli,
  readyUrl,
  startCollector,
} from "./support/packed-cli.js"

const submitLog = (url: string, fixture: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${url}/v1/logs`, {
        body: JSON.stringify(fixture),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      })
      if (!response.ok) throw new Error(`collector returned ${response.status}`)
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const oidcConfiguration = (
  collectorUrl: string,
  destinationUrl: string,
  oidc: MockOidc,
  redirectPort = 45_678,
) =>
  [
    "[collector]",
    `listen_url = "${collectorUrl}"`,
    "",
    "[destination]",
    `base_url = "${destinationUrl}"`,
    "",
    "[auth]",
    'mode = "oidc"',
    "",
    "[auth.oidc]",
    'audience = "https://usage.lumen.build"',
    'client_id = "sync-e2e"',
    `issuer = "${oidc.issuer}"`,
    `redirect_uri = "http://127.0.0.1:${redirectPort}/callback"`,
    'scopes = ["openid", "offline_access"]',
    'validation = "jwks"',
    "",
  ].join("\n")

const claudeSession = (model: string, inputTokens: number) =>
  `${JSON.stringify({
    costUSD: 0.12,
    message: {
      id: `message-${model}`,
      model,
      role: "assistant",
      usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
        input_tokens: inputTokens,
        output_tokens: 3,
      },
    },
    requestId: `request-${model}`,
    sessionId: "lumen-sync-e2e",
    timestamp: "2026-01-09T10:00:00.000Z",
    version: "1.0.0",
  })}\n`

const unusedLoopbackPort = Effect.acquireUseRelease(
  Effect.sync(() =>
    Bun.serve({
      fetch: () => new Response("reserved"),
      hostname: "127.0.0.1",
      port: 0,
    }),
  ),
  (server) => Effect.succeed(server.port),
  (server) => Effect.sync(() => server.stop(true)),
)

it("runs the packed CLI without inventing a default endpoint", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* packedCli
        const destination = yield* mockDestination
        const home = yield* cli.makeHome("missing-endpoint")
        const configPath = join(home, "config.toml")
        yield* cli.write(configPath, "")

        const result = yield* cli.run(
          configArguments(configPath, "collector", "status"),
          isolatedEnvironment(home),
        )

        expect(result.exitCode).not.toBe(0)
        expect(result.events).toMatchObject([
          {
            command: "collector.status",
            error: {
              code: "Configuration.Missing",
              message: "Missing configuration: collector.listen_url",
            },
            protocolVersion: 1,
            type: "error",
          },
        ])
        expect(yield* destination.requests).toEqual([])

        yield* cli.write(
          configPath,
          ["[collector]", 'listen_url = "http://127.0.0.1:0"', ""].join("\n"),
        )
        const missingDestination = yield* cli.run(
          configArguments(configPath, "collector", "run", "--upload-interval", "1"),
          isolatedEnvironment(home),
        )
        expect(missingDestination.exitCode).not.toBe(0)
        expect(missingDestination.events).toMatchObject([
          {
            command: "collector.run",
            error: {
              code: "Configuration.Missing",
              message: "Missing configuration: destination.base_url",
            },
            type: "error",
          },
        ])
        expect(yield* destination.requests).toEqual([])
      }),
    ),
  )
}, 90_000)

it("stops a packed collector when its owning Effect scope fails", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* packedCli
        const destination = yield* mockDestination
        const home = yield* cli.makeHome("scoped-collector")
        const configPath = join(home, "config.toml")
        yield* cli.write(
          configPath,
          [
            "[collector]",
            'listen_url = "http://127.0.0.1:0"',
            "",
            "[destination]",
            `base_url = "${destination.url}"`,
            "",
            "[auth]",
            'mode = "bearer"',
            "",
          ].join("\n"),
        )
        const environment = isolatedEnvironment(home, {
          LUMEN_BEARER_TOKEN: "scoped-collector-token",
          LUMEN_DEVICE_ID: "43f75365-6c3a-409a-899f-b97eef60866f",
        })
        let abandonedUrl: string | undefined
        const failed = yield* Effect.scoped(
          Effect.gen(function* () {
            const collector = yield* startCollector(cli, configPath, environment)
            abandonedUrl = readyUrl(yield* nextCollectorEvent(collector, "ready"))
            return yield* Effect.fail(new Error("intentional failure after collector readiness"))
          }),
        ).pipe(Effect.result)

        expect(failed._tag).toBe("Failure")
        if (abandonedUrl === undefined) throw new Error("collector did not publish its URL")
        const releasedUrl = abandonedUrl
        const connection = yield* Effect.tryPromise({
          try: () =>
            fetch(releasedUrl, {
              signal: AbortSignal.timeout(1_000),
            }),
          catch: (cause) => cause,
        }).pipe(Effect.result)
        expect(connection._tag).toBe("Failure")
      }),
    ),
  )
}, 90_000)

it("uploads, retries, checkpoints, and deduplicates through the packed artifact", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* packedCli
        const destination = yield* mockDestination
        const home = yield* cli.makeHome("bearer-live")
        const configPath = join(home, "config.toml")
        const token = "e2e-bearer-token"
        yield* cli.write(
          configPath,
          [
            "[collector]",
            'listen_url = "http://127.0.0.1:9"',
            "",
            "[destination]",
            'base_url = "http://127.0.0.1:9"',
            "",
            "[auth]",
            'mode = "bearer"',
            "",
          ].join("\n"),
        )
        const environment = isolatedEnvironment(home, {
          LUMEN_BEARER_TOKEN: token,
          LUMEN_COLLECTOR_LISTEN_URL: "http://127.0.0.1:0",
          LUMEN_DESTINATION_BASE_URL: destination.url,
          LUMEN_DEVICE_ID: "ec7100cb-d60f-479a-a136-85327ec03f8b",
        })

        yield* destination.failNextLive()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const collector = yield* startCollector(cli, configPath, environment)
            const ready = yield* nextCollectorEvent(collector, "ready")
            const collectorUrl = readyUrl(ready)
            expect(collectorUrl).not.toContain(":9")

            yield* submitLog(collectorUrl, logFixture({ eventId: "event-1", input: 7, output: 3 }))
            yield* nextCollectorEvent(collector, "warning")

            const beforeCheckpoint = yield* cli.run(
              configArguments(configPath, "collector", "status"),
              environment,
            )
            expect(beforeCheckpoint.events[0]).toMatchObject({
              data: { checkpoint: false },
              type: "result",
            })

            yield* nextCollectorEvent(collector, "progress")
            const firstBatch = yield* destination.takeLive
            expect(firstBatch).toMatchObject({
              source: "otel-live",
              snapshots: [
                {
                  agent: "opencode",
                  model: "mock-model",
                  provider: "mock-provider",
                  revision: 1,
                  tokens: { input: 7, output: 3 },
                },
              ],
            })

            const afterCheckpoint = yield* cli.run(
              configArguments(configPath, "collector", "status"),
              environment,
            )
            expect(afterCheckpoint.events[0]).toMatchObject({
              data: { checkpoint: true },
              type: "result",
            })
            yield* collector.stop
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const collector = yield* startCollector(cli, configPath, environment)
            const collectorUrl = readyUrl(yield* nextCollectorEvent(collector, "ready"))

            yield* nextCollectorEvent(collector, "progress")
            yield* destination.takeLive
            yield* submitLog(collectorUrl, logFixture({ eventId: "event-1", input: 7, output: 3 }))
            yield* submitLog(
              collectorUrl,
              logFixture({
                eventId: "event-2",
                input: 5,
                output: 6,
                timeUnixNano: "1785319201000000000",
              }),
            )
            yield* nextCollectorEvent(collector, "progress")
            const cumulative = yield* destination.takeLive

            expect(cumulative.snapshots).toMatchObject([
              {
                revision: 2,
                tokens: { input: 12, output: 9 },
              },
            ])
            expect(yield* destination.canonicalSnapshots).toMatchObject([
              {
                revision: 2,
                tokens: { input: 12, output: 9 },
              },
            ])
            const requests = yield* destination.requests
            expect(requests.filter(({ status }) => status === 503)).toHaveLength(1)
            expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(
              true,
            )
            expect(JSON.stringify(requests)).not.toContain("event-1")
            yield* collector.stop
          }),
        )

        const shown = yield* cli.run(configArguments(configPath, "config", "show"), environment)
        expect(shown.exitCode).toBe(0)
        expect(shown.stdout).not.toContain(token)
      }),
    ),
  )
}, 90_000)

it("uses bundled ccusage and replays the journaled daily batch after a lost commit response", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* packedCli
        const destination = yield* mockDestination
        const home = yield* cli.makeHome("ccusage-daily")
        const configPath = join(home, "config.toml")
        const sessionPath = join(home, ".claude", "projects", "lumen-sync-e2e", "session.jsonl")
        yield* cli.write(
          configPath,
          [
            "[collector]",
            'listen_url = "http://127.0.0.1:0"',
            "",
            "[destination]",
            `base_url = "${destination.url}"`,
            "",
            "[auth]",
            'mode = "bearer"',
            "",
          ].join("\n"),
        )
        yield* cli.write(sessionPath, claudeSession("claude-sonnet-4-20250514", 7))
        const environment = isolatedEnvironment(home, {
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          LUMEN_BEARER_TOKEN: "daily-e2e-token",
          LUMEN_DEVICE_ID: "ac55f85f-bf24-4eaa-9f88-fb48abac12e6",
        })
        const commandArguments = configArguments(
          configPath,
          "sync",
          "daily",
          "--agent",
          "claude",
          "--since",
          "2026-01-09",
          "--until",
          "2026-01-09",
        )

        yield* destination.failNextDailyCommit()
        const failed = yield* cli.run(commandArguments, environment)
        expect(failed.exitCode).not.toBe(0)
        expect(failed.events).toMatchObject([
          {
            command: "sync.daily",
            error: { code: "InvalidDestinationResponse" },
            type: "error",
          },
        ])

        const journalDirectory = join(home, "state", "daily-sync")
        const pending = yield* Effect.promise(() => readdir(journalDirectory))
        expect(pending).toHaveLength(1)
        expect(
          (yield* Effect.promise(() => stat(join(journalDirectory, pending[0]!)))).mode & 0o777,
        ).toBe(0o600)

        yield* cli.write(sessionPath, claudeSession("changed-model-must-not-be-read", 999))
        const replayed = yield* cli.run(commandArguments, environment)
        expect(replayed.exitCode).toBe(0)
        expect(replayed.events).toMatchObject([
          {
            command: "sync.daily",
            data: {
              agent: "claude",
              committed: 1,
              snapshots: 1,
            },
            type: "result",
          },
        ])

        const batches = yield* destination.dailyBatches
        expect(batches).toHaveLength(2)
        expect(batches[1]).toEqual(batches[0])
        expect(batches[1]).toMatchObject({
          source: "ccusage-daily",
          snapshots: [
            {
              agent: "claude",
              model: "claude-sonnet-4-20250514",
              provider: "anthropic",
              tokens: { input: 7, output: 3 },
            },
          ],
          sourceVersion: "20.0.19",
          timeZone: "UTC",
        })
        expect(yield* Effect.promise(() => readdir(journalDirectory))).toEqual([])
        const requests = yield* destination.requests
        expect(requests.filter(({ path }) => path.endsWith("/commit"))).toHaveLength(2)
        expect(
          requests.every(({ authorization }) => authorization === "Bearer daily-e2e-token"),
        ).toBe(true)
      }),
    ),
  )
}, 90_000)

it("exchanges a CI OIDC assertion without forwarding it to the destination", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* packedCli
        const destination = yield* mockDestination
        const oidc = yield* mockOidc
        const home = yield* cli.makeHome("oidc-ci")
        const configPath = join(home, "config.toml")
        yield* cli.write(configPath, oidcConfiguration("http://127.0.0.1:0", destination.url, oidc))
        const environment = isolatedEnvironment(home, {
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-actions-request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: oidc.ciAssertionUrl,
          LUMEN_DEVICE_ID: "b9cc4878-de22-47f1-84e3-8af68acdbb24",
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const collector = yield* startCollector(cli, configPath, environment)
            const collectorUrl = readyUrl(yield* nextCollectorEvent(collector, "ready"))
            yield* submitLog(
              collectorUrl,
              logFixture({ eventId: "oidc-ci-event", input: 4, output: 2 }),
            )
            yield* nextCollectorEvent(collector, "progress")
            yield* destination.takeLive
            yield* collector.stop
          }),
        )

        const [request] = yield* destination.requests
        expect(request?.authorization).toStartWith("Bearer ")
        expect(request?.authorization).not.toContain(oidc.assertion)
        expect(JSON.stringify(request?.body)).not.toContain(oidc.assertion)
        expect(oidc.ciAssertionRequests).toEqual([
          {
            audience: "https://usage.lumen.build",
            authorization: "Bearer github-actions-request-token",
          },
        ])
        expect(oidc.tokenRequests).toMatchObject([
          {
            grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          },
        ])
      }),
    ),
  )
}, 90_000)

it("completes local PKCE login, refreshes, and revokes with mocked OIDC", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* packedCli
        const destination = yield* mockDestination
        const oidc = yield* mockOidc
        const home = yield* cli.makeHome("oidc-local")
        const redirectPort = yield* unusedLoopbackPort
        const configPath = join(home, "config.toml")
        const fakeBin = join(home, "bin")
        yield* cli.write(
          configPath,
          oidcConfiguration("http://127.0.0.1:0", destination.url, oidc, redirectPort),
        )
        yield* cli.writeExecutable(
          join(fakeBin, "xdg-open"),
          [
            "#!/usr/bin/env bun",
            "const response = await fetch(Bun.argv[2], { redirect: 'follow' })",
            "if (!response.ok) throw new Error(`authorization failed: ${response.status}`)",
            "",
          ].join("\n"),
        )
        const environment = isolatedEnvironment(home, {
          LUMEN_DEVICE_ID: "fa1b95ce-a07d-45c5-aa6a-f9af5f9a36ea",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        })

        const login = yield* cli.run(configArguments(configPath, "auth", "login"), environment)
        if (login.exitCode !== 0) {
          return yield* Effect.fail(new Error(login.stdout || login.stderr))
        }
        expect(login.exitCode).toBe(0)
        expect(login.events).toMatchObject([
          {
            command: "auth.login",
            data: { action: "login" },
            type: "result",
          },
        ])
        const credentialsPath = join(home, "credentials.json")
        expect((yield* Effect.promise(() => stat(credentialsPath))).mode & 0o777).toBe(0o600)
        expect(yield* Effect.promise(() => readFile(credentialsPath, "utf8"))).toContain(
          oidc.refreshToken,
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const collector = yield* startCollector(cli, configPath, environment)
            const collectorUrl = readyUrl(yield* nextCollectorEvent(collector, "ready"))
            yield* submitLog(
              collectorUrl,
              logFixture({ eventId: "oidc-local-event", input: 6, output: 1 }),
            )
            yield* nextCollectorEvent(collector, "progress")
            yield* destination.takeLive
            yield* collector.stop
          }),
        )
        const [request] = yield* destination.requests
        expect(oidc.tokenRequests).toHaveLength(2)
        expect(oidc.tokenRequests.map(({ grantType }) => grantType)).toEqual([
          "authorization_code",
          "refresh_token",
        ])
        const refreshed = oidc.tokenRequests[1]
        expect(refreshed?.refreshToken).toBe(oidc.refreshToken)
        expect(request?.authorization).toBe(`Bearer ${refreshed?.accessToken}`)
        expect(request?.authorization).not.toContain(oidc.refreshToken)

        const logout = yield* cli.run(configArguments(configPath, "auth", "logout"), environment)
        expect(logout.exitCode).toBe(0)
        expect(oidc.revocations).toEqual([oidc.refreshToken])
        expect(yield* Effect.promise(() => readFile(credentialsPath, "utf8"))).not.toContain(
          oidc.refreshToken,
        )
      }),
    ),
  )
}, 90_000)
