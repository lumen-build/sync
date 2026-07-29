import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync } from "node:fs"
import { resolve } from "node:path"

const cli = resolve("node_modules", "@effect", "tsgo", "dist", "effect-tsgo.js")
const binary = execFileSync(process.execPath, [cli, "get-exe-path"], {
  encoding: "utf8",
}).trim()

if (process.platform !== "win32") chmodSync(binary, 0o755)

const result = spawnSync(
  process.execPath,
  [cli, "diagnostics", "--project", "tsconfig.json", "--severity", "error", "--format", "pretty"],
  { stdio: "inherit" },
)

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
