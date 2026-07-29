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

const joinHost = (platform: HostPaths["platform"], ...parts: ReadonlyArray<string>): string => {
  const separator = platform === "win32" ? "\\" : "/"
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0
        ? part.replace(new RegExp(`${separator === "\\" ? "\\\\" : separator}+$`, "u"), "")
        : part.replace(
            new RegExp(
              `^${separator === "\\" ? "\\\\" : separator}+|${separator === "\\" ? "\\\\" : separator}+$`,
              "gu",
            ),
            "",
          ),
    )
    .join(separator)
}

const configurationRoot = (host: HostPaths): string => {
  return (
    host.configHome ??
    (host.platform === "win32"
      ? (host.appData ?? joinHost(host.platform, host.home, "AppData", "Roaming"))
      : joinHost(host.platform, host.home, ".config"))
  )
}

const vscodeSettings = (host: HostPaths, root: string): string => {
  if (host.platform === "darwin") {
    return joinHost(
      host.platform,
      host.home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "settings.json",
    )
  }
  return joinHost(host.platform, root, "Code", "User", "settings.json")
}

export const makeHarnessPaths = (host: HostPaths): HarnessPaths => {
  const root = configurationRoot(host)
  const supportDirectory = joinHost(host.platform, root, "lumen-build", "sync")

  return {
    configurations: {
      claude: joinHost(host.platform, host.home, ".claude", "settings.json"),
      codex: joinHost(host.platform, host.home, ".codex", "config.toml"),
      copilot: joinHost(
        host.platform,
        host.copilotHome ?? joinHost(host.platform, host.home, ".copilot"),
        "settings.json",
      ),
      gemini: joinHost(host.platform, host.home, ".gemini", "settings.json"),
      opencode: joinHost(host.platform, root, "opencode", "opencode.json"),
      vscode: vscodeSettings(host, root),
    },
    ownership: joinHost(host.platform, supportDirectory, "harness-ownership.json"),
  }
}
