import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { CcusageAgent } from "@lumen-build/sync-ccusage"
import { Duration, Effect, Schema } from "effect"

import type { AimockCompletionRequest } from "./harness-interaction.js"
import { definedEnvironment, type PackedCli } from "./packed-cli.js"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const fixtureDirectory = join(repositoryRoot, "packages", "sync", "e2e", "fixtures", "harness")

export const HarnessAgent = CcusageAgent
export type HarnessAgent = typeof HarnessAgent.Type

export class HarnessE2eError extends Schema.TaggedErrorClass<HarnessE2eError>()("HarnessE2eError", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

const failure = (operation: string, cause: unknown): HarnessE2eError =>
  new HarnessE2eError({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

export interface ExternalCommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export const runExternal = Effect.fn("E2E.Harness.runExternal")(function* (
  command: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly timeout?: Duration.Input
  },
) {
  const debug = process.env.LUMEN_HARNESS_DEBUG === "1"
  const captured = (
    stream: ReadableStream<Uint8Array>,
    destination: { readonly write: (chunk: Uint8Array) => unknown },
  ): Promise<string> =>
    new Response(
      stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (debug) destination.write(chunk)
            controller.enqueue(chunk)
          },
        }),
      ),
    ).text()
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([...command], {
          cwd: options.cwd,
          env: definedEnvironment(options.environment),
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe",
        }),
      catch: (cause) => failure(`start ${command[0] ?? "command"}`, cause),
    }),
    (process) =>
      Effect.sync(() => {
        process.kill("SIGTERM")
      }).pipe(Effect.ignore),
  )

  return yield* Effect.tryPromise({
    try: async () => {
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        captured(child.stderr, process.stderr),
        captured(child.stdout, process.stdout),
      ])
      return { exitCode, stderr, stdout }
    },
    catch: (cause) => failure(`run ${command[0] ?? "command"}`, cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout ?? "60 seconds",
      orElse: () =>
        Effect.fail(
          new HarnessE2eError({
            operation: `run ${command[0] ?? "command"}`,
            reason: `timed out after ${String(options.timeout ?? "60 seconds")}`,
          }),
        ),
    }),
  )
})

const requireSuccess = Effect.fn("E2E.Harness.requireSuccess")(function* (
  command: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly timeout?: Duration.Input
  },
) {
  const result = yield* runExternal(command, options)
  if (result.exitCode !== 0) {
    return yield* new HarnessE2eError({
      operation: `run ${command[0] ?? "command"}`,
      reason:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `command exited with code ${result.exitCode}`,
    })
  }
  return result
})

export interface HarnessDependencies {
  readonly binDirectory: string
  readonly executable: Readonly<Record<HarnessAgent, string>>
  readonly node: string
  readonly root: string
}

export const harnessDependencies = Effect.acquireRelease(
  Effect.gen(function* () {
    const provided = process.env.LUMEN_HARNESS_FIXTURE_NODE_MODULES
    const owned = provided === undefined
    const root = owned
      ? yield* Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), "lumen-harness-dependencies-")),
          catch: (cause) => failure("create harness dependency workspace", cause),
        })
      : resolve(provided, "..")

    if (owned) {
      yield* Effect.tryPromise({
        try: async () => {
          await copyFile(join(fixtureDirectory, "package.json"), join(root, "package.json"))
          await copyFile(
            join(fixtureDirectory, "package-lock.json"),
            join(root, "package-lock.json"),
          )
        },
        catch: (cause) => failure("copy harness dependency fixture", cause),
      })
      yield* requireSuccess(["npm", "ci", "--no-audit", "--no-fund"], {
        cwd: root,
        environment: process.env,
        timeout: "3 minutes",
      })
    }

    const nodeModules = owned ? join(root, "node_modules") : resolve(provided)
    return {
      owned,
      public: {
        binDirectory: join(nodeModules, ".bin"),
        executable: {
          claude: join(nodeModules, ".bin", "claude"),
          codex: join(nodeModules, ".bin", "codex"),
          copilot: join(nodeModules, ".bin", "copilot"),
          gemini: join(nodeModules, ".bin", "gemini"),
          opencode: join(nodeModules, ".bin", "opencode"),
        },
        node: join(nodeModules, "node", "bin", "node"),
        root,
      } satisfies HarnessDependencies,
    }
  }),
  ({ owned, public: dependencies }) =>
    owned
      ? Effect.tryPromise(() => rm(dependencies.root, { force: true, recursive: true })).pipe(
          Effect.ignore,
        )
      : Effect.void,
).pipe(Effect.map(({ public: value }) => value))

