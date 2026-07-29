# @lumen-build/sync

Effect-native agent usage collection and synchronization for Claude Code, Codex, GitHub Copilot CLI, Gemini CLI, OpenCode, and VS Code Copilot.

```sh
bun add --global @lumen-build/sync
lumen-sync --help
lumen-sync config init --collector http://127.0.0.1:4318
```

The package includes:

- an OTLP/HTTP JSON and protobuf collector;
- UTC daily imports through pinned ccusage 20.0.19;
- explicit bearer or OIDC authentication;
- reversible, privacy-safe harness configuration;
- macOS, Linux, and Windows user-service definitions;
- source-aware reconciliation for live OTLP and daily ccusage data.

No endpoint is built in. Configure the collector and destination through TOML or environment variables.

```toml
[collector]
listen_url = "http://127.0.0.1:4318"

[destination]
base_url = "https://usage.lumen.build"

[auth]
mode = "bearer"
```

The `https://usage.lumen.build` destination above is illustrative, fully mocked
in this repository's tests, and not a package default.

```ts
import { Collector, Config, Harness, Reconciliation, Runtime } from "@lumen-build/sync"
import { CliEvent } from "@lumen-build/sync/contracts"
```

`harness configure --agent opencode` adds `@lumen-build/sync` to OpenCode's
plugin list. OpenCode discovers the package's `./server` export; direct
integrators can import `LumenSync` from `@lumen-build/sync/opencode`. The plugin
remains inactive until `LUMEN_COLLECTOR_OTLP_ENDPOINT` or
`OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set.

## Harness verification

The Linux E2E matrix invokes the packed CLI and pinned real binaries against a
strict local model mock:

| Harness     | Verified evidence                                                               |
| ----------- | ------------------------------------------------------------------------------- |
| Claude Code | Real model call, non-zero native live usage, and non-empty ccusage daily import |
| Codex       | Real model call, non-zero native live usage, and non-empty ccusage daily import |
| Gemini CLI  | Real model call and non-empty daily import; native live OTLP was not observed   |
| OpenCode    | Real model call, packed-plugin live envelope, and non-empty daily import        |

OpenCode's first real plugin event currently has zero token fields. GitHub
Copilot CLI and VS Code Copilot have configuration and official-shaped
telemetry coverage, but not a real-client E2E. These boundaries are intentional:
the tests do not inject undocumented endpoints or wait indefinitely to turn an
unobserved signal into a claim.

For automation, pass `--json` to receive one versioned JSON event per line.
The resource/verb commands include `config init|path|show`, `harness
list|status|configure|remove`, `collector run|status`, `sync daily`, `auth
login|logout`, `service install|status|uninstall`, and `doctor`.
Successful `harness configure` events report the verified post-write `state`
and retain the pre-write value as `previousState`.

The CLI checkpoints live aggregate state after each successful upload under
the platform state directory, so cumulative revisions survive
collector restarts. Daily ccusage import remains the recovery source for events
received after the latest checkpoint.

## Live and daily source semantics

Live OTLP and daily ccusage data are separate source products. `otel-live` is a
low-latency, revisioned view; `ccusage-daily` is a later aggregate read from the
agent's local usage records. They can describe the same inference, so a receiver
must not add them together by default.

Every envelope carries its source. The reconciliation API requires one explicit
policy: `separate`, `otel-only`, `ccusage-only`, or
`ccusage-baseline-live-delta`. `separate` is the safe default when provider or
model identity cannot be matched unambiguously.

## Receiver contract

The destination is operator-supplied. `https://usage.lumen.build` is only an
illustrative URL that is mocked by this repository's tests; it is not a hosted
service or package default.

Every route sends `Accept: application/json` and
`Authorization: Bearer <access-token>`. JSON routes also send
`Content-Type: application/json`. Bearer mode sends `LUMEN_BEARER_TOKEN`; OIDC
mode obtains an OAuth access token and sends it with the same Bearer header. The
OIDC assertion and refresh token never go to the destination.

| Request                                 | Exact request envelope                                                                                                | Required 2xx JSON response                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `PUT /v1/usage/otel-snapshots`          | `{ source: "otel-live", capturedAt, deviceId, snapshots, costs }`; every snapshot and cost has a positive `revision`  | `{ "accepted": number }`                         |
| `PUT /v1/usage-syncs/:syncId`           | `{ capturedAt, costSnapshotCount, deviceId, snapshotCount, source: "ccusage-daily", sourceVersion, timeZone: "UTC" }` | `{ "status": "pending", "syncId": "<path ID>" }` |
| `PUT /v1/usage-syncs/:syncId/snapshots` | `{ costs, snapshots, source: "ccusage-daily" }`; daily records have no revision                                       | `{ "accepted": number }`                         |
| `POST /v1/usage-syncs/:syncId/commit`   | no body                                                                                                               | `{ "committed": number }`                        |

Live records are cumulative versions, not deltas. A receiver must replace an
older record when a higher revision arrives and must not add an equal or lower
revision again. The daily routes form one staged transaction: all three paths
use the same version-4 UUID, records remain pending until commit, and commit
publishes them at most once.

Repeated equivalent start, upload, and commit requests for one `syncId` must
succeed without duplicating usage. Reusing the ID with different content must
be rejected. If a commit response is lost or times out, retry the commit with
the same `syncId`; a new ID could create a second transaction. The CLI journals
the ID by device, agent, and requested date range and reuses it across failed or
interrupted invocations. It removes the journal entry only after a confirmed
commit.

Any non-2xx response becomes `DestinationRejected`; its body is ignored.
Transport failures and timeouts become `DestinationUnavailable`. A 2xx response
whose JSON does not match the table becomes `InvalidDestinationResponse`; this
means a bodyless 204 is not accepted. The destination client makes one
five-second attempt per route and has no automatic backoff.

See the [full destination protocol](https://github.com/lumen-build/sync#destination-contract)
for field types, complete request examples, receiver status guidance, and
source-reconciliation rules. The repository also publishes
[machine-readable mocked exchanges](https://github.com/lumen-build/sync/blob/main/docs/destination-conformance.json).

MIT
