import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const virtualId = "virtual:sqlite-wasm-binary";
const resolvedVirtualId = `\0${virtualId}`;

export function sqliteWasmBinaryPlugin(): Plugin {
  return {
    name: "sqlite-wasm-binary",
    enforce: "pre",
    resolveId(id) {
      if (id === virtualId) {
        return resolvedVirtualId;
      }
      return null;
    },
    load(id) {
      if (id !== resolvedVirtualId) {
        return null;
      }
      const root = dirname(fileURLToPath(import.meta.url));
      const wasmPath = resolve(root, "../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm");
      const bytes = readFileSync(wasmPath).toString("base64");
      return `export default Uint8Array.from(atob("${bytes}"), (char) => char.charCodeAt(0));`;
    },
  };
}
