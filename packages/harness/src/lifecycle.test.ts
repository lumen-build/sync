/* oxlint-disable no-underscore-dangle -- assertions inspect Effect-style tagged errors. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { bunHarnessFileSystemLayer } from "./lifecycle-bun"
import { requiredHarnessEnvironment } from "./environment"
import { configureHarness, inspectHarness, removeHarness } from "./lifecycle"
import { makeHarnessPaths } from "./paths"

const lifecycleLayer = bunHarnessFileSystemLayer.pipe(Layer.provide(BunServices.layer))

it.effect("handles environment-only harnesses without touching user settings", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-harness-"))),
    (home) =>
      Effect.gen(function* () {
        const paths = makeHarnessPaths({
          configHome: join(home, ".config"),
          home,
          platform: "linux",
        })
        const collectorUrl = "https://collector.lumen.build"
        const context = {
          collectorUrl,
          copilotTelemetryPath: paths.telemetry.copilot,
        }
        const missing = yield* configureHarness({
          collectorUrl,
          environment: {},
          force: false,
          harness: "copilot",
          paths,
        })
        expect(missing).toMatchObject({
          changes: [],
          state: "missing",
          status: {
            managed: false,
            path: "environment",
            state: "missing",
          },
        })
        expect(missing.environment).toEqual(requiredHarnessEnvironment("copilot", context))
        expect(
          yield* Effect.promise(() =>
            readFile(paths.configurations.copilot, "utf8").then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(
          yield* Effect.promise(() =>
            readFile(paths.ownership, "utf8").then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)

        expect(
          yield* inspectHarness({
            collectorUrl,
            environment: requiredHarnessEnvironment("copilot", context),
            harness: "copilot",
            paths,
          }),
        ).toMatchObject({
          environment: requiredHarnessEnvironment("copilot", context),
          managed: false,
          path: "environment",
          state: "exact",
        })
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ).pipe(Effect.provide(lifecycleLayer)),
)

it.effect("reports missing, exact, and conflicting harness configuration", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-harness-"))),
    (home) =>
      Effect.gen(function* () {
        const paths = makeHarnessPaths({
          configHome: join(home, ".config"),
          home,
          platform: "linux",
        })
        const input = {
          collectorUrl: "https://collector.lumen.build",
          harness: "vscode" as const,
          paths,
        }

        expect(yield* inspectHarness(input)).toMatchObject({
          managed: false,
          state: "missing",
        })
        yield* configureHarness({ ...input, force: false })
        expect(yield* inspectHarness(input)).toMatchObject({
          managed: true,
          state: "exact",
        })

        const configured = yield* Effect.promise(() =>
          readFile(paths.configurations.vscode, "utf8"),
        )
        yield* Effect.promise(() =>
          writeFile(
            paths.configurations.vscode,
            configured.replace(
              '"github.copilot.chat.otel.enabled": true',
              '"github.copilot.chat.otel.enabled": false',
            ),
          ),
        )
        expect(yield* inspectHarness(input)).toMatchObject({
          managed: true,
          reason: "github.copilot.chat.otel.enabled",
          state: "conflicting",
        })
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ).pipe(Effect.provide(lifecycleLayer)),
)

it.effect("configures and safely restores a real mocked harness file", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-harness-"))),
    (home) =>
      Effect.gen(function* () {
        const paths = makeHarnessPaths({
          configHome: join(home, ".config"),
          home,
          platform: "linux",
        })
        yield* Effect.promise(async () => {
          await mkdir(join(home, ".claude"), { recursive: true })
          await writeFile(
            paths.configurations.claude,
            '{\n  // mocked user setting\n  "theme": "dark"\n}\n',
          )
        })
        const configured = yield* configureHarness({
          collectorUrl: "https://collector.lumen.build",
          force: false,
          harness: "claude",
          paths,
        })
        expect(configured.contents).toContain("collector.lumen.build")
        expect(yield* Effect.promise(() => readFile(paths.ownership, "utf8"))).toContain(
          '"harness": "claude"',
        )

        yield* configureHarness({
          collectorUrl: "https://new-collector.lumen.build",
          force: true,
          harness: "claude",
          paths,
        })
        yield* removeHarness({ harness: "claude", paths })
        const restored = yield* Effect.promise(() => readFile(paths.configurations.claude, "utf8"))
        expect(restored).toContain("// mocked user setting")
        expect(restored).not.toContain("collector.lumen.build")
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ).pipe(Effect.provide(lifecycleLayer)),
)

it.effect("retains original ownership when reconfiguring an existing harness file", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-harness-"))),
    (home) =>
      Effect.gen(function* () {
        const paths = makeHarnessPaths({
          configHome: join(home, ".config"),
          home,
          platform: "linux",
        })
        const original = {
          "github.copilot.chat.otel.enabled": false,
          theme: "dark",
        }
        yield* Effect.promise(async () => {
          await mkdir(dirname(paths.configurations.vscode), { recursive: true })
          await writeFile(paths.configurations.vscode, `${JSON.stringify(original)}\n`)
        })

        yield* configureHarness({
          collectorUrl: "https://collector.lumen.build",
          force: true,
          harness: "vscode",
          paths,
        })
        yield* configureHarness({
          collectorUrl: "https://new-collector.lumen.build",
          force: true,
          harness: "vscode",
          paths,
        })

        const ownership = JSON.parse(yield* Effect.promise(() => readFile(paths.ownership, "utf8")))
        const record = ownership.records[0]
        expect(record.hadOriginal).toBe(true)
        expect(record.changes).toHaveLength(4)
        expect(
          record.changes.find(
            (change: { readonly path: ReadonlyArray<string> }) =>
              change.path.join(".") === "github.copilot.chat.otel.enabled",
          )?.before,
        ).toEqual({ _tag: "Present", value: false })

        yield* removeHarness({ harness: "vscode", paths })
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(paths.configurations.vscode, "utf8"))),
        ).toEqual(original)
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ).pipe(Effect.provide(lifecycleLayer)),
)

it.effect("deletes an originally absent harness file after reconfiguration", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-harness-"))),
    (home) =>
      Effect.gen(function* () {
        const paths = makeHarnessPaths({
          configHome: join(home, ".config"),
          home,
          platform: "linux",
        })

        yield* configureHarness({
          collectorUrl: "https://collector.lumen.build",
          force: false,
          harness: "vscode",
          paths,
        })
        yield* configureHarness({
          collectorUrl: "https://new-collector.lumen.build",
          force: true,
          harness: "vscode",
          paths,
        })

        const ownership = JSON.parse(yield* Effect.promise(() => readFile(paths.ownership, "utf8")))
        expect(ownership.records[0].hadOriginal).toBe(false)
        expect(ownership.records[0].changes).toHaveLength(4)

        yield* removeHarness({ harness: "vscode", paths })
        const error = yield* Effect.promise(() =>
          readFile(paths.configurations.vscode, "utf8").catch((cause: unknown) => cause),
        )
        expect(error).toMatchObject({ code: "ENOENT" })
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ).pipe(Effect.provide(lifecycleLayer)),
)

it.effect("rejects ownership records that point outside the known harness paths", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-harness-"))),
    (home) =>
      Effect.gen(function* () {
        const paths = makeHarnessPaths({
          configHome: join(home, ".config"),
          home,
          platform: "linux",
        })
        const unrelated = join(home, "unrelated.json")
        yield* Effect.promise(async () => {
          await mkdir(join(paths.ownership, ".."), { recursive: true })
          await writeFile(unrelated, '{"keep":true}\n')
          await writeFile(
            paths.ownership,
            `${JSON.stringify({
              records: [
                {
                  changes: [],
                  collectorUrl: "https://collector.lumen.build",
                  hadOriginal: true,
                  harness: "claude",
                  path: unrelated,
                },
              ],
              version: 1,
            })}\n`,
          )
        })

        const error = yield* removeHarness({ harness: "claude", paths }).pipe(Effect.flip)
        expect(error._tag).toBe("HarnessFileError")
        if (error._tag === "HarnessFileError") {
          expect(error.operation).toBe("validate harness ownership")
        }
        expect(yield* Effect.promise(() => readFile(unrelated, "utf8"))).toBe('{"keep":true}\n')
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ).pipe(Effect.provide(lifecycleLayer)),
)
