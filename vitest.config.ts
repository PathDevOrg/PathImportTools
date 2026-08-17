import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sqliteWasmBinaryPlugin } from "./web/vite-plugin-sqlite-wasm-binary";

export default defineConfig({
  plugins: [sqliteWasmBinaryPlugin()],
  resolve: {
    alias: {
      "@aura-importer/aura-schema": fileURLToPath(new URL("./packages/aura-schema/src/index.ts", import.meta.url)),
      "@aura-importer/converter": fileURLToPath(new URL("./packages/converter/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "web/test/**/*.test.ts"],
    globals: true,
  },
});
