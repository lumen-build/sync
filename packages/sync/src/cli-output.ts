import {
  CliEvent as CliEventSchema,
  type CliError,
  type CliEvent,
  type CliEventData,
} from "@lumen-build/sync-contracts"
import { Clock, Console, Context, Effect, Layer, Ref, Schema } from "effect"

export type CliOutputType = Exclude<CliEvent["type"], "error">

export interface CliOutputEvent {
  readonly command: string
  readonly data: CliEventData
  readonly plain?: string
  readonly type: CliOutputType
}

export interface CliOutputError {
  readonly command: string
  readonly error: CliError
  readonly plain?: string
}

export interface CliOutputInterface {
  readonly emit: (event: CliOutputEvent) => Effect.Effect<void>
  readonly emitError: (event: CliOutputError) => Effect.Effect<void>
}

export class CliOutput extends Context.Service<CliOutput, CliOutputInterface>()(
  "@lumen-build/sync/CliOutput",
) {}

const encodeEvent = Schema.encodeSync(CliEventSchema)

const writeJson = (event: CliEvent): Effect.Effect<void> =>
  Console.log(JSON.stringify(encodeEvent(event)))

export const layer = (json: boolean): Layer.Layer<CliOutput> =>
  Layer.effect(
    CliOutput,
    Effect.gen(function* () {
      const sequence = yield* Ref.make(0)
      const common = Effect.fn("CliOutput.common")(function* (command: string) {
        return {
          command,
          protocolVersion: 1 as const,
          sequence: yield* Ref.updateAndGet(sequence, (current) => current + 1),
          timestamp: new Date(yield* Clock.currentTimeMillis).toISOString(),
        }
      })
      return CliOutput.of({
        emit: (event) =>
          json
            ? common(event.command).pipe(
                Effect.flatMap((fields) =>
                  writeJson({
                    ...fields,
                    data: event.data,
                    type: event.type,
                  }),
                ),
              )
            : Console.log(event.plain ?? JSON.stringify(event.data)),
        emitError: (event) =>
          json
            ? common(event.command).pipe(
                Effect.flatMap((fields) =>
                  writeJson({
                    ...fields,
                    error: event.error,
                    type: "error",
                  }),
                ),
              )
            : Console.error(event.plain ?? event.error.message),
      })
    }),
  )
