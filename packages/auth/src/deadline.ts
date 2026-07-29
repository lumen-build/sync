import { Effect } from "effect"

import { AuthenticationFailed } from "./errors.js"

export const AUTHENTICATION_REQUEST_TIMEOUT = "30 seconds"
export const AUTHENTICATION_REQUEST_TIMEOUT_MILLIS = 30_000

export const withAuthenticationDeadline = <A, R>(
  operation: string,
  request: Effect.Effect<A, AuthenticationFailed, R>,
): Effect.Effect<A, AuthenticationFailed, R> =>
  request.pipe(
    Effect.timeoutOrElse({
      duration: AUTHENTICATION_REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new AuthenticationFailed({
            operation,
            reason: `timed out after ${AUTHENTICATION_REQUEST_TIMEOUT}`,
          }),
        ),
    }),
  )
