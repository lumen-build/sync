import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, open, rm, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import { DeviceId, SyncId } from "@lumen-build/sync-contracts"
import { Effect, Layer, Schema } from "effect"

import { DeviceIdentity, DeviceIdentityError } from "./device-identity"
import {
  DailySyncIdJournalError,
  DailySyncIdJournalFactory,
  type DailySyncIdJournal,
  type DailySyncIdKey,
} from "./runtime"

interface JournalEntry {
  readonly key: DailySyncIdKey
  readonly syncId: string
  readonly version: 1
}

const keyText = (key: DailySyncIdKey): string =>
  JSON.stringify([key.deviceId, key.agent, key.since, key.until])

const entryPath = (directory: string, key: DailySyncIdKey): string =>
  join(directory, `${createHash("sha256").update(keyText(key)).digest("hex")}.json`)

const journalError = (operation: string, cause: unknown): DailySyncIdJournalError =>
  new DailySyncIdJournalError({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

const isExisting = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST"

const isSyncId = Schema.is(SyncId)

const decodeEntry = (path: string, contents: string, expectedKey: DailySyncIdKey): JournalEntry => {
  const decoded = JSON.parse(contents) as Partial<JournalEntry>
  if (
    decoded.version !== 1 ||
    decoded.key === undefined ||
    keyText(decoded.key) !== keyText(expectedKey) ||
    !isSyncId(decoded.syncId)
  ) {
    throw new Error(`invalid daily sync journal entry at ${path}`)
  }
  return decoded as JournalEntry
}

const readOptionalEntry = async (
  path: string,
  key: DailySyncIdKey,
): Promise<JournalEntry | undefined> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) {
        throw new Error(`daily sync journal entry is not a regular file: ${path}`)
      }
      if ((metadata.mode & 0o777) !== 0o600) await handle.chmod(0o600)
      return decodeEntry(path, await handle.readFile("utf8"), key)
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
}

const persistEntry = async (
  directory: string,
  path: string,
  entry: JournalEntry,
): Promise<string> => {
  await mkdir(directory, { mode: 0o700, recursive: true })
  const temporary = join(directory, `.${crypto.randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8")
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, path)
      return entry.syncId
    } catch (cause) {
      if (!isExisting(cause)) throw cause
      const existing = await readOptionalEntry(path, entry.key)
      if (existing === undefined) return persistEntry(directory, path, entry)
      return existing.syncId
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

const makeFileDailySyncIdJournal = (directory: string): DailySyncIdJournal => ({
  getOrCreate: (key) =>
    Effect.tryPromise({
      try: async () => {
        const path = entryPath(directory, key)
        const existing = await readOptionalEntry(path, key)
        if (existing !== undefined) return existing.syncId
        return persistEntry(directory, path, {
          key,
          syncId: crypto.randomUUID(),
          version: 1,
        })
      },
      catch: (cause) => journalError("get or create daily sync ID", cause),
    }),
  remove: (key, syncId) =>
    Effect.tryPromise({
      try: async () => {
        const path = entryPath(directory, key)
        const existing = await readOptionalEntry(path, key)
        if (existing === undefined) return
        if (existing.syncId !== syncId) {
          throw new Error(`daily sync journal entry changed before removal: ${path}`)
        }
        try {
          await unlink(path)
        } catch (cause) {
          if (!isMissing(cause)) throw cause
        }
      },
      catch: (cause) => journalError("remove daily sync ID", cause),
    }),
})

export const bunDailySyncIdJournalLayer = Layer.succeed(
  DailySyncIdJournalFactory,
  DailySyncIdJournalFactory.of({ make: makeFileDailySyncIdJournal }),
)

const deviceError = (path: string, cause: unknown): DeviceIdentityError =>
  new DeviceIdentityError({
    path,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const readDeviceId = async (path: string): Promise<string | undefined> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`device identity is not a regular file: ${path}`)
      if ((metadata.mode & 0o777) !== 0o600) await handle.chmod(0o600)
      const value = (await handle.readFile("utf8")).trim()
      if (!Schema.is(DeviceId)(value)) throw new Error(`invalid device identity at ${path}`)
      return value
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
}

const persistDeviceId = async (path: string, value: string): Promise<string> => {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  try {
    const handle = await open(path, "wx", 0o600)
    try {
      await handle.writeFile(`${value}\n`, "utf8")
      await handle.chmod(0o600)
      await handle.sync()
      return value
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if (!isExisting(cause)) throw cause
    const existing = await readDeviceId(path)
    if (existing === undefined) return persistDeviceId(path, value)
    return existing
  }
}

export const bunDeviceIdentityLayer = Layer.succeed(
  DeviceIdentity,
  DeviceIdentity.of({
    loadOrCreate: (path) =>
      Effect.tryPromise({
        try: async () => {
          const existing = await readDeviceId(path)
          if (existing !== undefined) return existing
          return persistDeviceId(path, crypto.randomUUID())
        },
        catch: (cause) => deviceError(path, cause),
      }),
  }),
)

export const bunSyncPlatformLayer = Layer.merge(bunDailySyncIdJournalLayer, bunDeviceIdentityLayer)
