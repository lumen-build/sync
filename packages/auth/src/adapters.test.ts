import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"

import { environmentAssertionLayer, fileSecretStoreLayer } from "./adapters"
import { AssertionProvider, SecretStore } from "./ports"

it.effect("uses an explicit CI OIDC assertion without exposing it", () =>
  Effect.gen(function* () {
    const provider = yield* AssertionProvider
    const assertion = yield* provider.get("https://usage.lumen.build")
    expect(Redacted.value(assertion)).toBe("mocked-assertion")
    expect(String(assertion)).not.toContain("mocked-assertion")
  }).pipe(
    Effect.provide(
      environmentAssertionLayer({
        LUMEN_OIDC_ASSERTION: "mocked-assertion",
      }),
    ),
  ),
)

it.effect("persists refresh tokens in a private file-backed store", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "lumen-sync-secrets-"))),
    (directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(join(directory, "nested")))
        const store = yield* SecretStore
        yield* store.set("refresh", "mocked-refresh")
        expect(yield* store.get("refresh")).toBe("mocked-refresh")
        yield* store.remove("refresh")
        expect(yield* store.get("refresh")).toBeUndefined()
      }).pipe(Effect.provide(fileSecretStoreLayer(join(directory, "nested", "secrets.json")))),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  ),
)
