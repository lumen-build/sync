# Lumen Sync

Lumen Sync is an open-source, Effect-native toolkit for collecting usage from AI coding agents and synchronizing it to a receiver you control. It includes an OTLP collector, a ccusage daily importer, privacy-safe harness configuration, bearer and OIDC authentication, and a CLI published as `@lumen-build/sync`.

It has no destination or collector endpoint defaults. Networked commands fail until you configure the relevant endpoint.

```text
agent harnesses ──OTLP──▶ local collector ──live, revisioned──▶ your receiver
       │
       └──local usage files──▶ ccusage ──daily, authoritative──▶ your receiver
```

## Requirements

- Bun 1.3.4 or newer (the workspace and CI pin exactly 1.3.4)
- A receiver that implements the documented destination contract
- One or more supported agent harnesses

The workspace pins Bun 1.3.4, Effect 4.0.0-beta.102, and ccusage 20.0.19.

## Install

Install the library in an application:

```sh
bun add @lumen-build/sync
```

Or install the CLI globally:

```sh
bun add --global @lumen-build/sync
lumen-sync --help
```

The package can also be used as a library:

```ts
import { Collector, Config, Harness, Reconciliation, Runtime } from "@lumen-build/sync"
```

Start with the focused references when embedding or operating the toolkit:

- [complete configuration and environment reference](./docs/configuration.md)
- [library entry points and Effect recipes](./docs/library-api.md)
- [runnable reference receiver](./examples/receiver)
- [receiver conformance exchanges](./docs/destination-conformance.json)

## Configure

Create the configuration with an explicit loopback collector URL:

```sh
lumen-sync config init --collector http://127.0.0.1:4318
```

Add a destination and bearer authentication in the same atomic operation:

```sh
lumen-sync config init \
  --collector http://127.0.0.1:4318 \
  --destination https://usage.lumen.build \
  --auth bearer
```

The `lumen.build` URL is illustrative and is intercepted in the test suite. It
is never selected by the package. `config init` requires a collector URL and
requires destination and authentication to be supplied together.

The default configuration path follows the host platform:

- macOS and Linux: `$XDG_CONFIG_HOME/lumen-build/sync/config.toml` or `~/.config/lumen-build/sync/config.toml`
- Windows: `%APPDATA%\lumen-build\sync\config.toml`
- Any platform: set `LUMEN_CONFIG` or pass `--config`

Linux data and state follow `XDG_DATA_HOME` and `XDG_STATE_HOME`; macOS uses
`~/Library/Application Support/lumen-build/sync`; Windows uses
`%LOCALAPPDATA%\lumen-build\sync`. An explicit `--config` or `LUMEN_CONFIG`
path intentionally colocates credentials, identity, and state beside that
configuration. CLI flags take precedence over `LUMEN_CONFIG`; endpoint and
authentication environment variables override TOML values.

The [configuration reference](./docs/configuration.md) lists every TOML key,
environment variable, platform path, and precedence rule.

This complete bearer example uses `https://usage.lumen.build` for illustration.
It is not a package default or assumed service, and tests intercept it rather
than making a network request.

```toml
[collector]
listen_url = "http://127.0.0.1:4318"

[destination]
base_url = "https://usage.lumen.build"

[auth]
mode = "bearer"
```

Provide secrets through the environment:

```sh
export LUMEN_BEARER_TOKEN="..."
lumen-sync config show
```

Commands use the environment value directly. To make the token available to a
background user service without embedding it in the service definition, store
it in the mode-`0600` credential file and then clear the environment:

```sh
LUMEN_BEARER_TOKEN="..." lumen-sync auth login
unset LUMEN_BEARER_TOKEN
```

`lumen-sync auth logout` removes the stored bearer token. Tokens are never
written to TOML.

Endpoint environment overrides are also supported:

```sh
export LUMEN_COLLECTOR_LISTEN_URL="http://127.0.0.1:4318"
export LUMEN_DESTINATION_BASE_URL="https://usage.lumen.build"
```

Plain HTTP is rejected except for loopback URLs used by the collector, a local
destination, or local OIDC issuer/callback testing.

### OIDC

OIDC supports local authorization-code + PKCE login and CI JWT-bearer exchange.

