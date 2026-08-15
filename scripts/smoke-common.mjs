import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

export async function withPreview(port, run) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const preview = spawn("npm", ["run", "preview", "-w", "@aura-importer/web", "--", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  preview.stdout.on("data", (chunk) => { output += chunk.toString(); });
  preview.stderr.on("data", (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer();
    await run(baseUrl);
  } finally {
    preview.kill();
    await once(preview, "exit").catch(() => undefined);
  }

  async function waitForServer() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (preview.exitCode !== null) throw new Error(`Preview exited early:\n${output}`);
      try {
        const response = await fetch(baseUrl);
        if (response.ok) return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`Preview did not start:\n${output}`);
  }
}

export async function openPage() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 808 }, deviceScaleFactor: 1 });
  const errors = [];
  const consoleLog = [];
  page.on("console", (message) => {
    consoleLog.push(`[${message.type()}] ${message.text()}`);
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("crash", () => errors.push("page crashed"));
  return { browser, page, errors, consoleLog };
}
