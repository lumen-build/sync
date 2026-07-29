import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { Effect, Schema } from "effect"

import { prepareConfiguration, prepareRemoval } from "./configuration"
import type { Harness, ManagedChange } from "./model"
import type { HarnessPaths } from "./paths"

const ManagedValueSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Absent") }),
  Schema.Struct({ _tag: Schema.Literal("Present"), value: Schema.Json }),
])

const ManagedChangeSchema = Schema.Struct({
  after: ManagedValueSchema,
  before: ManagedValueSchema,
  path: Schema.Array(Schema.String),
})

const OwnershipRecord = Schema.Struct({
  changes: Schema.Array(ManagedChangeSchema),
  collectorUrl: Schema.String,
  hadOriginal: Schema.Boolean,
  harness: Schema.String,
  path: Schema.String,
})

const Ownership = Schema.Struct({
  records: Schema.Array(OwnershipRecord),
  version: Schema.Literal(1),
})

type Ownership = typeof Ownership.Type

export class HarnessFileError extends Schema.TaggedErrorClass<HarnessFileError>()(
  "HarnessFileError",
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {}

const fileError = (operation: string, path: string, cause: unknown): HarnessFileError =>
  new HarnessFileError({
    operation,
    path,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const readOptional = (path: string) =>
  Effect.tryPromise({
    try: async (): Promise<{ readonly contents: string; readonly mode: number } | undefined> => {
      try {
        const metadata = await lstat(path)
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error("configuration must be a regular, non-symlink file")
        }
        return { contents: await readFile(path, "utf8"), mode: metadata.mode & 0o777 }
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return undefined
        }
        throw cause
      }
    },
    catch: (cause) => fileError("read harness configuration", path, cause),
  })

const writeAtomic = (path: string, contents: string, mode: number) =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      await mkdir(dirname(path), { mode: 0o700, recursive: true })
      try {
        await writeFile(temporary, contents, { mode })
        await rename(temporary, path)
        await chmod(path, mode)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    catch: (cause) => fileError("write harness configuration", path, cause),
  })

const readOwnership = (path: string) =>
  readOptional(path).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.succeed({ records: [], version: 1 } satisfies Ownership)
        : Effect.try({
            try: () => JSON.parse(snapshot.contents) as unknown,
            catch: (cause) => fileError("parse harness ownership", path, cause),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Ownership)),
            Effect.mapError((cause) => fileError("decode harness ownership", path, cause)),
          ),
    ),
  )

const writeOwnership = (path: string, ownership: Ownership) =>
  writeAtomic(path, `${JSON.stringify(ownership, undefined, 2)}\n`, 0o600)

export interface ConfigureHarnessInput {
  readonly collectorUrl: string
  readonly force: boolean
  readonly harness: Harness
  readonly paths: HarnessPaths
}

export const configureHarness = Effect.fn("HarnessLifecycle.configure")(function* ({
  collectorUrl,
  force,
  harness,
  paths,
}: ConfigureHarnessInput) {
  const path = paths.configurations[harness]
  const [snapshot, ownership] = yield* Effect.all([
    readOptional(path),
    readOwnership(paths.ownership),
  ])
  const prepared = yield* prepareConfiguration({
    collectorUrl,
    contents: snapshot?.contents ?? "",
    force,
    harness,
  })
  if (prepared.changes.length === 0) return prepared

  yield* writeAtomic(path, prepared.contents, snapshot?.mode ?? 0o600)
  const record = {
    changes: prepared.changes,
    collectorUrl,
    hadOriginal: snapshot !== undefined,
    harness,
    path,
  }
  yield* writeOwnership(paths.ownership, {
    records: [...ownership.records.filter((candidate) => candidate.harness !== harness), record],
    version: 1,
  }).pipe(
    Effect.catch((error) =>
      (snapshot === undefined
        ? Effect.tryPromise({
            try: () => rm(path, { force: true }),
            catch: () => error,
          })
        : writeAtomic(path, snapshot.contents, snapshot.mode)
      ).pipe(Effect.andThen(Effect.fail(error))),
    ),
  )
  return prepared
})

export interface RemoveHarnessInput {
  readonly harness: Harness
  readonly paths: HarnessPaths
}

export const removeHarness = Effect.fn("HarnessLifecycle.remove")(function* ({
  harness,
  paths,
}: RemoveHarnessInput) {
  const ownership = yield* readOwnership(paths.ownership)
  const record = ownership.records.find((candidate) => candidate.harness === harness)
  if (record === undefined) return { preserved: [], restored: [] }
  const snapshot = yield* readOptional(record.path)
  if (snapshot === undefined) {
    yield* writeOwnership(paths.ownership, {
      records: ownership.records.filter((candidate) => candidate.harness !== harness),
      version: 1,
    })
    return { preserved: [], restored: [] }
  }

  const prepared = yield* prepareRemoval({
    changes: record.changes as ReadonlyArray<ManagedChange>,
    collectorUrl: record.collectorUrl,
    contents: snapshot.contents,
    harness,
  })
  if (prepared.empty && !record.hadOriginal) {
    yield* Effect.tryPromise({
      try: () => rm(record.path, { force: true }),
      catch: (cause) => fileError("remove harness configuration", record.path, cause),
    })
  } else {
    yield* writeAtomic(record.path, prepared.contents, snapshot.mode)
  }
  yield* writeOwnership(paths.ownership, {
    records: ownership.records.filter((candidate) => candidate.harness !== harness),
    version: 1,
  })
  return { preserved: prepared.preserved, restored: prepared.restored }
})
