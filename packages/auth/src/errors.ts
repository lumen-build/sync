import { Schema } from "effect"

export class MissingCredential extends Schema.TaggedErrorClass<MissingCredential>()(
  "MissingCredential",
  {
    source: Schema.String,
  },
) {}

export class AuthenticationFailed extends Schema.TaggedErrorClass<AuthenticationFailed>()(
  "AuthenticationFailed",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

export class SecretStoreError extends Schema.TaggedErrorClass<SecretStoreError>()(
  "SecretStoreError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}
