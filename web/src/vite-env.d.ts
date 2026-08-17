/// <reference types="vite/client" />

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "virtual:sqlite-wasm-binary" {
  const sqliteWasmBinary: Uint8Array;
  export default sqliteWasmBinary;
}
