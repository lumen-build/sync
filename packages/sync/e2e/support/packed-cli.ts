import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { CliEvent } from "@lumen-build/sync-contracts"
import { Effect, Fiber, Queue, Schema } from "effect"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")

export class PackedCliError extends Schema.TaggedErrorClass<PackedCliError>()("PackedCliError", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

const definedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )

const commandError = (operation: string, cause: unknown): PackedCliError =>
  new PackedCliError({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const runCommand = Effect.fn("E2E.PackedCli.runCommand")(function* (
  command: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly environment?: Readonly<Record<string, string | undefined>>
  },
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: definedEnvironment(options.environment ?? process.env),
    stderr: "pipe",
    stdout: "pipe",
  })
  const result = yield* Effect.tryPromise({
    try: async () => {
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ])
      return { exitCode, stderr, stdout }
    },
    catch: (cause) => commandError(`run ${command[0] ?? "command"}`, cause),
  })
  return result
})

const requireSuccess = Effect.fn("E2E.PackedCli.requireSuccess")(function* (
  command: ReadonlyArray<string>,
  cwd: string,
) {
  const result = yield* runCommand(command, { cwd })
  if (result.exitCode !== 0) {
    return yield* new PackedCliError({
      operation: `run ${command[0] ?? "command"}`,
      reason: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
    })
  }
  return result.stdout
})

const packArchive = Effect.fn("E2E.PackedCli.packArchive")(function* (root: string) {
  const provided = process.env.LUMEN_SYNC_PACKAGE_TARBALL
  if (provided !== undefined) return resolve(provided)
  const output = yield* requireSuccess(
    ["npm", "pack", "--json", "--pack-destination", root, "--workspace", "packages/sync"],
    repositoryRoot,
  )
  const value = yield* Effect.try({
    try: () => JSON.parse(output) as unknown,
    catch: (cause) => commandError("decode npm pack output", cause),
  })
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ filename: Schema.String })),
  )(value).pipe(Effect.mapError((cause) => commandError("decode npm pack output", cause)))
  const filename = decoded[0]?.filename
  if (filename === undefined) {
    return yield* new PackedCliError({
      operation: "decode npm pack output",
      reason: "npm pack returned no archive",
    })
  }
  return join(root, filename)
})

export interface CliResult {
  readonly events: ReadonlyArray<typeof CliEvent.Type>
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export interface RunningCli {
  readonly events: Queue.Dequeue<typeof CliEvent.Type>
  readonly exitCode: Effect.Effect<number>
  readonly stderr: Effect.Effect<string, PackedCliError>
  readonly stop: Effect.Effect<void>
  readonly stdoutDone: Effect.Effect<void, PackedCliError>
}

export interface PackedCli {
  readonly consumer: string
  readonly executable: string
  readonly makeHome: (name: string) => Effect.Effect<string, PackedCliError>
  readonly run: (
    arguments_: ReadonlyArray<string>,
    environment: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<CliResult, PackedCliError>
  readonly start: (
    arguments_: ReadonlyArray<string>,
    environment: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<RunningCli, PackedCliError, import("effect").Scope.Scope>
  readonly write: (path: string, contents: string) => Effect.Effect<void, PackedCliError>
  readonly writeExecutable: (path: string, contents: string) => Effect.Effect<void, PackedCliError>
}

const parseEvents = Effect.fn("E2E.PackedCli.parseEvents")(function* (stdout: string) {
  return yield* Effect.forEach(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    (line) =>
      Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: (cause) => commandError("decode CLI JSONL", cause),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CliEvent)),
        Effect.mapError((cause) => commandError("decode CLI JSONL", cause)),
      ),
  )
})

