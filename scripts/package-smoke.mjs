import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const temporary = mkdtempSync(join(tmpdir(), "lumen-sync-package-"))

try {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", temporary, "--workspace", "packages/sync"],
    { cwd: root, encoding: "utf8" },
  )
  const packed = JSON.parse(output)
  const filename = packed[0]?.filename
  if (typeof filename !== "string") throw new Error("npm pack did not return a filename")
  const archive = join(temporary, filename)
  execFileSync("npm", ["init", "--yes"], { cwd: temporary, stdio: "ignore" })
  execFileSync("npm", ["install", "--ignore-scripts", archive], {
    cwd: temporary,
    stdio: "ignore",
  })

  const executable = join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "lumen-sync.cmd" : "lumen-sync",
  )
  execFileSync(executable, ["--help"], {
    cwd: temporary,
    stdio: "ignore",
  })

  const smokePath = join(temporary, "smoke.mjs")
  writeFileSync(
    smokePath,
    [
      'import * as api from "@lumen-build/sync"',
      'import "@lumen-build/sync/bun"',
      'import "@lumen-build/sync/contracts"',
      'import "@lumen-build/sync/opencode"',
      "",
      `for (const name of ${JSON.stringify([
        "Auth",
        "Ccusage",
        "Collector",
        "Config",
        "Contracts",
        "DeviceIdentity",
        "Destination",
        "Harness",
        "Otlp",
        "Reconciliation",
        "Runtime",
        "Service",
      ])}) {`,
      "  if (!(name in api)) throw new Error(`published API is missing ${name}`)",
      "}",
      "",
    ].join("\n"),
  )
  execFileSync(process.execPath, [smokePath], { cwd: temporary, stdio: "ignore" })
  process.stdout.write(`Package smoke passed: ${filename}\n`)
} finally {
  rmSync(temporary, { force: true, recursive: true })
}
