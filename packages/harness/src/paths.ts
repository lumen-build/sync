import { join } from "node:path"

import type { Harness } from "./model"

export interface HostPaths {
  readonly appData?: string
  readonly configHome?: string
  readonly copilotHome?: string
  readonly home: string
  readonly platform: "darwin" | "linux" | "win32"
}

export interface HarnessPaths {
  readonly configurations: Readonly<Record<Harness, string>>
  readonly ownership: string
  readonly supportDirectory: string
}

const configurationRoot = (host: HostPaths): string =>
  host.configHome ??
  (host.platform === "win32"
    ? (host.appData ?? join(host.home, "AppData", "Roaming"))
    : join(host.home, ".config"))

const vscodeSettings = (host: HostPaths, root: string): string => {
  if (host.platform === "darwin") {
    return join(host.home, "Library", "Application Support", "Code", "User", "settings.json")
  }
  return join(root, "Code", "User", "settings.json")
}

export const makeHarnessPaths = (host: HostPaths): HarnessPaths => {
  const root = configurationRoot(host)
  const supportDirectory = join(root, "lumen-build", "sync")

  return {
    configurations: {
      claude: join(host.home, ".claude", "settings.json"),
      codex: join(host.home, ".codex", "config.toml"),
      copilot: join(host.copilotHome ?? join(host.home, ".copilot"), "settings.json"),
      gemini: join(host.home, ".gemini", "settings.json"),
      opencode: join(root, "opencode", "opencode.json"),
      vscode: vscodeSettings(host, root),
    },
    ownership: join(supportDirectory, "harness-ownership.json"),
    supportDirectory,
  }
}
