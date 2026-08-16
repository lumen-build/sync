import { Schema } from "effect"

export class MissingCredential extends Schema.TaggedError<MissingCredential>()(
  "MissingCredential",
  {
    source: Schema.String,
  },
) {}

export class AuthenticationFailed extends Schema.TaggedError<AuthenticationFailed>()(
  "AuthenticationFailed",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

export class SecretStoreError extends Schema.TaggedError<SecretStoreError>()("SecretStoreError", {
  cause: Schema.Defect(),
  operation: Schema.String,
}) {}
