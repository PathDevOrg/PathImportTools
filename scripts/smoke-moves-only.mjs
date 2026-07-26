import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import { strToU8, zipSync } from "fflate";

const port = 4177;
const baseUrl = `http://127.0.0.1:${port}`;
const preview = spawn("npm", ["run", "preview", "-w", "@aura-importer/web", "--", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
preview.stdout.on("data", (chunk) => { output += chunk.toString(); });
preview.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  await waitForServer();
  await runMovesOnlyConversionCheck();
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
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Preview did not start:\n${output}`);
}

async function runMovesOnlyConversionCheck() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 808 }, deviceScaleFactor: 1 });
  const errors = [];
  const allLog = [];
  page.on("console", (m) => {
    allLog.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.showDirectoryPicker = undefined;
    window.showSaveFilePicker = undefined;
  });

  const movesStoryline = [
    {
      date: "20140401",
      segments: [
        {
          type: "place",
          startTime: "20140401T080000+0300",
          endTime: "20140401T090000+0300",
          place: { id: 42, name: "Home", location: { lat: 60.17, lon: 24.94 } }
        },
        {
          type: "move",
          startTime: "20140401T090000+0300",
          endTime: "20140401T093000+0300",
          activities: [{
            activity: "tram", group: "transport",
            startTime: "20140401T090000+0300", endTime: "20140401T093000+0300",
            distance: 1500,
            trackPoints: [{ lat: 60.17, lon: 24.94 }, { lat: 60.18, lon: 24.95 }]
          }]
        }
      ]
    }
  ];
  const archive = zipSync({
    "moves_export/json/daily/storyline/storyline_20140401.json": strToU8(JSON.stringify(movesStoryline))
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.evaluate(() => {
    const input = document.querySelector("input[type=file]");
    input?.removeAttribute("webkitdirectory");
    input?.removeAttribute("directory");
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "moves-only.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive)
  });

  // Race success vs failure
  let outcome = null;
  try {
    await Promise.race([
      page.getByText("Import file ready").waitFor({ timeout: 25_000 }),
      page.getByText("not recognized").waitFor({ timeout: 25_000 }),
      page.getByText(/could not find/i).waitFor({ timeout: 25_000 })
    ]);
    outcome = await page.evaluate(() => document.body.innerText);
  } catch (e) {
    outcome = await page.evaluate(() => document.body.innerText);
  }

  await page.screenshot({ path: "/tmp/moves-only-conversion.png", fullPage: true });
  await browser.close();

  const hasReady = outcome.includes("Import file ready");
  const hasError = /not recognized|could not find|could not finish/i.test(outcome);

  console.log("Body snippet:", outcome.slice(0, 400));
  console.log("Console (first 30):", allLog.slice(0, 30).join("\n"));
  console.log("Console errors:", errors.slice(0, 10).join("\n"));
  console.log({ hasReady, hasError });

  if (!hasReady || hasError) {
    throw new Error(`Moves-only not recognized. hasReady=${hasReady} hasError=${hasError}`);
  }
  console.log("moves-only smoke passed");
}
