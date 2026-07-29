# @lumen-build/sync

Effect-native agent usage collection and synchronization for Claude Code, Codex, GitHub Copilot CLI, Gemini CLI, OpenCode, and VS Code Copilot.

```sh
bun add --global @lumen-build/sync
lumen-sync --help
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

The `lumen.build` destination above is illustrative and fully mocked in this repository’s tests.

```ts
import { Collector, Config, Harness, Reconciliation, Runtime } from "@lumen-build/sync"
```

OpenCode can load the usage-only plugin from `@lumen-build/sync/opencode`. It remains inactive until `LUMEN_COLLECTOR_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set.

See the [full documentation](https://github.com/lumen-build/sync#readme) for OIDC, harness-specific behavior, the receiver contract, duplicate-data policies, and service installation.

MIT
