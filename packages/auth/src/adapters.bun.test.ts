import { expect, spyOn, test } from "bun:test"
import { createServer } from "node:net"

import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect } from "effect"

import { localAuthorizationCodeReceiverLayer } from "./adapters"
import { AuthorizationCodeReceiver } from "./oidc-client"

const availablePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("could not allocate a loopback port"))
        return
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port)
        else reject(error)
      })
    })
  })

test("keeps waiting after uncorrelated callbacks and accepts a later matching callback", async () => {
  const port = await availablePort()
  const browserOpened = Promise.withResolvers<void>()
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    browserOpened.resolve()
    return {
      unref: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>
  })
  const cancellation = new AbortController()
  try {
    const expectedState = "expected-state"
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const authorizationUrl = new URL("https://identity.lumen.build/authorize")
    authorizationUrl.searchParams.set("redirect_uri", redirectUri)
    const authorization = Effect.runPromise(
      Effect.gen(function* () {
        const receiver = yield* AuthorizationCodeReceiver
        return yield* receiver.authorize(authorizationUrl.toString(), expectedState)
      }).pipe(
        Effect.provide(localAuthorizationCodeReceiverLayer({ platform: "linux" })),
        Effect.provide(BunServices.layer),
      ),
      { signal: cancellation.signal },
    )
    const outcome = authorization.then(
      (value) => ({ _tag: "Success" as const, value }),
      (error) => ({ _tag: "Failure" as const, error }),
    )
    await browserOpened.promise

    const attackerCallback = new URL(redirectUri)
    attackerCallback.searchParams.set("error", "access_denied")
    attackerCallback.searchParams.set("state", "attacker-state")
    const attackerResponse = await fetch(attackerCallback).catch(() => undefined)

    const premature = await Promise.race([
      outcome,
      new Promise<"Pending">((resolve) => setTimeout(() => resolve("Pending"), 25)),
    ])
    expect(premature).toBe("Pending")
    expect(attackerResponse?.status).toBe(400)

    const matchingCallback = new URL(redirectUri)
    matchingCallback.searchParams.set("code", "authorization-code")
    matchingCallback.searchParams.set("state", expectedState)
    const matchingResponse = await fetch(matchingCallback)
    expect(matchingResponse.status).toBe(200)
    expect(await outcome).toEqual({
      _tag: "Success",
      value: { code: "authorization-code", state: expectedState },
    })
  } finally {
    cancellation.abort()
    spawn.mockRestore()
  }
})
