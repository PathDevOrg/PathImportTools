const cacheName = "path-import-v1";
const manifestUrl = "/cache-manifest.json";

const precacheBasePaths = [
  "/",
  "/index.html",
  "/favicon.ico",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/path-logo.png",
  "/download-on-the-app-store.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const tried = [...precacheBasePaths, manifestUrl];
    await cache.addAll(tried).catch(() => undefined);
    let manifestPaths = [];
    try {
      const manifestResponse = await fetch(manifestUrl);
      if (manifestResponse.ok) {
        manifestPaths = (await manifestResponse.json());
        await cache.addAll(manifestPaths).catch(() => undefined);
      }
    } catch {
      // online-in-development may serve no manifest; SW degrades to runtime-caching
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (!isCacheablePath(url.pathname)) {
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
      void updateCacheInBackground(cache, request);
      return cached;
    }
    try {
      const networkResponse = await fetch(request);
      if (networkResponse.ok) {
        cache.put(request, networkResponse.clone()).catch(() => undefined);
      }
      return networkResponse;
    } catch (error) {
      const fallback = await cache.match(url.pathname) ?? await cache.match("/index.html");
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  })());
});

async function updateCacheInBackground(cache, request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
  } catch {
    // network unavailable, keep existing cache
  }
}

function isCacheablePath(pathname) {
  if (pathname === "/" || pathname === "/index.html" || pathname === "/cache-manifest.json" || pathname === "/sw.js") {
    return true;
  }
  if (pathname.startsWith("/assets/")) {
    return true;
  }
  return ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png", "/path-logo.png", "/download-on-the-app-store.svg"].includes(pathname);
}
