import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@aura-importer/converter": fileURLToPath(new URL("../packages/converter/src/index.ts", import.meta.url)),
      "@aura-importer/aura-schema": fileURLToPath(new URL("../packages/aura-schema/src/index.ts", import.meta.url))
    }
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"]
  },
  worker: {
    format: "es"
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  }
});
