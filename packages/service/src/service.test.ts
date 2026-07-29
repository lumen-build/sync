import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { InvalidServiceDefinition, makeServiceDefinition } from "./index"

it.effect("renders launchd without embedding a collector endpoint", () =>
  Effect.gen(function* () {
    const definition = yield* makeServiceDefinition({
      configPath: "/Users/dev/.config/lumen-build/sync/config.toml",
      executablePath: "/Users/dev/.bun/bin/lumen-sync",
      host: { home: "/Users/dev", platform: "darwin" },
    })

    expect(definition.artifact.path).toBe("/Users/dev/Library/LaunchAgents/build.lumen.sync.plist")
    expect(definition.artifact.contents).toContain("<string>collector</string>")
    expect(definition.artifact.contents).toContain("<string>--config</string>")
    expect(definition.artifact.contents).not.toContain("4318")
    expect(definition.install[0]).toMatchObject({
      executable: "/bin/launchctl",
      args: ["bootstrap", expect.stringMatching(/^gui\//u), definition.artifact.path],
    })
  }),
)

it.effect("renders user-scoped systemd commands and escapes specifiers", () =>
  Effect.gen(function* () {
    const definition = yield* makeServiceDefinition({
      configPath: "/home/dev/.config/lumen-build/sync/config%20.toml",
      executablePath: "/home/dev/.local/bin/lumen sync",
      host: { home: "/home/dev", platform: "linux" },
    })

    expect(definition.artifact.path).toBe("/home/dev/.config/systemd/user/lumen-sync.service")
    expect(definition.artifact.contents).toContain(
      'ExecStart="/home/dev/.local/bin/lumen sync" "collector" "start"',
    )
    expect(definition.artifact.contents).toContain("config%%20.toml")
    expect(definition.install).toContainEqual({
      args: ["--user", "enable", "--now", "lumen-sync.service"],
      executable: "systemctl",
    })
  }),
)

it.effect("renders a least-privilege Windows scheduled task", () =>
  Effect.gen(function* () {
    const definition = yield* makeServiceDefinition({
      configPath: "C:\\Users\\dev\\AppData\\Roaming\\lumen-build\\sync\\config.toml",
      executablePath: "C:\\Program Files\\Lumen Sync\\lumen-sync.exe",
      host: {
        appData: "C:\\Users\\dev\\AppData\\Roaming",
        home: "C:\\Users\\dev",
        platform: "win32",
      },
    })

    expect(definition.artifact.path).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\lumen-build\\sync\\lumen-sync-task.xml",
    )
    expect(definition.artifact.contents).toContain("<RunLevel>LeastPrivilege</RunLevel>")
    expect(definition.artifact.contents).toContain(
      "<Command>C:\\Program Files\\Lumen Sync\\lumen-sync.exe</Command>",
    )
    expect(definition.install[0]?.executable).toBe("schtasks.exe")
  }),
)

it.effect("rejects paths that can inject a service definition", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      makeServiceDefinition({
        configPath: "/tmp/config.toml\nEnvironment=SECRET",
        executablePath: "/usr/bin/lumen-sync",
        host: { home: "/home/dev", platform: "linux" },
      }),
    )
    expect(error).toBeInstanceOf(InvalidServiceDefinition)
  }),
)
