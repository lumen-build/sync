import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { Crypto, Effect, Layer } from "effect"

import { HarnessFileError, HarnessFileSystem, type FileSnapshot } from "./lifecycle"

const fileError = (operation: string, path: string, cause: unknown): HarnessFileError =>
  new HarnessFileError({
    operation,
    path,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

export const bunHarnessFileSystemLayer: Layer.Layer<HarnessFileSystem, never, Crypto.Crypto> =
  Layer.effect(
    HarnessFileSystem,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      return HarnessFileSystem.of({
        readOptional: (path) =>
          Effect.tryPromise({
            try: async (): Promise<FileSnapshot | undefined> => {
              try {
                const metadata = await lstat(path)
                if (metadata.isSymbolicLink() || !metadata.isFile()) {
                  throw new Error("configuration must be a regular, non-symlink file")
                }
                return {
                  contents: await readFile(path, "utf8"),
                  mode: metadata.mode & 0o777,
                }
              } catch (cause) {
                if (isMissing(cause)) return undefined
                throw cause
              }
            },
            catch: (cause) => fileError("read harness configuration", path, cause),
          }),
        remove: (path, operation) =>
          Effect.tryPromise({
            try: () => rm(path, { force: true }),
            catch: (cause) => fileError(operation, path, cause),
          }),
        writeAtomic: (path, contents, mode) =>
          Effect.gen(function* () {
            const randomId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => fileError("write harness configuration", path, cause)),
            )
            const temporary = `${path}.${randomId}.tmp`
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dirname(path), { mode: 0o700, recursive: true })
                try {
                  await writeFile(temporary, contents, { flag: "wx", mode })
                  await rename(temporary, path)
                  await chmod(path, mode)
                } finally {
                  await rm(temporary, { force: true })
                }
              },
              catch: (cause) => fileError("write harness configuration", path, cause),
            })
          }),
      })
    }),
  )
