const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
};

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const nextHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) {
      nextHeaders.set(name, value);
    }
    if (new URL(request.url).pathname.endsWith(".wasm")) {
      nextHeaders.set("Content-Type", "application/wasm");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: nextHeaders,
    });
  },
};
