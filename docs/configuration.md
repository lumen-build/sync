# Configuration reference

Lumen Sync has no collector, destination, or identity-provider defaults.
Networked commands fail until their required endpoints are configured.

## Precedence

Configuration is resolved in this order:

1. `--config <path>` selects the configuration file for that invocation.
2. `LUMEN_CONFIG` selects it when `--config` is absent.
3. The platform default is used when neither is present.
4. Endpoint and authentication environment variables override values loaded
   from TOML.

Bearer tokens and CI assertions are read from the environment and are never
written to TOML. OIDC refresh tokens, the generated device identity, collector
checkpoints, and daily-sync journals are stored in mode-`0600` files.

## Platform paths

| Data                     | macOS                                            | Linux                                                                                       | Windows                                  |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Configuration            | `~/.config/lumen-build/sync/config.toml`         | `$XDG_CONFIG_HOME/lumen-build/sync/config.toml` or `~/.config/lumen-build/sync/config.toml` | `%APPDATA%\lumen-build\sync\config.toml` |
| Credentials and identity | `~/Library/Application Support/lumen-build/sync` | `$XDG_DATA_HOME/lumen-build/sync` or `~/.local/share/lumen-build/sync`                      | `%LOCALAPPDATA%\lumen-build\sync`        |
| Checkpoints and journals | `~/Library/Application Support/lumen-build/sync` | `$XDG_STATE_HOME/lumen-build/sync` or `~/.local/state/lumen-build/sync`                     | `%LOCALAPPDATA%\lumen-build\sync`        |

An explicit `--config` or `LUMEN_CONFIG` path colocates credentials and identity
beside the configuration and places state in a `state` subdirectory.

## TOML schema

Every key is shown below. The OIDC table is required only when `auth.mode` is
`oidc`.

```toml
[collector]
listen_url = "http://127.0.0.1:4318"

[destination]
base_url = "https://receiver.example"

[auth]
mode = "oidc" # bearer | oidc

[auth.oidc]
issuer = "https://identity.example"
client_id = "lumen-sync"
audience = "https://receiver.example" # optional
redirect_uri = "http://127.0.0.1:9876/callback"
scopes = ["openid", "offline_access"]
validation = "jwks" # jwks | introspection
```

`collector.listen_url` must be an explicit HTTP loopback URL. Destination,
issuer, and redirect URLs require HTTPS unless they are loopback URLs for local
development and tests.

## Environment variables

| Variable                        | Purpose                                           | Format                                                        |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `LUMEN_CONFIG`                  | Configuration file override                       | Absolute or working-directory-relative path ending in `.toml` |
| `LUMEN_COLLECTOR_LISTEN_URL`    | Override `collector.listen_url`                   | HTTP loopback URL                                             |
| `LUMEN_DESTINATION_BASE_URL`    | Override `destination.base_url`                   | HTTPS URL or HTTP loopback URL                                |
| `LUMEN_AUTH_MODE`               | Override `auth.mode`                              | `bearer` or `oidc`                                            |
| `LUMEN_BEARER_TOKEN`            | Receiver token for bearer mode                    | Non-empty secret                                              |
| `LUMEN_OIDC_ISSUER`             | Override `auth.oidc.issuer`                       | HTTPS URL or HTTP loopback URL                                |
| `LUMEN_OIDC_CLIENT_ID`          | Override `auth.oidc.client_id`                    | Non-empty string                                              |
| `LUMEN_OIDC_AUDIENCE`           | Override optional `auth.oidc.audience`            | Provider-defined audience                                     |
| `LUMEN_OIDC_REDIRECT_URI`       | Override `auth.oidc.redirect_uri`                 | HTTPS URL or HTTP loopback URL                                |
| `LUMEN_OIDC_SCOPES`             | Override `auth.oidc.scopes`                       | Comma-separated scopes                                        |
| `LUMEN_OIDC_VALIDATION`         | Override `auth.oidc.validation`                   | `jwks` or `introspection`                                     |
| `LUMEN_OIDC_ASSERTION`          | Explicit CI workload assertion                    | JWT or provider-defined assertion                             |
| `LUMEN_DEVICE_ID`               | Override the persisted installation identity      | Version-4 UUID                                                |
| `LUMEN_EXECUTABLE_PATH`         | Native executable used in generated user services | Absolute executable path                                      |
| `LUMEN_COLLECTOR_OTLP_ENDPOINT` | Explicit OpenCode plugin collector endpoint       | OTLP base URL                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | OpenCode plugin fallback endpoint                 | OTLP base URL                                                 |

`LUMEN_OIDC_ASSERTION` takes precedence over automatically detected CI
assertions. Without it, OIDC supports GitHub Actions OIDC, GitLab CI JWT, and
CircleCI OIDC environments.

The OpenCode endpoint variables affect only the package plugin. The managed
Claude, Codex, Copilot, Gemini, and VS Code settings are written by
`lumen-sync harness configure`.

## Inspection and automation

```sh
lumen-sync config path
lumen-sync config show
lumen-sync doctor
lumen-sync --json config show
lumen-sync --json doctor
```

`config show` validates and prints non-secret configuration. `--json` emits the
versioned JSONL automation protocol documented in the main README.
