import { expect, test } from "bun:test"

import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect } from "effect"

import { CcusageCommand, CcusageCommandFailed, type CommandOptions, commandLayer } from "./index.js"

const input = {
  agent: "claude",
  since: "2026-07-01",
  until: "2026-07-29",
} as const

const run = <A, E>(options: CommandOptions, effect: Effect.Effect<A, E, CcusageCommand>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(commandLayer(options)), Effect.provide(BunServices.layer)),
  )

test("captures output from a real Effect-managed child process", async () => {
  const output = await run(
    {
      executable: process.execPath,
      prefixArguments: ["-e", 'process.stdout.write("mocked ccusage output")'],
    },
    Effect.gen(function* () {
      const command = yield* CcusageCommand
      return yield* command.runDaily(input)
    }),
  )

  expect(output).toEqual({
    stderr: "",
    stdout: "mocked ccusage output",
  })
})

test("returns typed non-zero exit failures", async () => {
  const failure = await run(
    {
      executable: process.execPath,
      prefixArguments: ["-e", 'process.stderr.write("mocked failure"); process.exit(7)'],
    },
    Effect.gen(function* () {
      const command = yield* CcusageCommand
      return yield* Effect.flip(command.runDaily(input))
    }),
  )

  expect(failure).toBeInstanceOf(CcusageCommandFailed)
  expect(failure.exitCode).toBe(7)
  expect(failure.reason).toBe("mocked failure")
})

test("kills a child process that exceeds its deadline", async () => {
  const failure = await run(
    {
      executable: process.execPath,
      prefixArguments: ["-e", "setInterval(function () {}, 1_000)"],
      timeoutMs: 25,
    },
    Effect.gen(function* () {
      const command = yield* CcusageCommand
      return yield* Effect.flip(command.runDaily(input))
    }),
  )

  expect(failure).toBeInstanceOf(CcusageCommandFailed)
  expect(failure.reason).toBe("ccusage timed out after 25ms")
})
