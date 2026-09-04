const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; object-src 'none'; frame-ancestors 'none';",
};

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const nextHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) {
      nextHeaders.set(name, value);
    }
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith(".wasm")) {
      nextHeaders.set("Content-Type", "application/wasm");
    } else if (pathname.endsWith(".txt")) {
      nextHeaders.set("Content-Type", "text/plain; charset=utf-8");
    } else if (pathname.endsWith(".xml")) {
      nextHeaders.set("Content-Type", "application/xml; charset=utf-8");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: nextHeaders,
    });
  },
};
