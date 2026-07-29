import { Effect, Layer } from "effect"

import { Collector, CollectorServer, CollectorServerError } from "./index"

const serverError = (cause: unknown): CollectorServerError =>
  new CollectorServerError({
    reason: cause instanceof Error ? cause.message : String(cause),
  })

export const bunCollectorServerLayer: Layer.Layer<CollectorServer, never, Collector> = Layer.effect(
  CollectorServer,
  Effect.gen(function* () {
    const collector = yield* Collector
    return CollectorServer.of({
      listen: ({ hostname, port }) =>
        Effect.acquireRelease(
          Effect.try({
            try: () =>
              Bun.serve({
                fetch: (request) => Effect.runPromise(collector.handle(request)),
                hostname,
                port,
              }),
            catch: serverError,
          }),
          (server) => Effect.sync(() => server.stop(true)),
        ).pipe(
          Effect.flatMap((server) =>
            server.port === undefined
              ? Effect.fail(new CollectorServerError({ reason: "listener has no TCP port" }))
              : Effect.succeed({
                  port: server.port,
                  url: server.url.toString(),
                }),
          ),
        ),
    })
  }),
)
