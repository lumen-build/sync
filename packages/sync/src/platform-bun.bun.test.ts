import { expect, test } from "bun:test"
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { DeviceIdentity, DeviceIdentityError } from "./device-identity"
import { bunDeviceIdentityLayer } from "./platform-bun"

const withTemporaryDirectory = <A>(use: (directory: string) => Promise<A>): Promise<A> =>
  mkdtemp(join(tmpdir(), "lumen-sync-platform-")).then(async (directory) => {
    try {
      return await use(directory)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

test("persists one private device identity across runs", () =>
  withTemporaryDirectory(async (directory) => {
    const path = join(directory, "nested", "device-id")
    const load = () =>
      Effect.runPromise(
        DeviceIdentity.pipe(
          Effect.flatMap((identity) => identity.loadOrCreate(path)),
          Effect.provide(bunDeviceIdentityLayer),
        ),
      )

    const first = await load()
    const second = await load()

    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }))

test.skipIf(process.platform === "win32")("rejects a symlinked device identity", () =>
  withTemporaryDirectory(async (directory) => {
    const target = join(directory, "target")
    const path = join(directory, "device-id")
    await writeFile(target, "ec7100cb-d60f-479a-a136-85327ec03f8b\n")
    await symlink(target, path)

    const result = await Effect.runPromise(
      DeviceIdentity.pipe(
        Effect.flatMap((identity) => identity.loadOrCreate(path)),
        Effect.flip,
        Effect.provide(bunDeviceIdentityLayer),
      ),
    )

    expect(result).toBeInstanceOf(DeviceIdentityError)
  }),
)