const streamEvents = (
  stream: ReadableStream<Uint8Array>,
  events: Queue.Enqueue<typeof CliEvent.Type>,
) =>
  Effect.tryPromise({
    try: async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      const offerLine = async (line: string) => {
        if (line.trim().length === 0) return
        const event = await Effect.runPromise(
          Effect.try({
            try: () => JSON.parse(line) as unknown,
            catch: (cause) => commandError("decode CLI JSONL", cause),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CliEvent)),
            Effect.mapError((cause) => commandError("decode CLI JSONL", cause)),
          ),
        )
        await Effect.runPromise(Queue.offer(events, event))
      }
      const pump = async (buffered: string): Promise<void> => {
        const result = await reader.read()
        if (result.done) {
          await offerLine(`${buffered}${decoder.decode()}`)
          return
        }
        const lines = `${buffered}${decoder.decode(result.value, { stream: true })}`.split("\n")
        const remainder = lines.pop() ?? ""
        await lines.reduce(
          (previous, line) => previous.then(() => offerLine(line)),
          Promise.resolve(),
        )
        await pump(remainder)
      }
      await pump("")
    },
    catch: (cause) => commandError("read CLI JSONL", cause),
  })

export const packedCli = Effect.acquireRelease(
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "lumen-sync-e2e-")),
      catch: (cause) => commandError("create E2E workspace", cause),
    })
    const archive = yield* packArchive(root)
    const consumer = join(root, "consumer")
    yield* Effect.tryPromise({
      try: () => mkdir(consumer, { recursive: true }),
      catch: (cause) => commandError("create package consumer", cause),
    })
    yield* requireSuccess(["npm", "init", "--yes"], consumer)
    yield* requireSuccess(["npm", "install", "--ignore-scripts", archive], consumer)
    const executable = join(consumer, "node_modules", ".bin", "lumen-sync")

    const write = Effect.fn("E2E.PackedCli.write")(function* (path: string, contents: string) {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, contents)
        },
        catch: (cause) => commandError("write E2E file", cause),
      })
    })

    const writeExecutable = Effect.fn("E2E.PackedCli.writeExecutable")(function* (
      path: string,
      contents: string,
    ) {
      yield* write(path, contents)
      yield* Effect.tryPromise({
        try: () => chmod(path, 0o755),
        catch: (cause) => commandError("make E2E file executable", cause),
      })
    })

    const run = Effect.fn("E2E.PackedCli.run")(function* (
      arguments_: ReadonlyArray<string>,
      environment: Readonly<Record<string, string | undefined>>,
    ) {
      const result = yield* runCommand([executable, ...arguments_], {
        cwd: consumer,
        environment,
      })
      return {
        ...result,
        events: yield* parseEvents(result.stdout),
      }
    })

    const start = Effect.fn("E2E.PackedCli.start")(function* (
      arguments_: ReadonlyArray<string>,
      environment: Readonly<Record<string, string | undefined>>,
    ) {
      const child = Bun.spawn([executable, ...arguments_], {
        cwd: consumer,
        env: definedEnvironment(environment),
        stderr: "pipe",
        stdout: "pipe",
      })
      const events = yield* Queue.unbounded<typeof CliEvent.Type>()
      const stdoutFiber = yield* streamEvents(child.stdout, events).pipe(Effect.forkScoped)
      const stderr = Effect.tryPromise({
        try: () => new Response(child.stderr).text(),
        catch: (cause) => commandError("read CLI stderr", cause),
      })
      return {
        events,
        exitCode: Effect.promise(() => child.exited),
        stderr,
        stop: Effect.sync(() => child.kill("SIGTERM")).pipe(
          Effect.andThen(Effect.promise(() => child.exited)),
          Effect.asVoid,
        ),
        stdoutDone: Fiber.join(stdoutFiber),
      } satisfies RunningCli
    })

    const makeHome = Effect.fn("E2E.PackedCli.makeHome")(function* (name: string) {
      return yield* Effect.tryPromise({
        try: () => mkdtemp(join(root, `${name}-`)),
        catch: (cause) => commandError("create isolated home", cause),
      })
    })

    return {
      consumer,
      executable,
      makeHome,
      run,
      start,
      write,
      writeExecutable,
    } satisfies PackedCli
  }),
  ({ consumer }) =>
    Effect.tryPromise(() => rm(resolve(consumer, ".."), { force: true, recursive: true })).pipe(
      Effect.ignore,
    ),
)

export const isolatedEnvironment = (
  home: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> =>
  definedEnvironment({
    HOME: home,
    LANG: "C.UTF-8",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    ...overrides,
  })
