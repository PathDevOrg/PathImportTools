import sqliteModuleUrl from "@sqlite.org/sqlite-wasm?url";

export const offlineCacheName = "path-import-v2";

const webRuntime = typeof location !== "undefined";
const sqliteModuleDirectory = webRuntime ? new URL(".", new URL(sqliteModuleUrl, location.href)).href : sqliteModuleUrl;

export const sqliteRuntimeAssetUrls = webRuntime
  ? [
      new URL("sqlite3.wasm", sqliteModuleDirectory).href,
      new URL("sqlite3-opfs-async-proxy.js", sqliteModuleDirectory).href,
      new URL("sqlite3-worker1.mjs", sqliteModuleDirectory).href,
    ]
  : [];
