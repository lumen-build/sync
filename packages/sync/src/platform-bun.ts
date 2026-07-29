import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, open, rm, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import { CcusageAgent } from "@lumen-build/sync-ccusage"
import {
  CcusageDailyBatch as CcusageDailyBatchSchema,
  DeviceId,
  type CcusageDailyBatch,
} from "@lumen-build/sync-contracts"
import { Effect, Layer, Schema } from "effect"

import { DeviceIdentity, DeviceIdentityError } from "./device-identity"
import {
  DailySyncIdJournalError,
  DailySyncIdJournalFactory,
  type DailySyncIdJournal,
  type DailySyncIdKey,
} from "./runtime"

const DailySyncIdKeySchema = Schema.Struct({
  agent: CcusageAgent,
  deviceId: DeviceId,
  since: Schema.String,
  until: Schema.String,
})

const JournalEntrySchema = Schema.Struct({
  batch: CcusageDailyBatchSchema,
  key: DailySyncIdKeySchema,
  version: Schema.Literal(2),
})

interface JournalEntry extends Schema.Schema.Type<typeof JournalEntrySchema> {}

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

const decodeEntry = (path: string, contents: string, expectedKey: DailySyncIdKey): JournalEntry => {
  const decoded = Schema.decodeUnknownSync(JournalEntrySchema, {
    onExcessProperty: "error",
  })(JSON.parse(contents))
  if (
    keyText(decoded.key) !== keyText(expectedKey) ||
    decoded.batch.deviceId !== expectedKey.deviceId
  ) {
    throw new Error(`invalid daily sync journal entry at ${path}`)
  }
  return decoded
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
): Promise<CcusageDailyBatch> => {
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
      return entry.batch
    } catch (cause) {
      if (!isExisting(cause)) throw cause
      const existing = await readOptionalEntry(path, entry.key)
      if (existing === undefined) return persistEntry(directory, path, entry)
      return existing.batch
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

const makeFileDailySyncIdJournal = (directory: string): DailySyncIdJournal => ({
  getOrCreateBatch: (key, create) =>
    Effect.gen(function* () {
      const existing = yield* Effect.tryPromise({
        try: async () => {
          const path = entryPath(directory, key)
          return readOptionalEntry(path, key)
        },
        catch: (cause) => journalError("read daily sync batch", cause),
      })
      if (existing !== undefined) return existing.batch

      const batch = yield* create(crypto.randomUUID())
      const entry = yield* Schema.decodeUnknownEffect(JournalEntrySchema, {
        onExcessProperty: "error",
      })({ batch, key, version: 2 }).pipe(
        Effect.mapError((cause) => journalError("validate daily sync batch", cause)),
      )
      return yield* Effect.tryPromise({
        try: async () => {
          const path = entryPath(directory, key)
          return persistEntry(directory, path, entry)
        },
        catch: (cause) => journalError("persist daily sync batch", cause),
      })
    }),
  remove: (key, syncId) =>
    Effect.tryPromise({
      try: async () => {
        const path = entryPath(directory, key)
        const existing = await readOptionalEntry(path, key)
        if (existing === undefined) return
        if (existing.batch.syncId !== syncId) {
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
