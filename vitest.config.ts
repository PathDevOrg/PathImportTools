import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@aura-importer/aura-schema": fileURLToPath(new URL("./packages/aura-schema/src/index.ts", import.meta.url)),
      "@aura-importer/converter": fileURLToPath(new URL("./packages/converter/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    globals: true
  }
});
