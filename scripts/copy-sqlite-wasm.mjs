import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm");
const destination = resolve(root, "web/public/sqlite3.wasm");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log("Copied sqlite3.wasm to web/public/sqlite3.wasm");
