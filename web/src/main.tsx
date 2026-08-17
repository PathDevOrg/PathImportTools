import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { offlineCacheName, sqliteRuntimeAssetUrls } from "./conversion/sqliteRuntimeAssets";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void warmPageCache();
    void navigator.serviceWorker
      .register("/sw.js")
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        if (registration.active) {
          const channel = new MessageChannel();
          const warmed = new Promise<void>((resolve) => {
            channel.port2.onmessage = () => resolve();
          });
          registration.active.postMessage(
            {
              type: "warm-offline-assets",
              urls: ["/sqlite3.wasm", ...sqliteRuntimeAssetUrls],
            },
            [channel.port1],
          );
          await Promise.race([warmed, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
        }
      })
      .catch(() => undefined);
  });
}

async function warmPageCache() {
  const cache = await caches.open(offlineCacheName);
  const urls = new Set(["/sqlite3.wasm", ...sqliteRuntimeAssetUrls]);
  try {
    const manifestResponse = await fetch("/cache-manifest.json", { cache: "no-cache" });
    if (manifestResponse.ok) {
      const manifestPaths = (await manifestResponse.json()) as string[];
      for (const path of manifestPaths) {
        urls.add(new URL(path, location.href).href);
      }
    }
  } catch {
    void 0;
  }
  await Promise.allSettled([...urls].map((url) => cache.add(url)));
}
