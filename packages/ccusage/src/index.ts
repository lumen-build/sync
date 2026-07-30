import type {
  CcusageDailyBatch,
  UsageCostSnapshot,
  UsageSnapshot,
} from "@lumen-build/sync-contracts"
import {
  CcusageDailyBatch as CcusageDailyBatchSchema,
  NonNegativeSafeInteger,
  UsageDay,
  addUsageTokens,
  defaultProviderForAgent,
  usageSnapshotKey,
} from "@lumen-build/sync-contracts"
import { Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const CCUSAGE_VERSION = "20.0.19"

export const CcusageAgent = Schema.Literals(["claude", "codex", "copilot", "gemini", "opencode"])

export type CcusageAgent = typeof CcusageAgent.Type

const Cost = Schema.Number.check(
  Schema.isFinite({ message: "expected a finite cost" }),
  Schema.isGreaterThanOrEqualTo(0, { message: "expected a non-negative cost" }),
)

const CommonModelBreakdown = Schema.Struct({
  cacheCreationTokens: NonNegativeSafeInteger,
  cacheReadTokens: NonNegativeSafeInteger,
  cost: Cost,
  inputTokens: NonNegativeSafeInteger,
  modelName: Schema.NonEmptyString,
  outputTokens: NonNegativeSafeInteger,
})

const CommonDailyRow = Schema.Struct({
  cacheCreationTokens: NonNegativeSafeInteger,
  cacheReadTokens: NonNegativeSafeInteger,
  credits: Schema.optionalKey(Cost),
  date: UsageDay,
  inputTokens: NonNegativeSafeInteger,
  messageCount: Schema.optionalKey(NonNegativeSafeInteger),
  modelBreakdowns: Schema.Array(CommonModelBreakdown),
  modelsUsed: Schema.Array(Schema.NonEmptyString),
  outputTokens: NonNegativeSafeInteger,
  project: Schema.optionalKey(Schema.NonEmptyString),
  totalCost: Cost,
  totalTokens: NonNegativeSafeInteger,
})

const CommonTotals = Schema.Struct({
  cacheCreationTokens: NonNegativeSafeInteger,
  cacheReadTokens: NonNegativeSafeInteger,
  credits: Schema.optionalKey(Cost),
  inputTokens: NonNegativeSafeInteger,
  outputTokens: NonNegativeSafeInteger,
  totalCost: Cost,
  totalTokens: NonNegativeSafeInteger,
})

const CommonDailyReport = Schema.Struct({
  daily: Schema.Array(CommonDailyRow),
  totals: CommonTotals,
})

const CodexModelUsage = Schema.Struct({
  cacheCreationTokens: NonNegativeSafeInteger,
  cacheReadTokens: NonNegativeSafeInteger,
  inputTokens: NonNegativeSafeInteger,
  isFallback: Schema.Boolean,
  outputTokens: NonNegativeSafeInteger,
  reasoningOutputTokens: NonNegativeSafeInteger,
  totalTokens: NonNegativeSafeInteger,
})

const CodexDailyRow = Schema.Struct({
  cacheCreationTokens: NonNegativeSafeInteger,
  cacheReadTokens: NonNegativeSafeInteger,
  costUSD: Cost,
  date: UsageDay,
  inputTokens: NonNegativeSafeInteger,
  models: Schema.Record(Schema.NonEmptyString, CodexModelUsage),
  outputTokens: NonNegativeSafeInteger,
  reasoningOutputTokens: NonNegativeSafeInteger,
  totalTokens: NonNegativeSafeInteger,
})

const CodexTotals = Schema.Struct({
  cacheCreationTokens: NonNegativeSafeInteger,
  cacheReadTokens: NonNegativeSafeInteger,
  costUSD: Cost,
  inputTokens: NonNegativeSafeInteger,
  outputTokens: NonNegativeSafeInteger,
  reasoningOutputTokens: NonNegativeSafeInteger,
  totalTokens: NonNegativeSafeInteger,
})

const CodexDailyReport = Schema.Struct({
  daily: Schema.Array(CodexDailyRow),
  totals: CodexTotals,
})

export class InvalidCcusageReport extends Schema.TaggedErrorClass<InvalidCcusageReport>()(
  "InvalidCcusageReport",
  {
    agent: CcusageAgent,
    reason: Schema.String,
  },
) {}

export class CcusageCommandFailed extends Schema.TaggedErrorClass<CcusageCommandFailed>()(
  "CcusageCommandFailed",
  {
    agent: CcusageAgent,
    exitCode: Schema.optionalKey(Schema.Number),
    reason: Schema.String,
  },
) {}

export interface ImportDailyInput {
  readonly agent: CcusageAgent
  readonly capturedAt: string
  readonly deviceId: string
  readonly sourceVersion: string
  readonly stdout: string
  readonly syncId: string
}

export interface RunDailyInput {
  readonly agent: CcusageAgent
  readonly since: string
  readonly until: string
}

export interface CommandOutput {
  readonly stderr: string
  readonly stdout: string
}

export interface CcusageImporterInterface {
  readonly importDaily: (
    input: ImportDailyInput,
  ) => Effect.Effect<CcusageDailyBatch, InvalidCcusageReport>
}

export class CcusageImporter extends Context.Service<CcusageImporter, CcusageImporterInterface>()(
  "@lumen-build/sync/CcusageImporter",
) {}

export interface CcusageCommandInterface {
  readonly runDaily: (input: RunDailyInput) => Effect.Effect<CommandOutput, CcusageCommandFailed>
}

export class CcusageCommand extends Context.Service<CcusageCommand, CcusageCommandInterface>()(
  "@lumen-build/sync/CcusageCommand",
) {}

const aggregateSnapshots = (
  snapshots: ReadonlyArray<UsageSnapshot>,
): ReadonlyArray<UsageSnapshot> => {
  const byIdentity = new Map<string, UsageSnapshot>()
  for (const snapshot of snapshots) {
    const key = usageSnapshotKey(snapshot)
    const existing = byIdentity.get(key)
    byIdentity.set(
      key,
      existing === undefined
        ? snapshot
        : {
            ...existing,
            tokens: addUsageTokens(existing.tokens, snapshot.tokens),
          },
    )
  }
  return [...byIdentity.values()].toSorted((left, right) =>
    usageSnapshotKey(left).localeCompare(usageSnapshotKey(right)),
  )
}

const aggregateCosts = (
  agent: CcusageAgent,
  rows: ReadonlyArray<{ readonly day: string; readonly usd: number }>,
): ReadonlyArray<UsageCostSnapshot> => {
  const byDay = new Map<string, number>()
  for (const row of rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.usd)
  }
  return [...byDay.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([day, usd]) => ({
      agent,
      coverage: "source-reported",
      day,
      estimatedCostNanoUsd: Math.round(usd * 1_000_000_000),
      unpricedEvents: 0,
    }))
}