interface AimockJournalEntry {
  readonly body: unknown
  readonly method: string
  readonly path: string
  readonly response: {
    readonly source?: "fixture" | "internal" | "proxy"
    readonly status: number
  }
}

interface AimockInstance {
  readonly getRequests: () => ReadonlyArray<AimockJournalEntry>
  readonly onMessage: (
    pattern: string | RegExp,
    response: (request: AimockCompletionRequest) => unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => AimockInstance
  readonly start: () => Promise<string>
  readonly stop: () => Promise<void>
  readonly url: string
}

interface AimockModule {
  readonly LLMock: new (options: Readonly<Record<string, unknown>>) => AimockInstance
}

export interface Aimock {
  readonly completions: Effect.Effect<ReadonlyArray<AimockCompletionRequest>>
  readonly requests: Effect.Effect<ReadonlyArray<AimockJournalEntry>>
  readonly url: string
}

export const aimock = (
  dependencies: HarnessDependencies,
  canary: string,
  response: (request: AimockCompletionRequest) => unknown,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const entry = join(
        dependencies.root,
        "node_modules",
        "@copilotkit",
        "aimock",
        "dist",
        "index.js",
      )
      const module = yield* Effect.tryPromise({
        try: () => import(pathToFileURL(entry).href) as Promise<AimockModule>,
        catch: (cause) => failure("load pinned aimock", cause),
      })
      const mock = new module.LLMock({
        host: "127.0.0.1",
        logLevel: "silent",
        port: 0,
        strict: true,
      })
      const completions: Array<AimockCompletionRequest> = []
      mock.onMessage(canary, (request) => {
        completions.push(request)
        return response(request)
      })
      yield* Effect.tryPromise({
        try: () => mock.start(),
        catch: (cause) => failure("start aimock", cause),
      })
      return {
        mock,
        public: {
          completions: Effect.sync(() => [...completions]),
          requests: Effect.sync(() => mock.getRequests()),
          url: mock.url,
        } satisfies Aimock,
      }
    }),
    ({ mock }) => Effect.tryPromise(() => mock.stop()).pipe(Effect.ignore),
  ).pipe(Effect.map(({ public: value }) => value))

export const loopbackPort = Effect.acquireUseRelease(
  Effect.try({
    try: () =>
      Bun.serve({
        fetch: () => new Response("reserved"),
        hostname: "127.0.0.1",
        port: 0,
      }),
    catch: (cause) => failure("reserve loopback port", cause),
  }),
  (server) => Effect.succeed(server.port),
  (server) =>
    Effect.sync(() => {
      server.stop(true)
    }),
)

export const readJsonFile = <A = unknown>(path: string): Effect.Effect<A, HarnessE2eError> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as A,
    catch: (cause) => failure(`read ${path}`, cause),
  })

export const readTextFile = (path: string): Effect.Effect<string, HarnessE2eError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => failure(`read ${path}`, cause),
  })

const packedOpenCodePluginTarget = (home: string): string =>
  join(
    home,
    ".cache",
    "opencode",
    "packages",
    "@lumen-build",
    "sync@latest",
    "node_modules",
    "@lumen-build",
    "sync",
  )

export const linkPackedOpenCodePlugin = (
  cli: PackedCli,
  home: string,
): Effect.Effect<void, HarnessE2eError> =>
  Effect.tryPromise({
    try: async () => {
      const target = packedOpenCodePluginTarget(home)
      const scope = join(target, "..")
      await mkdir(scope, { recursive: true })
      await symlink(join(cli.consumer, "node_modules", "@lumen-build", "sync"), target, "junction")
    },
    catch: (cause) => failure("link packed OpenCode plugin", cause),
  })
