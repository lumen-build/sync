import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const declarationsRoot = resolve(packageDirectory, "dist", "types", "packages")

const targets = new Map([
  ["@lumen-build/sync-auth", "auth/src/index"],
  ["@lumen-build/sync-ccusage", "ccusage/src/index"],
  ["@lumen-build/sync-collector", "collector/src/index"],
  ["@lumen-build/sync-collector/bun", "collector/src/server-bun"],
  ["@lumen-build/sync-config", "config/src/index"],
  ["@lumen-build/sync-contracts", "contracts/src/index"],
  ["@lumen-build/sync-destination", "destination/src/index"],
  ["@lumen-build/sync-harness/opencode", "harness/src/opencode"],
  ["@lumen-build/sync-harness/bun", "harness/src/lifecycle-bun"],
  ["@lumen-build/sync-harness", "harness/src/index"],
  ["@lumen-build/sync-otlp", "otlp/src/index"],
  ["@lumen-build/sync-reconciliation", "reconciliation/src/index"],
  ["@lumen-build/sync-service", "service/src/index"],
])

const files = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      }),
    )
  ).flat()
}

await Promise.all(
  (await files(declarationsRoot))
    .filter((path) => path.endsWith(".d.ts"))
    .map(async (path) => {
      let contents = await readFile(path, "utf8")
      for (const [specifier, target] of targets) {
        let replacement = relative(dirname(path), resolve(declarationsRoot, target))
          .split(sep)
          .join("/")
        if (!replacement.startsWith(".")) replacement = `./${replacement}`
        contents = contents.replaceAll(`"${specifier}"`, `"${replacement}"`)
      }
      await writeFile(path, contents)
    }),
)
