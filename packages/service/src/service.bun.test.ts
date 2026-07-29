import { expect, test } from "bun:test"

import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect } from "effect"

import { ServiceCommandRunner, liveServiceCommandRunnerLayer } from "./index.js"

test("runs service commands through the Effect child-process adapter", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* ServiceCommandRunner
      return yield* runner.run({
        args: [
          "-e",
          'process.stdout.write("mocked output"); process.stderr.write("mocked warning")',
        ],
        executable: process.execPath,
      })
    }).pipe(Effect.provide(liveServiceCommandRunnerLayer), Effect.provide(BunServices.layer)),
  )

  expect(result).toEqual({
    exitCode: 0,
    stderr: "mocked warning",
    stdout: "mocked output",
  })
})
