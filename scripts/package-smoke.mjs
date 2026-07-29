import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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

  const installed = join(temporary, "node_modules", "@lumen-build", "sync")
  execFileSync(process.execPath, [join(installed, "dist", "cli.js"), "--help"], {
    cwd: temporary,
    stdio: "ignore",
  })
  const api = await import(pathToFileURL(join(installed, "dist", "index.js")).href)
  for (const name of ["Auth", "Collector", "Config", "Harness", "Runtime"]) {
    if (!(name in api)) throw new Error(`published API is missing ${name}`)
  }
  await import(pathToFileURL(join(installed, "dist", "opencode.js")).href)
  process.stdout.write(`Package smoke passed: ${filename}\n`)
} finally {
  rmSync(temporary, { force: true, recursive: true })
}
