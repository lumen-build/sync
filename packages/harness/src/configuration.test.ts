import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { prepareConfiguration, prepareRemoval } from "./configuration"
import { HarnessConfigurationConflict, harnesses, harnessRegistry, type Harness } from "./model"
import { makeHarnessPaths } from "./paths"

const collectorUrl = "https://collector.lumen.build"

it("registers every supported harness and its integration shape", () => {
  expect(harnesses.map(({ id }) => id)).toEqual([
    "claude",
    "codex",
    "copilot",
    "gemini",
    "opencode",
    "vscode",
  ])
  expect(harnessRegistry.opencode).toMatchObject({
    format: "jsonc",
    integration: "opencode-plugin",
    signals: ["logs"],
  })
  expect(
    harnesses.filter(({ integration }) => integration === "native-otel").map(({ id }) => id),
  ).toEqual(["claude", "codex", "copilot", "gemini", "vscode"])
})

it.effect("configures every harness without adding a default collector", () =>
  Effect.gen(function* () {
    const supportedHarnesses: ReadonlyArray<Harness> = [
      "claude",
      "codex",
      "copilot",
      "gemini",
      "opencode",
      "vscode",
    ]
    for (const harness of supportedHarnesses) {
      const configured = yield* prepareConfiguration({
        collectorUrl,
        contents: "",
        force: false,
        harness,
      })
      expect(configured.contents).toContain(
        harness === "opencode" ? "@lumen-build/sync/opencode" : "collector.lumen.build",
      )
      const repeated = yield* prepareConfiguration({
        collectorUrl,
        contents: configured.contents,
        force: false,
        harness,
      })
      expect(repeated.state).toBe("exact")
      expect(repeated.changes).toEqual([])
    }
  }),
)

it.effect("preserves comments and disables content capture", () =>
  Effect.gen(function* () {
    const claude = yield* prepareConfiguration({
      collectorUrl,
      contents: '{\n  // preserved\n  "theme": "dark"\n}\n',
      force: false,
      harness: "claude",
    })
    expect(claude.contents).toContain("// preserved")
    expect(claude.contents).toContain('"OTEL_LOG_USER_PROMPTS": "0"')
    expect(claude.contents).toContain('"OTEL_LOG_RAW_API_BODIES": "0"')

    const vscode = yield* prepareConfiguration({
      collectorUrl,
      contents: '{\n  // preserved\n  "editor.fontSize": 15,\n}\n',
      force: false,
      harness: "vscode",
    })
    expect(vscode.contents).toContain("// preserved")
    expect(vscode.contents).toContain('"github.copilot.chat.otel.captureContent": false')
  }),
)

it.effect("requires force before replacing a user endpoint", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      prepareConfiguration({
        collectorUrl,
        contents: '{ "telemetry": { "otlpEndpoint": "https://other.lumen.build" } }',
        force: false,
        harness: "gemini",
      }),
    )
    expect(error).toBeInstanceOf(HarnessConfigurationConflict)
    if (error instanceof HarnessConfigurationConflict) {
      expect(error.fields).toEqual(["telemetry.otlpEndpoint"])
    }
  }),
)

it.effect("restores only fields that the user has not changed", () =>
  Effect.gen(function* () {
    const configured = yield* prepareConfiguration({
      collectorUrl,
      contents: '{ "theme": "dark" }\n',
      force: false,
      harness: "vscode",
    })
    const changedByUser = configured.contents.replace(
      '"github.copilot.chat.otel.enabled": true',
      '"github.copilot.chat.otel.enabled": false',
    )
    const removed = yield* prepareRemoval({
      changes: configured.changes,
      collectorUrl,
      contents: changedByUser,
      harness: "vscode",
    })
    expect(removed.contents).toContain('"theme": "dark"')
    expect(removed.contents).toContain('"github.copilot.chat.otel.enabled": false')
    expect(removed.contents).not.toContain("github.copilot.chat.otel.otlpEndpoint")
    expect(removed.preserved).toEqual(["github.copilot.chat.otel.enabled"])
  }),
)

it.effect("keeps Codex TOML comments and uses binary OTLP", () =>
  Effect.gen(function* () {
    const result = yield* prepareConfiguration({
      collectorUrl,
      contents: '# preserved\nmodel = "gpt-5.6-sol"\n',
      force: false,
      harness: "codex",
    })
    expect(result.contents).toContain("# preserved")
    expect(result.contents).toContain('protocol = "binary"')
    expect(result.contents).toContain("https://collector.lumen.build/v1/metrics")
  }),
)

it.effect("adds and removes the OpenCode plugin without disturbing other plugins", () =>
  Effect.gen(function* () {
    const configured = yield* prepareConfiguration({
      collectorUrl,
      contents: '{ "plugin": ["existing-plugin"] }\n',
      force: false,
      harness: "opencode",
    })
    expect(JSON.parse(configured.contents).plugin).toEqual([
      "existing-plugin",
      "@lumen-build/sync/opencode",
    ])

    const removed = yield* prepareRemoval({
      changes: configured.changes,
      collectorUrl,
      contents: configured.contents.replace(
        '"@lumen-build/sync/opencode"',
        '"@lumen-build/sync/opencode", "added-after-sync"',
      ),
      harness: "opencode",
    })
    expect(JSON.parse(removed.contents).plugin).toEqual(["existing-plugin", "added-after-sync"])
  }),
)

it("resolves all supported operating-system configuration locations", () => {
  const mac = makeHarnessPaths({ home: "/Users/dev", platform: "darwin" })
  const linux = makeHarnessPaths({ home: "/home/dev", platform: "linux" })
  const windows = makeHarnessPaths({
    appData: "C:\\Users\\dev\\AppData\\Roaming",
    home: "C:\\Users\\dev",
    platform: "win32",
  })

  expect(mac.configurations.vscode).toContain("Library/Application Support/Code")
  expect(linux.configurations.opencode).toBe("/home/dev/.config/opencode/opencode.json")
  expect(windows.configurations.vscode).toBe(
    "C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\settings.json",
  )
})
