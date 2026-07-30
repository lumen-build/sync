import { Context, Effect, Schema } from "effect"

export class DeviceIdentityError extends Schema.TaggedErrorClass<DeviceIdentityError>()(
  "DeviceIdentityError",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {}

export interface DeviceIdentityInterface {
  readonly loadOrCreate: (path: string) => Effect.Effect<string, DeviceIdentityError>
}

export class DeviceIdentity extends Context.Service<DeviceIdentity, DeviceIdentityInterface>()(
  "@lumen-build/sync/DeviceIdentity",
) {}
