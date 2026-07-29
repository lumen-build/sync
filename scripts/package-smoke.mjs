import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const temporary = mkdtempSync(join(tmpdir(), "lumen-sync-package-"))
const receiverOnly = process.argv.includes("--receiver-only")

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
  if (!receiverOnly) {
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
        'import "@lumen-build/sync/server"',
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
  }

  const receiverDirectory = join(temporary, "examples", "receiver")
  const conformanceDirectory = join(temporary, "docs")
  mkdirSync(conformanceDirectory, { recursive: true })
  cpSync(join(root, "examples", "receiver"), receiverDirectory, { recursive: true })
  cpSync(
    join(root, "docs", "destination-conformance.json"),
    join(conformanceDirectory, "destination-conformance.json"),
  )

  const receiverPackagePath = join(receiverDirectory, "package.json")
  const receiverPackage = JSON.parse(readFileSync(receiverPackagePath, "utf8"))
  receiverPackage.dependencies["@lumen-build/sync"] = `file:${archive.replaceAll("\\", "/")}`
  writeFileSync(receiverPackagePath, `${JSON.stringify(receiverPackage, null, 2)}\n`)
  execFileSync("npm", ["install", "--ignore-scripts"], {
    cwd: receiverDirectory,
    stdio: "ignore",
  })

  const typecheck = join(
    receiverDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  )
  execFileSync(typecheck, ["--noEmit"], {
    cwd: receiverDirectory,
    stdio: "inherit",
  })
  execFileSync("bun", ["test", "test/receiver.test.ts"], {
    cwd: receiverDirectory,
    stdio: "inherit",
  })
  process.stdout.write(`Package and receiver smoke passed: ${filename}\n`)
} finally {
  rmSync(temporary, { force: true, recursive: true })
}
