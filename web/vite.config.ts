import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sqliteWasmBinaryPlugin } from "./vite-plugin-sqlite-wasm-binary";

const sqliteWasmBinary = sqliteWasmBinaryPlugin();

const PROD_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; object-src 'none'; frame-ancestors 'none';";

const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: ws: http:; object-src 'none'; frame-ancestors 'none';";

export default defineConfig({
  plugins: [react(), sqliteWasmBinary],
  resolve: {
    alias: {
      "@aura-importer/converter": fileURLToPath(new URL("../packages/converter/src/index.ts", import.meta.url)),
      "@aura-importer/aura-schema": fileURLToPath(new URL("../packages/aura-schema/src/index.ts", import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
    plugins: () => [sqliteWasmBinary],
  },
  server: {
    port: 5180,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Content-Security-Policy": DEV_CSP,
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Content-Security-Policy": PROD_CSP,
    },
  },
});