const parseJson = (
  agent: CcusageAgent,
  stdout: string,
): Effect.Effect<unknown, InvalidCcusageReport> =>
  Effect.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: (cause) =>
      new InvalidCcusageReport({
        agent,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const commonSnapshots = (
  agent: Exclude<CcusageAgent, "codex">,
  report: typeof CommonDailyReport.Type,
): ReadonlyArray<UsageSnapshot> =>
  aggregateSnapshots(
    report.daily.flatMap((row) =>
      row.modelBreakdowns.map((model) => ({
        agent,
        day: row.date,
        model: model.modelName,
        provider: defaultProviderForAgent(agent),
        tokens: {
          cacheCreationInput: model.cacheCreationTokens,
          cacheReadInput: model.cacheReadTokens,
          input: model.inputTokens,
          output: model.outputTokens,
          reasoningOutput: 0,
          tool: 0,
        },
      })),
    ),
  )

const codexSnapshots = (report: typeof CodexDailyReport.Type): ReadonlyArray<UsageSnapshot> =>
  aggregateSnapshots(
    report.daily.flatMap((row) =>
      Object.entries(row.models).map(([model, usage]) => ({
        agent: "codex",
        day: row.date,
        model,
        provider: "openai",
        tokens: {
          cacheCreationInput: usage.cacheCreationTokens,
          cacheReadInput: usage.cacheReadTokens,
          input: usage.inputTokens,
          output: usage.outputTokens,
          reasoningOutput: usage.reasoningOutputTokens,
          tool: 0,
        },
      })),
    ),
  )

const decodeReport = <S extends Schema.Constraint>(
  agent: CcusageAgent,
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(
      (error) =>
        new InvalidCcusageReport({
          agent,
          reason: error.message,
        }),
    ),
  )

export const makeImporter = Effect.succeed(
  CcusageImporter.of({
    importDaily: Effect.fn("CcusageImporter.importDaily")(function* (input) {
      const value = yield* parseJson(input.agent, input.stdout)
      let normalized: {
        readonly costs: ReadonlyArray<UsageCostSnapshot>
        readonly snapshots: ReadonlyArray<UsageSnapshot>
      }
      if (input.agent === "codex") {
        const report = yield* decodeReport(input.agent, CodexDailyReport, value)
        normalized = {
          costs: aggregateCosts(
            input.agent,
            report.daily.map((row) => ({ day: row.date, usd: row.costUSD })),
          ),
          snapshots: codexSnapshots(report),
        }
      } else {
        const report = yield* decodeReport(input.agent, CommonDailyReport, value)
        normalized = {
          costs: aggregateCosts(
            input.agent,
            report.daily.map((row) => ({ day: row.date, usd: row.totalCost })),
          ),
          snapshots: commonSnapshots(input.agent, report),
        }
      }

      return yield* Schema.decodeUnknownEffect(CcusageDailyBatchSchema)({
        source: "ccusage-daily",
        capturedAt: input.capturedAt,
        costs: normalized.costs,
        deviceId: input.deviceId,
        snapshots: normalized.snapshots,
        sourceVersion: input.sourceVersion,
        syncId: input.syncId,
        timeZone: "UTC",
      }).pipe(
        Effect.mapError(
          (error) =>
            new InvalidCcusageReport({
              agent: input.agent,
              reason: error.message,
            }),
        ),
      )
    }),
  }),
)

export const importerLayer = Layer.effect(CcusageImporter, makeImporter)

export const buildArguments = ({ agent, since, until }: RunDailyInput): ReadonlyArray<string> => [
  agent,
  "daily",
  "--json",
  "--offline",
  "--timezone",
  "UTC",
  "--since",
  since.replaceAll("-", ""),
  "--until",
  until.replaceAll("-", ""),
]

export const DEFAULT_CCUSAGE_TIMEOUT_MS = 60_000

const collectText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  )

export interface CommandOptions {
  readonly executable?: string
  readonly prefixArguments?: ReadonlyArray<string>
  readonly timeoutMs?: number
}

export const makeCommand = ({
  executable = "ccusage",
  prefixArguments = [],
  timeoutMs = DEFAULT_CCUSAGE_TIMEOUT_MS,
}: CommandOptions = {}): Effect.Effect<
  CcusageCommand["Service"],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return CcusageCommand.of({
      runDaily: Effect.fn("CcusageCommand.runDaily")(function* (input) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return yield* new CcusageCommandFailed({
            agent: input.agent,
            reason: `ccusage timeout must be a positive finite number, received ${timeoutMs}`,
          })
        }

        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(executable, [...prefixArguments, ...buildArguments(input)], {
                stderr: "pipe",
                stdout: "pipe",
              }),
            )
            return yield* Effect.all(
              {
                exitCode: child.exitCode,
                stderr: collectText(child.stderr),
                stdout: collectText(child.stdout),
              },
              { concurrency: "unbounded" },
            ).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(timeoutMs),
                orElse: () =>
                  Effect.fail(
                    new CcusageCommandFailed({
                      agent: input.agent,
                      reason: `ccusage timed out after ${timeoutMs}ms`,
                    }),
                  ),
              }),
            )
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof CcusageCommandFailed
              ? cause
              : new CcusageCommandFailed({
                  agent: input.agent,
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
          ),
        )
        if (outcome.exitCode !== 0) {
          return yield* new CcusageCommandFailed({
            agent: input.agent,
            exitCode: Number(outcome.exitCode),
            reason: outcome.stderr.trim() || `ccusage exited with code ${outcome.exitCode}`,
          })
        }
        return { stderr: outcome.stderr, stdout: outcome.stdout }
      }),
    })
  })

export const commandLayer = (options?: CommandOptions) =>
  Layer.effect(CcusageCommand, makeCommand(options))

export const commandLayerTest = (
  runDaily: CcusageCommandInterface["runDaily"],
): Layer.Layer<CcusageCommand> =>
  Layer.succeed(
    CcusageCommand,
    CcusageCommand.of({
      runDaily: Effect.fn("CcusageCommand.Test.runDaily")(runDaily),
    }),
  )
