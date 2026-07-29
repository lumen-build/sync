import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
    },
    exclude: ["**/*.bun.test.ts", "**/node_modules/**"],
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    passWithNoTests: false,
  },
})
