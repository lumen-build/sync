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

        yield* removeHarness({ harness: "claude", paths })
        const restored = yield* Effect.promise(() => readFile(paths.configurations.claude, "utf8"))
        expect(restored).toContain("// mocked user setting")
        expect(restored).not.toContain("collector.lumen.build")
      }),
    (home) => Effect.promise(() => rm(home, { force: true, recursive: true })),
  ),
)
