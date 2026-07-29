# Library API

Install the package locally when embedding it:

```sh
bun add @lumen-build/sync
```

The package currently pins Effect `4.0.0-beta.102`. Its Effect-facing API should
be treated as beta until Effect 4 is stable.

## Entry points

| Import                        | Purpose                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@lumen-build/sync`           | Namespaced Auth, ccusage, collector, configuration, destination, harness, OTLP, reconciliation, runtime, service, and device-identity APIs |
| `@lumen-build/sync/bun`       | Bun collector, harness-filesystem, service, journal, and device-identity layers                                                            |
| `@lumen-build/sync/contracts` | Runtime schemas and TypeScript types for receiver and CLI envelopes                                                                        |
| `@lumen-build/sync/opencode`  | Direct OpenCode plugin integration                                                                                                         |
| `@lumen-build/sync/server`    | OpenCode’s package-plugin discovery entry                                                                                                  |

The `./server` entry is for OpenCode discovery. Application code should import
the plugin from `./opencode`.

## Validate receiver payloads

All receiver wire schemas are runtime codecs, not TypeScript-only declarations:

```ts
import {
  DailySyncCommittedResponse,
  DailySyncStartRequest,
  DailySyncStartedResponse,
  DailySyncUploadRequest,
  OtelLiveBatch,
  UsageAcceptedResponse,
} from "@lumen-build/sync/contracts"
import { Effect, Schema } from "effect"

const decodeLiveBatch = (input: unknown) =>
  Schema.decodeUnknownEffect(OtelLiveBatch, {
    onExcessProperty: "error",
  })(input)

const batch = await Effect.runPromise(decodeLiveBatch(requestBody))

const dailyStart = await Effect.runPromise(
  Schema.decodeUnknownEffect(DailySyncStartRequest)(dailyStartBody),
)
const dailyUpload = await Effect.runPromise(
  Schema.decodeUnknownEffect(DailySyncUploadRequest)(dailyUploadBody),
)
```

`UsageAcceptedResponse`, `DailySyncStartedResponse`, and
`DailySyncCommittedResponse` decode the three successful destination response
shapes. `CcusageDailyBatch`, `UsageSnapshot`, `UsageCostSnapshot`, `CliEvent`,
and their associated types are exported from the same entry point.

## Decode configuration with environment overrides

```ts
import { Config } from "@lumen-build/sync"
import { Effect } from "effect"

const configuration = await Effect.runPromise(
  Config.decodeWithEnvironment(
    {
      collector: { listen_url: "http://127.0.0.1:4318" },
      destination: { base_url: "https://usage.lumen.build" },
      auth: { mode: "bearer" },
    },
    process.env,
  ),
)
```

Use `Config.resolveRuntimePaths` when an embedding application needs the same
macOS, Linux, and Windows path rules as the CLI.

## Send a batch to a receiver

The destination client depends on an HTTP client and a credential provider.
Layers make both dependencies explicit:

```ts
import { BunHttpClient } from "@effect/platform-bun"
import { Auth, Destination } from "@lumen-build/sync"
import { Effect, Layer, Redacted } from "effect"

const credentials = Auth.bearerCredentialLayer({
  token: Effect.succeed(Redacted.make(process.env.LUMEN_BEARER_TOKEN ?? "")),
})

const destination = Destination.layer({
  baseUrl: "https://usage.lumen.build",
}).pipe(Layer.provide(Layer.merge(BunHttpClient.layer, credentials)))

const accepted = await Effect.runPromise(
  Effect.gen(function* () {
    const receiver = yield* Destination.Destination
    return yield* receiver.putLive(batch)
  }).pipe(Effect.provide(destination)),
)
```

Production code should validate that the token exists before creating the
layer. The CLI’s bearer and OIDC adapters provide that validation. The
`lumen.build` URL in this example is mocked by this repository's tests; it is
not a package default or hosted receiver.

Embedding applications that need login/logout persistence can use
`Auth.storedBearerCredentialLayer` with an application-owned `SecretStore`.
The live token effect wins when present; `login` persists it, `accessToken`
falls back to the stored value, and `logout` removes it.

## Authenticate receiver requests

Receiver applications can validate OIDC JWT access tokens against issuer
discovery and JWKS. Both issuer and audience are operator-supplied:

```ts
import { BunHttpClient } from "@effect/platform-bun"
import { Auth } from "@lumen-build/sync"
import { Effect, Layer, Redacted } from "effect"

const authentication = Auth.oidcJwtAuthenticatorLayer({
  audience: process.env.LUMEN_RECEIVER_AUDIENCE ?? "",
  issuer: process.env.LUMEN_RECEIVER_ISSUER ?? "",
}).pipe(Layer.provide(BunHttpClient.layer))

const principal = await Effect.runPromise(
  Effect.gen(function* () {
    const authenticator = yield* Auth.RequestAuthenticator
    return yield* authenticator.authenticate(Redacted.make(accessToken))
  }).pipe(Effect.provide(authentication)),
)
```

For opaque access tokens, use `Auth.oidcIntrospectionAuthenticatorLayer` with
the same required `issuer` and `audience`, plus the provider's `subjectClaim`
and optional `clientId`. Introspection rejects inactive tokens, missing or
mismatched audiences, and empty subjects. Discovery and every advertised OIDC
endpoint must use HTTPS; plain HTTP is accepted only when the configured issuer
itself is an explicit loopback URL for local tests.

`Auth.bearerAuthenticatorLayer` accepts an application-owned verification
effect when the receiver uses a shared or otherwise custom bearer-token scheme.
Never construct these layers with empty environment values in production.

## Reconcile live and daily sources

Reconciliation always requires an explicit policy:

```ts
import { Reconciliation } from "@lumen-build/sync"
import { Effect } from "effect"

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const reconciliation = yield* Reconciliation.make
    return yield* reconciliation.reconcile({
      baselines: [],
      ccusage,
      ccusageCosts: [],
      costBaselines: [],
      otel,
      otelCosts: [],
      policy: "separate",
    })
  }),
)
```

Choose `separate` when provider/model identity cannot be matched
unambiguously. The baseline-plus-live-delta policy requires baselines captured
with `Reconciliation.captureBaseline`.

## Embed a Bun OTLP collector

```ts
import { bunCollectorServerLayer } from "@lumen-build/sync/bun"
import { Collector, Runtime } from "@lumen-build/sync"
import { Effect, Layer } from "effect"

const collector = Collector.collectorLayer({
  deviceId: crypto.randomUUID(),
  maxBodyBytes: 4 * 1024 * 1024,
})
const server = bunCollectorServerLayer.pipe(Layer.provide(collector))
const runtime = Layer.merge(collector, server)

await Effect.runPromise(
  Runtime.runLocalCollector({
    hostname: "127.0.0.1",
    port: 4318,
  }).pipe(Effect.provide(runtime)),
)
```

Use a persistent collector state path and the exported Bun filesystem services
when live revisions must survive restarts. The CLI already assembles that
production layer graph.

## Reference receiver

[`examples/receiver`](../examples/receiver) is an Effect-based, runnable
implementation of the HTTP contract. Its test consumes
[`destination-conformance.json`](./destination-conformance.json), verifies
replays and conflicts, and asserts exact input/output token preservation.
