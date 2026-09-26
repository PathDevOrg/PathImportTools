const cacheName = "path-import-v2";
const manifestUrl = "/cache-manifest.json";

const precacheBasePaths = [
  "/",
  "/index.html",
  "/favicon.ico",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/path-logo.png",
  "/og-cover.jpg",
  "/download-on-the-app-store.svg",
  "/sqlite3.wasm",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      const tried = [...precacheBasePaths, manifestUrl];
      await cache.addAll(tried).catch(() => undefined);
      let manifestPaths = [];
      try {
        const manifestResponse = await fetch(manifestUrl);
        if (manifestResponse.ok) {
          manifestPaths = await manifestResponse.json();
          await cache.addAll(manifestPaths).catch(() => undefined);
        }
      } catch {
        // online-in-development may serve no manifest; SW degrades to runtime-caching
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "warm-offline-assets") {
    const port = event.ports[0];
    event.waitUntil(
      warmOfflineAssets(event.data.urls ?? []).then(() => {
        port?.postMessage("warm-complete");
      }),
    );
  }
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
  event.respondWith(isEntryPath(url.pathname) ? networkFirst(request, url) : cacheFirst(request, url));
});

async function networkFirst(request, url) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (isCacheableResponse(request, networkResponse)) {
      await cache.put(request, networkResponse.clone());
      if (url.pathname === manifestUrl) {
        await pruneStaleAssets(cache, networkResponse.clone());
      }
    }
    return networkResponse;
  } catch (error) {
    const fallback = (await cache.match(request)) ?? (await offlineFallback(cache, request, url));
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

async function cacheFirst(request, url) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    void updateCacheInBackground(cache, request);
    return cached;
  }
  try {
    const networkResponse = await fetch(request);
    if (isCacheableResponse(request, networkResponse)) {
      cache.put(request, networkResponse.clone()).catch(() => undefined);
    }
    return networkResponse;
  } catch (error) {
    const fallback = await offlineFallback(cache, request, url);
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

async function offlineFallback(cache, request, url) {
  return (
    (await cache.match(url.pathname)) ?? (request.mode === "navigate" ? await cache.match("/index.html") : undefined)
  );
}

function isEntryPath(pathname) {
  return pathname === "/" || pathname === "/index.html" || pathname === manifestUrl;
}

function isCacheableResponse(request, response) {
  if (!response.ok) {
    return false;
  }
  const contentType = response.headers.get("content-type") ?? "";
  return (
    request.mode === "navigate" || isEntryPath(new URL(request.url).pathname) || !contentType.includes("text/html")
  );
}

async function pruneStaleAssets(cache, manifestResponse) {
  try {
    const manifestPaths = new Set(await manifestResponse.json());
    const cachedRequests = await cache.keys();
    await Promise.all(
      cachedRequests
        .filter((cachedRequest) => {
          const pathname = new URL(cachedRequest.url).pathname;
          return pathname.startsWith("/assets/") && !manifestPaths.has(pathname);
        })
        .map((cachedRequest) => cache.delete(cachedRequest)),
    );
  } catch {
    // a manifest that cannot be parsed leaves the existing offline cache intact
  }
}

async function warmOfflineAssets(urls) {
  const cache = await caches.open(cacheName);
  const sameOriginUrls = urls.filter((url) => {
    try {
      return new URL(url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  await Promise.allSettled(sameOriginUrls.map((url) => cache.add(url)));
}

async function updateCacheInBackground(cache, request) {
  try {
    const networkResponse = await fetch(request);
    if (isCacheableResponse(request, networkResponse)) {
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
  if (
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/src/") ||
    pathname.startsWith("/node_modules/")
  ) {
    return true;
  }
  return [
    "/favicon.ico",
    "/favicon.png",
    "/apple-touch-icon.png",
    "/path-logo.png",
    "/og-cover.jpg",
    "/download-on-the-app-store.svg",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
  ].includes(pathname);
}
