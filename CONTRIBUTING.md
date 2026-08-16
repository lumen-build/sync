# Contributing

Contributions are welcome through focused pull requests.

## Development setup

Requirements:

- Bun 1.3.4
- Git
- Node 22.23.2 only when running the real-harness fixture locally

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

The repository is a Turborepo workspace. Reusable logic belongs under
`packages/*`; runnable teaching material belongs under `examples/*`.

## Tests

Run the smallest relevant test while developing, then run the full gates:

```sh
bun run check
bun run package:check
bun run test:e2e:product
bun run test:e2e:harness
```

The harness E2E downloads and invokes pinned real vendor CLIs. Set
`LUMEN_HARNESS_AGENT` to `claude`, `codex`, `copilot`, `gemini`, or `opencode`
to run one case.

Tests must not contact a production receiver or model provider. Use loopback
servers, `oauth2-mock-server`, and the pinned model mock. Never weaken an
assertion to turn an unavailable vendor signal into a claimed integration.

## Changes

- Preserve explicit endpoint configuration; never introduce a network default.
- Keep prompt, response, and tool content out of telemetry.
- Add runtime schemas for new wire data.
- Add unit coverage and packed-artifact proof for behavior changes.
- Document differences between live OTLP and daily ccusage data.
- Keep commits focused and use conventional commit messages.

By contributing, you agree that your contribution is licensed under the MIT
license included with the project.
