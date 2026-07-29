import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