```toml
[auth]
mode = "oidc"

[auth.oidc]
issuer = "https://usage.lumen.build"
client_id = "lumen-sync"
audience = "https://usage.lumen.build"
redirect_uri = "http://127.0.0.1:9876/callback"
scopes = ["openid", "offline_access"]
validation = "jwks"
```

For local use:

```sh
lumen-sync auth login
```

The equivalent initializer is:

```sh
lumen-sync config init \
  --collector http://127.0.0.1:4318 \
  --destination https://usage.lumen.build \
  --auth oidc \
  --oidc-issuer https://usage.lumen.build \
  --oidc-client-id lumen-sync \
  --oidc-audience https://usage.lumen.build \
  --oidc-redirect-uri http://127.0.0.1:9876/callback \
  --oidc-scope openid \
  --oidc-scope offline_access
```

Refresh tokens are stored in a mode-`0600` file in the platform data directory,
or beside an explicitly selected configuration. Stored tokens are scoped to
the canonical issuer, client ID, and audience, so replacing an identity
provider cannot send its predecessor's refresh token to the new token
endpoint. Discovery requires HTTPS for the issuer and every advertised
endpoint; HTTP is accepted only when the configured issuer and advertised
endpoint are explicit loopback URLs. For CI, Lumen Sync accepts an explicit
`LUMEN_OIDC_ASSERTION` and detects GitHub Actions OIDC, GitLab CI JWT, and
CircleCI OIDC environments. OIDC discovery, refresh, revocation, JWKS
validation, and audience-checked introspection remain reusable library APIs.

## Configure agent harnesses

```sh
lumen-sync harness list
lumen-sync harness status
lumen-sync harness configure
lumen-sync harness configure --agent claude --agent codex
lumen-sync harness configure --agent gemini --force
lumen-sync harness remove
```

Existing JSONC comments and unrelated settings are retained. Conflicting managed values require `--force`. Removal restores only values that still match what Lumen Sync wrote; user changes are preserved.

| Harness            | Integration                    | Configuration                | Linux E2E evidence                                                                         |
| ------------------ | ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code        | Native OTLP metrics            | `~/.claude/settings.json`    | Real CLI; two strict requests, exact native aggregate, and exact final-request daily usage |
| Codex              | Native OTLP metrics            | `~/.codex/config.toml`       | Real CLI; one strict request and exact request-derived live and daily usage                |
| GitHub Copilot CLI | Native OTEL file plus ccusage  | Environment                  | Real CLI; one strict request, exact file telemetry, and exact daily usage                  |
| Gemini CLI         | Native OTLP collector          | `~/.gemini/settings.json`    | Real CLI; one strict request and exact request-derived daily usage; live OTLP not observed |
| OpenCode           | Usage-only plugin plus ccusage | XDG/APPDATA OpenCode config  | Real CLI; auxiliary and primary requests plus exact primary live and daily usage           |
| VS Code Copilot    | Native OTLP                    | VS Code user `settings.json` | Configuration and shaped telemetry tests only; no headless real-client E2E yet             |

Content capture is disabled. Claude and Codex are configured to send token metrics, not prompt-bearing logs. Gemini traces and prompt logging are disabled. VS Code and Copilot content capture are disabled.

OpenCode does not currently expose the same native telemetry configuration surface. `harness configure` adds the published `@lumen-build/sync` package to OpenCode's plugin list; the package exposes OpenCode's `./server` plugin entry while keeping `@lumen-build/sync/opencode` available for direct imports. The plugin listens for both legacy assistant-message events and current step events. It sends only usage, model, provider, cost, timestamp, and event identity. OpenCode must receive an explicit environment endpoint:

```sh
export LUMEN_COLLECTOR_OTLP_ENDPOINT="http://127.0.0.1:4318"
```

If the plugin cannot be used, OpenCode daily sync through ccusage remains available.

GitHub Copilot CLI does not expose its supported telemetry controls through
ordinary user settings. `harness configure --agent copilot` therefore reports
the exact environment it expects without modifying
`~/.copilot/settings.json`. The default managed path uses Copilot's documented
JSON-lines file exporter:

```sh
export COPILOT_OTEL_ENABLED="true"
export COPILOT_OTEL_EXPORTER_TYPE="file"
export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/lumen-sync.jsonl"
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT="false"
export OTEL_SERVICE_NAME="github-copilot"
```

