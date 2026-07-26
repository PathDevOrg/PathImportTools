import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { zipSync } from "fflate";

const monthlyGzPath = process.env.ARC_MONTHLY_GZ
  ?? "/Users/apple/Documents/Aura/PathTools/movesarc/Export/JSON/Monthly/2024-05.json.gz";

const port = 4176;
const baseUrl = `http://127.0.0.1:${port}`;
const preview = spawn("npm", ["run", "preview", "-w", "@aura-importer/web", "--", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
preview.stdout.on("data", (chunk) => { output += chunk.toString(); });
preview.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  await waitForServer();
  await runMonthlyConversionCheck();
} finally {
  preview.kill();
  await once(preview, "exit").catch(() => undefined);
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(`Preview exited early:\n${output}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Preview did not start:\n${output}`);
}

async function runMonthlyConversionCheck() {
  const gzBytes = readFileSync(monthlyGzPath);
  if (gzBytes.length < 10_000_000) {
    throw new Error(`Expected a large (>10MB) real monthly gz at ${monthlyGzPath}, got ${gzBytes.length} bytes`);
  }

  const archive = zipSync({
    "Export/JSON/Monthly/2024-05.json.gz": [gzBytes, { level: 0 }]
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 808 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("crash", () => errors.push("page crashed"));
  await page.addInitScript(() => {
    window.showDirectoryPicker = undefined;
    window.showSaveFilePicker = undefined;
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.evaluate(() => {
    const input = document.querySelector("input[type=file]");
    input?.removeAttribute("webkitdirectory");
    input?.removeAttribute("directory");
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "arc-monthly.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive)
  });
  await page.getByText("Import file ready").waitFor({ timeout: 120_000 });
  await page.getByText("Download again").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/path-import-monthly-smoke.png", fullPage: true });
  await browser.close();

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  console.log("arc monthly smoke passed");
}
