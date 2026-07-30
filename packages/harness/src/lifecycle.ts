/* oxlint-disable no-underscore-dangle -- Effect-style result values use _tag. */

import { Context, Effect, Schema } from "effect"

import { prepareConfiguration, prepareRemoval } from "./configuration"
import { inspectHarnessEnvironment, type HarnessEnvironmentInspection } from "./environment"
import {
  Harness,
  HarnessConfigurationConflict,
  ManagedChange,
  harnessRegistry,
  managedPathKey,
  type HarnessStatus,
  type HarnessStatusState,
} from "./model"
import type { HarnessPaths } from "./paths"

const OwnershipRecord = Schema.Struct({
  changes: Schema.Array(ManagedChange),
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
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly force: boolean
  readonly harness: Harness
  readonly paths: HarnessPaths
}

export interface HarnessInspection extends HarnessStatus {
  readonly environment: Readonly<Record<string, string>>
}

const environmentInspection = (
  collectorUrl: string,
  environment: Readonly<Record<string, string | undefined>>,
  harness: Harness,
  paths: HarnessPaths,
): HarnessEnvironmentInspection =>
  inspectHarnessEnvironment(
    harness,
    {
      collectorUrl,
      copilotTelemetryPath: paths.telemetry.copilot,
    },
    environment,
  )

const environmentReason = (inspection: HarnessEnvironmentInspection): string | undefined => {
  const reason = [...inspection.conflicting, ...inspection.missing].join(", ")
  return reason.length === 0 ? undefined : reason
}

const combineHarnessState = (
  file: HarnessStatusState,
  environment: Exclude<HarnessStatusState, "unreadable">,
): HarnessStatusState => {
  if (file === "unreadable" || file === "conflicting") return file
  if (environment === "conflicting") return "conflicting"
  if (file === "exact" && environment === "exact") return "exact"
  if (file === "missing" && environment === "missing") return "missing"
  return "partial"
}

const environmentStatus = (
  harness: Harness,
  inspection: HarnessEnvironmentInspection,
): HarnessInspection => {
  const reason = environmentReason(inspection)
  return {
    harness,
    environment: inspection.required,
    managed: false,
    path: "environment",
    ...(reason === undefined ? {} : { reason }),
    state: inspection.state,
  }
}

const combinedStatus = (
  file: HarnessStatus,
  inspection: HarnessEnvironmentInspection,
): HarnessInspection => {
  const environmentFailure = environmentReason(inspection)
  return {
    ...file,
    environment: inspection.required,
    ...(environmentFailure === undefined
      ? {}
      : {
          reason:
            file.reason === undefined
              ? environmentFailure
              : `${file.reason}; ${environmentFailure}`,
        }),
    state:
      Object.keys(inspection.required).length === 0
        ? file.state
        : combineHarnessState(file.state, inspection.state),
  }
}

export const configureHarness = Effect.fn("HarnessLifecycle.configure")(function* ({
  collectorUrl,
  environment = {},
  force,
  harness,
  paths,
}: ConfigureHarnessInput) {
  const inspectedEnvironment = environmentInspection(collectorUrl, environment, harness, paths)
  if (harnessRegistry[harness].format === "environment") {
    const status = environmentStatus(harness, inspectedEnvironment)
    return {
      changes: [],
      contents: "",
      environment: inspectedEnvironment.required,
      state: inspectedEnvironment.state,
      status,
    }
  }

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
  const previousRecord = ownership.records.find((candidate) => candidate.harness === harness)
  if (prepared.changes.length === 0) {
    return {
      ...prepared,
      environment: inspectedEnvironment.required,
      status: combinedStatus(
        {
          harness,
          managed: previousRecord !== undefined,
          path,
          state: "exact",
        },
        inspectedEnvironment,
      ),
    }
  }

  yield* files.writeAtomic(path, prepared.contents, snapshot?.mode ?? 0o600)
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
  return {
    ...prepared,
    environment: inspectedEnvironment.required,
    status: combinedStatus(
      {
        harness,
        managed: true,
        path,
        state: "exact",
      },
      inspectedEnvironment,
    ),
  }
})

export interface RemoveHarnessInput {
  readonly harness: Harness
  readonly paths: HarnessPaths
}

export const removeHarness = Effect.fn("HarnessLifecycle.remove")(function* ({
  harness,
  paths,
}: RemoveHarnessInput) {
  if (harnessRegistry[harness].format === "environment") {
    return { preserved: [], restored: [] }
  }
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
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly harness: Harness
  readonly paths: HarnessPaths
}

const inspectFileHarness = Effect.fn("HarnessLifecycle.inspectFile")(function* ({
  collectorUrl,
  harness,
  paths,
}: Omit<InspectHarnessInput, "environment">) {
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

export const inspectHarness = Effect.fn("HarnessLifecycle.inspect")(function* ({
  collectorUrl,
  environment = {},
  harness,
  paths,
}: InspectHarnessInput) {
  const inspectedEnvironment = environmentInspection(collectorUrl, environment, harness, paths)
  if (harnessRegistry[harness].format === "environment") {
    return environmentStatus(harness, inspectedEnvironment)
  }
  return combinedStatus(
    yield* inspectFileHarness({ collectorUrl, harness, paths }),
    inspectedEnvironment,
  )
})
