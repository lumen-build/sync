/* oxlint-disable no-underscore-dangle -- Effect-style result values use _tag. */

import { Context, Effect, Schema } from "effect"

import { prepareConfiguration, prepareRemoval } from "./configuration"
import {
  Harness,
  HarnessConfigurationConflict,
  managedPathKey,
  type HarnessStatus,
  type ManagedChange,
} from "./model"
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
  harness: Harness,
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

export interface FileSnapshot {
  readonly contents: string
  readonly mode: number
}

export interface HarnessFileSystemInterface {
  readonly readOptional: (path: string) => Effect.Effect<FileSnapshot | undefined, HarnessFileError>
  readonly remove: (path: string, operation: string) => Effect.Effect<void, HarnessFileError>
  readonly writeAtomic: (
    path: string,
    contents: string,
    mode: number,
  ) => Effect.Effect<void, HarnessFileError>
}

export class HarnessFileSystem extends Context.Service<
  HarnessFileSystem,
  HarnessFileSystemInterface
>()("@lumen-build/sync/HarnessFileSystem") {}

const fileError = (operation: string, path: string, cause: unknown): HarnessFileError =>
  new HarnessFileError({
    operation,
    path,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const readOwnership = (files: HarnessFileSystemInterface, path: string) =>
  files.readOptional(path).pipe(
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

const writeOwnership = (files: HarnessFileSystemInterface, path: string, ownership: Ownership) =>
  files.writeAtomic(path, `${JSON.stringify(ownership, undefined, 2)}\n`, 0o600)

const invalidOwnershipRecord = (ownership: Ownership, paths: HarnessPaths) =>
  ownership.records.find((record) => record.path !== paths.configurations[record.harness])

const validateOwnership = (
  ownership: Ownership,
  paths: HarnessPaths,
): Effect.Effect<void, HarnessFileError> => {
  const invalid = invalidOwnershipRecord(ownership, paths)
  return invalid === undefined
    ? Effect.void
    : Effect.fail(
        fileError(
          "validate harness ownership",
          paths.ownership,
          `recorded path does not match ${invalid.harness} configuration`,
        ),
      )
}

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
  const files = yield* HarnessFileSystem
  const path = paths.configurations[harness]
  const [snapshot, ownership] = yield* Effect.all([
    files.readOptional(path),
    readOwnership(files, paths.ownership),
  ])
  yield* validateOwnership(ownership, paths)

  const prepared = yield* prepareConfiguration({
    collectorUrl,
    contents: snapshot?.contents ?? "",
    force,
    harness,
  })
  if (prepared.changes.length === 0) return prepared

  yield* files.writeAtomic(path, prepared.contents, snapshot?.mode ?? 0o600)
  const previousRecord = ownership.records.find((candidate) => candidate.harness === harness)
  const changesByPath = new Map(
    prepared.changes.map((change) => [managedPathKey(change.path), change]),
  )
  const retainedChanges =
    previousRecord?.changes.map((previous) => {
      const key = managedPathKey(previous.path)
      const change = changesByPath.get(key)
      if (change === undefined) return previous
      changesByPath.delete(key)
      return { ...change, before: previous.before }
    }) ?? []
  const ownedChanges = [...retainedChanges, ...changesByPath.values()]
  const record = {
    changes: ownedChanges,
    collectorUrl,
    hadOriginal: previousRecord?.hadOriginal ?? snapshot !== undefined,
    harness,
    path,
  }
  yield* writeOwnership(files, paths.ownership, {
    records: [...ownership.records.filter((candidate) => candidate.harness !== harness), record],
    version: 1,
  }).pipe(
    Effect.catch((error) =>
      (snapshot === undefined
        ? files.remove(path, "roll back harness configuration").pipe(Effect.mapError(() => error))
        : files.writeAtomic(path, snapshot.contents, snapshot.mode)
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
  const files = yield* HarnessFileSystem
  const ownership = yield* readOwnership(files, paths.ownership)
  yield* validateOwnership(ownership, paths)

  const record = ownership.records.find((candidate) => candidate.harness === harness)
  if (record === undefined) return { preserved: [], restored: [] }
  const snapshot = yield* files.readOptional(record.path)
  if (snapshot === undefined) {
    yield* writeOwnership(files, paths.ownership, {
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
    yield* files.remove(record.path, "remove harness configuration")
  } else {
    yield* files.writeAtomic(record.path, prepared.contents, snapshot.mode)
  }
  yield* writeOwnership(files, paths.ownership, {
    records: ownership.records.filter((candidate) => candidate.harness !== harness),
    version: 1,
  })
  return { preserved: prepared.preserved, restored: prepared.restored }
})

export interface InspectHarnessInput {
  readonly collectorUrl: string
  readonly harness: Harness
  readonly paths: HarnessPaths
}

export const inspectHarness = Effect.fn("HarnessLifecycle.inspect")(function* ({
  collectorUrl,
  harness,
  paths,
}: InspectHarnessInput) {
  const files = yield* HarnessFileSystem
  const path = paths.configurations[harness]
  const fileResult = yield* Effect.result(files.readOptional(path))
  const ownershipResult = yield* Effect.result(
    readOwnership(files, paths.ownership).pipe(
      Effect.tap((ownership) => validateOwnership(ownership, paths)),
    ),
  )
  const managed =
    ownershipResult._tag === "Success" &&
    ownershipResult.success.records.some((record) => record.harness === harness)
  if (fileResult._tag === "Failure") {
    return {
      harness,
      managed,
      path,
      reason: fileResult.failure.reason,
      state: "unreadable",
    } satisfies HarnessStatus
  }
  if (ownershipResult._tag === "Failure") {
    return {
      harness,
      managed: false,
      path,
      reason: ownershipResult.failure.reason,
      state: "unreadable",
    } satisfies HarnessStatus
  }
  if (fileResult.success === undefined) {
    return { harness, managed, path, state: "missing" } satisfies HarnessStatus
  }

  const prepared = yield* Effect.result(
    prepareConfiguration({
      collectorUrl,
      contents: fileResult.success.contents,
      force: false,
      harness,
    }),
  )
  if (prepared._tag === "Failure") {
    return prepared.failure instanceof HarnessConfigurationConflict
      ? ({
          harness,
          managed,
          path,
          reason: prepared.failure.fields.join(", "),
          state: "conflicting",
        } satisfies HarnessStatus)
      : ({
          harness,
          managed,
          path,
          reason: prepared.failure.reason,
          state: "unreadable",
        } satisfies HarnessStatus)
  }
  return {
    harness,
    managed,
    path,
    state: prepared.success.state,
  } satisfies HarnessStatus
})
