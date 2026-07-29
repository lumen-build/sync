# Lumen Sync

Lumen Sync is an open-source, Effect-native toolkit for collecting usage from AI coding agents and synchronizing it to a receiver you control. It includes an OTLP collector, a ccusage daily importer, privacy-safe harness configuration, bearer and OIDC authentication, and a CLI published as `@lumen-build/sync`.

It has no destination or collector endpoint defaults. Networked commands fail until you configure the relevant endpoint.

```text
agent harnesses ──OTLP──▶ local collector ──live, revisioned──▶ your receiver
       │
       └──local usage files──▶ ccusage ──daily, authoritative──▶ your receiver
```

## Requirements

- Bun 1.3.4 or newer
- A receiver that implements the documented destination contract
- One or more supported agent harnesses

The workspace pins Bun 1.3.4, Effect 4.0.0-beta.102, and ccusage 20.0.19.

## Install

```sh
bun add --global @lumen-build/sync
lumen-sync --help
```

The package can also be used as a library:

```ts
import { Collector, Config, Harness, Reconciliation, Runtime } from "@lumen-build/sync"
```

## Configure

The default configuration path follows the host platform:

- macOS and Linux: `$XDG_CONFIG_HOME/lumen/config.toml` or `~/.config/lumen/config.toml`
- Windows: `%APPDATA%\lumen\config.toml`
- Any platform: set `LUMEN_CONFIG` or pass `--config`

This complete bearer example uses `lumen.build` hostnames for illustration. The package does not assume these services exist, and tests intercept these hosts rather than contacting them.

```toml
[collector]
listen_url = "http://127.0.0.1:4318"

[destination]
base_url = "https://usage.lumen.build"

[auth]
mode = "bearer"

[privacy]
mode = "usage-only"
```

Provide secrets through the environment:

```sh
export LUMEN_BEARER_TOKEN="..."
lumen-sync config check
```

Endpoint environment overrides are also supported:

```sh
export LUMEN_COLLECTOR_LISTEN_URL="http://127.0.0.1:4318"
export LUMEN_DESTINATION_BASE_URL="https://usage.lumen.build"
```

Plain HTTP is rejected except for loopback collector and OIDC callback URLs.

### OIDC

OIDC supports local authorization-code + PKCE login and CI JWT-bearer exchange.

```toml
[auth]
mode = "oidc"

[auth.oidc]
issuer = "https://identity.lumen.build"
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

Refresh tokens are stored in a mode-`0600` file beside the configuration. For CI, Lumen Sync accepts an explicit `LUMEN_OIDC_ASSERTION` and detects GitHub Actions OIDC, GitLab CI JWT, and CircleCI OIDC environments. OIDC discovery, refresh, revocation, JWKS validation, and introspection remain reusable library APIs.

## Configure agent harnesses

```sh
lumen-sync harness setup
lumen-sync harness setup --agent claude --agent codex
lumen-sync harness setup --agent gemini --force
lumen-sync harness remove
```

Existing JSONC comments and unrelated settings are retained. Conflicting managed values require `--force`. Removal restores only values that still match what Lumen Sync wrote; user changes are preserved.

| Harness            | Integration                        | Configuration                |
| ------------------ | ---------------------------------- | ---------------------------- |
| Claude Code        | Native OTLP metrics                | `~/.claude/settings.json`    |
| Codex              | Native OTLP metrics                | `~/.codex/config.toml`       |
| GitHub Copilot CLI | Native OTLP, currently best effort | `~/.copilot/settings.json`   |
| Gemini CLI         | Native OTLP collector              | `~/.gemini/settings.json`    |
| OpenCode           | Usage-only plugin plus ccusage     | XDG/APPDATA OpenCode config  |
| VS Code Copilot    | Native OTLP                        | VS Code user `settings.json` |

Content capture is disabled. Claude and Codex are configured to send token metrics, not prompt-bearing logs. Gemini traces and prompt logging are disabled. VS Code and Copilot content capture are disabled.

OpenCode does not currently expose the same native telemetry configuration surface. The package exports `@lumen-build/sync/opencode`, which listens for both legacy assistant-message events and current step events. It sends only usage, model, provider, cost, timestamp, and event identity. OpenCode must receive an explicit environment endpoint:

```sh
export LUMEN_COLLECTOR_OTLP_ENDPOINT="http://127.0.0.1:4318"
```

If the plugin cannot be used, OpenCode daily sync through ccusage remains available.

The harness settings follow the vendors’ observability surfaces: [Claude Code](https://code.claude.com/docs/en/agent-sdk/observability), [Codex](https://learn.chatgpt.com/docs/config-file/config-advanced), [VS Code Copilot](https://code.visualstudio.com/docs/agents/guides/monitoring-agents), [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), and [Gemini CLI](https://geminicli.com/docs/cli/telemetry/).

## Run live collection

```sh
lumen-sync collector start
```

The listener must be an explicit HTTP loopback URL. OTLP/HTTP JSON and protobuf are supported at:

- `POST /v1/logs`
- `POST /v1/metrics`
- `POST /v1/traces`

Known native harnesses use token metrics as their live usage authority, which avoids counting the same inference again when a harness emits both an event and a metric. OpenCode uses usage-only logs. Events are fingerprinted, aggregated by UTC day/agent/provider/model, and uploaded as revisioned `otel-live` snapshots.

For parsing tests or a receiver-less local experiment:

```sh
lumen-sync collector start --local-only
```

## Run daily sync

```sh
lumen-sync sync --since 2026-07-01 --until 2026-07-29
lumen-sync sync --agent claude --agent opencode
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

The CLI sends bearer-authenticated JSON to an explicit base URL:

- `PUT /v1/usage/otel-snapshots`
- `PUT /v1/usage-syncs/:syncId`
- `PUT /v1/usage-syncs/:syncId/snapshots`
- `POST /v1/usage-syncs/:syncId/commit`

Daily uploads use a start/upload/commit protocol and a UUID sync ID so receivers can make retries idempotent. Live snapshots carry per-bucket revisions.

## User services

```sh
lumen-sync service install
lumen-sync service uninstall
```

The service package renders and manages:

- macOS LaunchAgents
- Linux systemd user services
- Windows least-privilege Scheduled Tasks

Service definitions contain the executable and config path, never an endpoint or credential. The collector reads configuration at startup.

## Development and proof

```sh
bun install
bun run check
bun run build
bun run package:check
```

Tests cover official-shaped telemetry from all six harnesses, JSON and protobuf OTLP, deduplication/revisions, ccusage adapters, reconciliation policies, reversible harness changes, all service formats, mocked HTTP destination calls, and local/CI OIDC. `usage.lumen.build`, `collector.lumen.build`, and identity hostnames are always mocked or handled in memory. The only real test listeners bind to loopback.

[aimock, formerly llmock](https://aimock.copilotkit.dev/), is useful for downstream end-to-end tests that run a real agent against a deterministic model API. Lumen Sync itself never calls an inference API, so its CI mocks the boundaries it owns: OTLP, local usage reports, OAuth/OIDC, service controls, and the destination HTTP contract.

CI runs on macOS, Linux, and Windows with Bun 1.3.4, then builds and installs the packed npm artifact before executing its CLI and importing its public API.

## License

MIT
