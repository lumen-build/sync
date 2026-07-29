import { posix, win32 } from "node:path"

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
}

const pathFor = (host: HostPaths) => (host.platform === "win32" ? win32 : posix)

const configurationRoot = (host: HostPaths): string => {
  const path = pathFor(host)
  return (
    host.configHome ??
    (host.platform === "win32"
      ? (host.appData ?? path.join(host.home, "AppData", "Roaming"))
      : path.join(host.home, ".config"))
  )
}

const vscodeSettings = (host: HostPaths, root: string): string => {
  const path = pathFor(host)
  if (host.platform === "darwin") {
    return path.join(host.home, "Library", "Application Support", "Code", "User", "settings.json")
  }
  return path.join(root, "Code", "User", "settings.json")
}

export const makeHarnessPaths = (host: HostPaths): HarnessPaths => {
  const path = pathFor(host)
  const root = configurationRoot(host)
  const supportDirectory = path.join(root, "lumen-build", "sync")

  return {
    configurations: {
      claude: path.join(host.home, ".claude", "settings.json"),
      codex: path.join(host.home, ".codex", "config.toml"),
      copilot: path.join(host.copilotHome ?? path.join(host.home, ".copilot"), "settings.json"),
      gemini: path.join(host.home, ".gemini", "settings.json"),
      opencode: path.join(root, "opencode", "opencode.json"),
      vscode: vscodeSettings(host, root),
    },
    ownership: path.join(supportDirectory, "harness-ownership.json"),
  }
}