Use the values printed by `harness configure` on Windows or when
`COPILOT_HOME` is set. `sync daily --agent copilot` reads that file through
ccusage. This path is a recoverable daily source, not a live upload. Copilot's
HTTP exporter refuses cleartext endpoints, including Lumen's loopback HTTP
collector; direct live export therefore requires an operator-supplied HTTPS
OTLP ingress and is not claimed by the local E2E.

The pinned OpenCode E2E resolves the installed tarball through OpenCode's native
package-plugin cache. It waits for the completed assistant event, then proves
the exact primary input/output pair through both the live plugin and ccusage.
OpenCode also makes an auxiliary title request; the strict mock proves that
request separately while the destination assertion proves that OpenCode's usage
surfaces expose only the primary call. Gemini CLI 0.53.0 consumes the exact
managed telemetry configuration and creates a non-empty ccusage report, but did
not flush native OTLP to the collector in a bounded test run. That limitation
is not hidden by injecting an undocumented endpoint or waiting indefinitely.

The harness settings follow the vendors’ observability and extension surfaces: [Claude Code](https://code.claude.com/docs/en/agent-sdk/observability), [Codex](https://learn.chatgpt.com/docs/config-file/config-advanced), [VS Code Copilot](https://code.visualstudio.com/docs/agents/guides/monitoring-agents), [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [Gemini CLI](https://geminicli.com/docs/cli/telemetry/), and [OpenCode plugins](https://opencode.ai/docs/plugins/).

## Run live collection

```sh
lumen-sync collector run
```

The listener must be an explicit HTTP loopback URL. OTLP/HTTP JSON and protobuf are supported at:

- `POST /v1/logs`
- `POST /v1/metrics`
- `POST /v1/traces`

Known native harnesses use token metrics as their live usage authority, which avoids counting the same inference again when a harness emits both an event and a metric. OpenCode uses usage-only logs. Events are fingerprinted, aggregated by UTC day/agent/provider/model, and uploaded as revisioned `otel-live` snapshots. Fingerprints follow the 45-day live retention window and are capped at 100,000 entries; a replay after its fingerprint has expired or been evicted is outside the deduplication guarantee.

After a successful upload, the CLI writes the collector's cumulative buckets,
revisions, and deduplication fingerprints to a mode-`0600` checkpoint beside
the configuration. A restarted service resumes from that checkpoint, so its
revision sequence remains compatible with the receiver. Events received after
the latest checkpoint can still be lost in a hard crash; the later ccusage
daily import is the recovery source for that window.

Each live upload is intentionally a cumulative recovery envelope rather than a
delta. That lets a new or restarted receiver reconstruct the latest state from
one accepted envelope, but upload and checkpoint work grows with the retained
bucket set. Retention and the 100,000-fingerprint cap bound that state; operators
should monitor checkpoint and request sizes when collecting many distinct
day/agent/provider/model identities.

For parsing tests or a receiver-less local experiment:

```sh
lumen-sync collector run --local-only
```

## Run daily sync

```sh
lumen-sync sync daily --since 2026-07-01 --until 2026-07-29
lumen-sync sync daily --agent claude --agent opencode
```

Lumen Sync invokes the pinned ccusage 20.0.19 executable with JSON, offline mode, and UTC day boundaries. Claude, Codex, Copilot, Gemini, and OpenCode are supported.

## Live OTLP versus ccusage daily data

OTLP and ccusage are different source products:

- `otel-live` is low-latency and revisioned.
- `ccusage-daily` is a later daily aggregate derived from local agent records.

The same usage can appear in both. A receiver must not blindly add the two sources. Every payload is source-tagged, and the reconciliation library requires an explicit policy:

- `separate`: preserve both views; safest receiver default.
- `otel-only`: use only live observations.
- `ccusage-only`: use only the daily aggregate.
- `ccusage-baseline-live-delta`: replace covered live history with ccusage, then add only live usage observed after the captured baseline.

The baseline-plus-delta policy deliberately refuses ambiguous identity matches. Keep the sources separate when models or providers cannot be matched unambiguously.

## Destination contract

The destination is an HTTP receiver supplied by the operator. Lumen Sync has no
built-in destination. Every `https://usage.lumen.build` URL below is an
illustrative, mocked test URL, not a hosted service or default.

### Transport and authorization

All four routes:

- use the configured HTTPS base URL, or an HTTP loopback URL for local testing;
- send `Accept: application/json`;
- send `Authorization: Bearer <access-token>`; and
- require a 2xx response with the JSON shape shown below.

Bearer mode sends the configured `LUMEN_BEARER_TOKEN`. OIDC mode first obtains
an OAuth access token through authorization-code + PKCE, refresh, or CI
JWT-bearer exchange, then sends that access token with the same Bearer header.
The CI assertion and refresh token are never sent to the destination. The three
daily-sync requests reuse one acquired access token. A receiver therefore sees
the same wire authentication for bearer and OIDC modes and must validate the
token according to its own configured bearer or OIDC policy.

JSON request routes also send `Content-Type: application/json`. The commit route
has no request body.

### Wire records

Usage snapshots have this shape:

```json
{
  "agent": "codex",
  "day": "2026-07-29",
  "model": "gpt-test",
  "provider": "openai",
  "tokens": {
    "cacheCreationInput": 0,
    "cacheReadInput": 2,
    "input": 11,
    "output": 3,
    "reasoningOutput": 1,
    "tool": 0
  }
}
```

Cost snapshots have this shape:

```json
{
  "agent": "codex",
  "coverage": "source-reported",
  "day": "2026-07-29",
  "estimatedCostNanoUsd": 125000000,
  "unpricedEvents": 0
}
```

`agent` is one of `claude`, `codex`, `copilot`, `gemini`, `opencode`,
`vscode`, or `unknown`. `coverage` is `complete`, `partial`, or
`source-reported`. Token, cost, and unpriced-event values are non-negative safe
integers. `model` and `provider` are non-empty strings of at most 256
characters. `day` is a valid `YYYY-MM-DD` UTC calendar day. `capturedAt` is a
canonical ISO-8601 UTC timestamp such as `2026-07-29T10:00:00.000Z`.
`deviceId` and `syncId` are version-4 UUIDs.

### Live snapshots

`PUT /v1/usage/otel-snapshots` receives the complete `otel-live` envelope:

```json
{
  "source": "otel-live",
  "capturedAt": "2026-07-29T10:00:00.000Z",
  "deviceId": "ec7100cb-d60f-479a-a136-85327ec03f8b",
  "snapshots": [
    {
      "agent": "codex",
      "day": "2026-07-29",
      "model": "gpt-test",
      "provider": "openai",
      "revision": 1,
      "tokens": {
        "cacheCreationInput": 0,
        "cacheReadInput": 2,
        "input": 11,
        "output": 3,
        "reasoningOutput": 1,
        "tool": 0
      }
    }
  ],
  "costs": [
    {
      "agent": "codex",
      "coverage": "source-reported",
      "day": "2026-07-29",
      "estimatedCostNanoUsd": 125000000,
      "revision": 1,
      "unpricedEvents": 0
    }
  ]
}
```

Every live usage and cost snapshot has a positive safe-integer `revision`.
Snapshots are cumulative versions, not deltas. Within a device and source, the
usage identity is `(day, agent, provider, model)` and the cost identity is
`(day, agent)`. A receiver must replace an older record when a higher revision
arrives and must not add equal or lower revisions again. Replaying the same
envelope is therefore idempotent. `capturedAt` describes the capture and is not
an idempotency key.

The success response is:

```json
{ "accepted": 1 }
```

### Daily start, upload, and commit

Daily imports use the literal source tag `ccusage-daily`. The `syncId` in all
three paths is the same UUID.

1. `PUT /v1/usage-syncs/:syncId` starts or resumes a transaction. Its request
   body is:

   ```json
   {
     "capturedAt": "2026-07-29T11:00:00.000Z",
     "costSnapshotCount": 1,
     "deviceId": "ec7100cb-d60f-479a-a136-85327ec03f8b",
     "snapshotCount": 1,
     "source": "ccusage-daily",
     "sourceVersion": "20.0.19",
     "timeZone": "UTC"
   }
   ```

   `snapshotCount` and `costSnapshotCount` are the lengths of the arrays sent
   in the next request. `sourceVersion` is a numeric semantic version and
   `timeZone` is always the literal `UTC`.

   The receiver must echo the path ID:

   ```json
   {
     "status": "pending",
     "syncId": "11236047-7ee3-4238-8157-f189bbc16927"
   }
   ```

2. `PUT /v1/usage-syncs/:syncId/snapshots` replaces the staged payload. Its
   request body is:

   ```json
   {
     "costs": [
       {
         "agent": "codex",
         "coverage": "source-reported",
         "day": "2026-07-29",
         "estimatedCostNanoUsd": 125000000,
         "unpricedEvents": 0
       }
     ],
     "snapshots": [
       {
         "agent": "codex",
         "day": "2026-07-29",
         "model": "gpt-test",
         "provider": "openai",
         "tokens": {
           "cacheCreationInput": 0,
           "cacheReadInput": 2,
           "input": 11,
           "output": 3,
           "reasoningOutput": 1,
           "tool": 0
         }
       }
     ],
     "source": "ccusage-daily"
   }
   ```

   Daily snapshots have no `revision`; the transaction ID provides replay
   identity. The success response is:

   ```json
   { "accepted": 1 }
   ```

3. `POST /v1/usage-syncs/:syncId/commit` has no request body. It atomically
   publishes the staged transaction. The success response is:

   ```json
   { "committed": 1 }
   ```

The response counters are required JSON numbers. Receivers should return
non-negative integers. Lumen Sync returns them to its caller but does not use
them to verify request array lengths. Additional response fields are ignored.
A bodyless 204 is not a valid success response because the client requires the
documented JSON object.

### Idempotency and retries

For a given `syncId`, the start metadata and staged arrays are immutable. A
receiver must make equivalent repeated start, upload, and commit requests
succeed without creating additional usage. It must reject an attempt to reuse a
`syncId` with different metadata or records rather than silently rebinding the
ID. Records remain staged until commit, and commit must make the transaction
visible at most once.

If a commit times out or its response is lost, its outcome is ambiguous. Retry
the commit with the same `syncId`; never create a new ID for that retry. If the
caller retries the whole three-request operation, it must also reuse the same
`syncId` and identical envelopes. A repeated commit must return a compatible
2xx JSON response without applying the transaction twice.

The CLI keeps a private journal under the platform state directory,
keyed by device, agent, and requested date range. A failed or interrupted
`lumen-sync sync` invocation leaves the ID there, so a later invocation resumes
the same transaction automatically. The journal entry is removed only after a
confirmed commit; a later fresh invocation then creates a new transaction.

The destination client itself performs one attempt per route with a five-second
default timeout. It does not add automatic backoff. The running collector will
try an unacknowledged live generation again on a later upload interval; a daily
CLI failure exits.

### Failures

Any non-2xx response rejects the operation with `DestinationRejected` and the
HTTP status; the response body is not decoded. A transport failure or timeout
becomes `DestinationUnavailable`. A 2xx response with missing, non-JSON, or
wrongly typed fields becomes `InvalidDestinationResponse`. Constructing the
library destination layer with a non-HTTPS/non-loopback, credential-bearing,
query-bearing, or fragment-bearing base URL fails with
`InvalidDestinationConfiguration`.

For daily sync, a failed start prevents upload and commit, and a failed upload
prevents commit. Receivers should use `401` for a missing or invalid token,
`403` for an authenticated principal that lacks permission, `409` for a
conflicting reuse of `syncId`, and `429` or `5xx` for retryable service
conditions. Callers should correct `4xx` requests before retrying and preserve
the same request identity when retrying transient or ambiguous failures.

The machine-readable
[receiver conformance examples](./docs/destination-conformance.json) contain
the same four mocked exchanges.

The [Effect-based reference receiver](./examples/receiver) implements those
exchanges in memory. Its conformance test proves authorization, live revision
replacement, daily replay/conflict behavior, and exact input/output token
preservation. It is a teaching implementation; production receivers must
replace its in-memory state with durable transactional storage.

## User services

```sh
lumen-sync service install
lumen-sync service status
lumen-sync service uninstall
```

The service package renders and manages:

- macOS LaunchAgents
- Linux systemd user services
- Windows least-privilege Scheduled Tasks

Service definitions contain the executable, any runtime prefix arguments, and
the config path, never an endpoint or credential. Package installs preserve the
Bun runtime by launching the CLI script through Bun. Setting
`LUMEN_EXECUTABLE_PATH` selects a native executable instead. The collector reads
configuration at startup.

## CLI automation protocol

Pass `--json` to emit newline-delimited, versioned events:

```sh
lumen-sync --json harness status
lumen-sync --json collector status
lumen-sync --json doctor
```

Successful `harness configure` events report the verified post-write `state`
and retain the pre-write value as `previousState`.

Each line contains `protocolVersion`, `sequence`, `timestamp`, `command`, and
`type`. Successful records carry `data`; failures carry a stable `error`
object with `code`, `message`, and `retryable`. A failed command writes its
error event to stdout and exits nonzero. Human-readable output remains the
default.

The command surface is resource/verb based:

- `config init|path|show`
- `harness list|status|configure|remove`
- `collector run|status`
- `sync daily`
- `auth login|logout`
- `service install|status|uninstall`
- `doctor`

The library exports stable schemas from `@lumen-build/sync/contracts`, Bun
adapters from `@lumen-build/sync/bun`, and the OpenCode integration from
`@lumen-build/sync/opencode`. OpenCode itself discovers the same integration
through the package's `./server` export.

## Development and proof

```sh
bun install
bun run check
bun run build
bun run package:check
bun run example:check
bun run test:e2e:product
bun run test:e2e:harness
```

`package:check` installs the generated tarball into an empty consumer and into
an isolated copy of the reference receiver, then runs the receiver typecheck
and conformance tests against the installed package. `example:check` reruns
only that packed receiver proof.

Fast tests cover official-shaped telemetry from all six harnesses, JSON and
protobuf OTLP, deduplication/revisions, ccusage adapters, reconciliation
policies, reversible harness changes, all service formats, destination HTTP
calls, and local/CI OIDC. Non-loopback test hostnames are always mocked or
handled in memory. The only real test listeners bind to loopback.

The packed product E2E builds `@lumen-build/sync`, installs its tarball into an
empty project, and invokes only that installed CLI. It proves explicit endpoint
requirements, environment-over-TOML precedence, live retry/checkpoint/restart
behavior, deduplication, a non-empty bundled ccusage import with lost-response
replay, CI OIDC assertion exchange, and local PKCE login/refresh/revocation.

The Linux real-harness matrix pins Claude Code 2.1.220, Codex 0.146.0, GitHub
Copilot CLI 1.0.75, Gemini CLI 0.53.0, OpenCode 1.18.9,
[aimock](https://aimock.copilotkit.dev/) 1.37.4, and Node 22.23.1 in a separate
lockfile. Each case configures and re-inspects the harness through the installed
CLI, sends a canary prompt to a strict local model mock, runs the real vendor
binary, proves a non-empty daily ccusage import, and verifies that the
destination never receives the prompt.

The mock's request journal must match the exact request count, provider route,
model sequence, message-role shape, system-message count, tool count, and one
canary occurrence per request. Its usage response is generated from a
fixed per-request golden fixture that is independent of the request meter. The
meter separately asserts exact macOS- and Linux-specific lexical input, system,
and overhead counts for every normalized message and tool string. Harness-added
system instructions and tool schemas are therefore part of the proof without
pretending the platform envelopes are identical. The destination must then
contain exactly the source-appropriate input/output pairs and no additional pairs.
Claude's native metric combines
both request inputs with the final output while ccusage records the final
request. OpenCode makes an auxiliary title request but exposes only the primary
request through its usage event and ccusage. Codex is one-to-one; Gemini proves
the exact daily path because native live OTLP was not observed. Copilot proves
that its native file metric and the ccusage daily snapshot both preserve the
single request's exact input/output pair.

These assertions prove the exact platform-specific lexical request envelope and lossless
propagation of an independently fixed provider usage response. The lexical
meter does not claim to reproduce proprietary provider tokenizers; a real
provider's usage response is the production authority. VS Code remains outside
the real-client matrix because its extension has no supported headless client
E2E.

CI runs on macOS, Linux, and Windows with Bun 1.3.4 and asserts that exact
runtime version. It runs formatting, lint, TypeScript, Effect-specific
diagnostics, deterministic tests, and the build. Dependent Linux jobs pack and
install `@lumen-build/sync`, run the product E2E, and execute one isolated
real-harness E2E job for each pinned CLI.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development expectations,
[SECURITY.md](./SECURITY.md) for private vulnerability reporting, and
[docs/releasing.md](./docs/releasing.md) for the npm trusted-publishing process.

## License

MIT
