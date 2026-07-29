import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { configureHarness, removeHarness } from "./lifecycle"
import { makeHarnessPaths } from "./paths"

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
  ),
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
  ),
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
  ),
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
  ),
)
