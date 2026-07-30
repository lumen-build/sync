import { Console, Effect } from "effect"

import { makeReferenceReceiver } from "./receiver.js"

const token = process.env.RECEIVER_BEARER_TOKEN
if (token === undefined || token.length === 0) {
  throw new Error("RECEIVER_BEARER_TOKEN is required")
}

const configuredPort = Number(process.env.PORT ?? "8787")
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
  throw new Error("PORT must be an integer between 0 and 65535")
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const receiver = yield* makeReferenceReceiver({
      bearerToken: token,
      port: configuredPort,
    })
    yield* Console.log(`Reference receiver listening on ${receiver.url}`)
    return yield* Effect.never
  }),
)

Effect.runPromise(program).catch((cause: unknown) => {
  console.error(cause)
  process.exitCode = 1
})
