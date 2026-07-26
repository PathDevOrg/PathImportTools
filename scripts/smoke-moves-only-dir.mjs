import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

const port = 4178;
const baseUrl = `http://127.0.0.1:${port}`;
const preview = spawn("npm", ["run", "preview", "-w", "@aura-importer/web", "--", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
preview.stdout.on("data", (chunk) => { output += chunk.toString(); });
preview.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  await waitForServer();
  await runMovesOnlyDirectoryCheck();
} finally {
  preview.kill();
  await once(preview, "exit").catch(() => undefined);
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) throw new Error(`Preview exited early:\n${output}`);
    try {
      const r = await fetch(baseUrl);
      if (r.ok) return;
    } catch {
      await new Promise((s) => setTimeout(s, 250));
    }
  }
  throw new Error(`Preview did not start:\n${output}`);
}

function makeMovesJson(filename) {
  return JSON.stringify([
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
  ]);
}

async function runMovesOnlyDirectoryCheck() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 808 }, deviceScaleFactor: 1 });
  const errors = [];
  const allLog = [];
  page.on("console", (m) => {
    allLog.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const movesContent = makeMovesJson();
  await page.addInitScript((content) => {
    const contentBytes = content;
    window.showSaveFilePicker = async (opts) => ({
      kind: "file",
      name: opts?.suggestedName ?? "aura-import.db",
      createWritable: async () => ({
        write: async () => {},
        close: async () => {}
      })
    });
    window.showDirectoryPicker = async () => ({
      kind: "directory",
      name: "moves-export-only-dir",
      getFileHandle: async (n) => ({
        kind: "file",
        name: n,
        getFile: async () => new File([contentBytes], n, { type: "application/json" }),
        createWritable: async () => {
          const chunks = [];
          return {
            write: async (chunk) => { chunks.push(chunk); },
            close: async () => { window.__writtenChunks = chunks; }
          };
        }
      }),
      entries: async function* () {
        yield ["json", {
          kind: "directory",
          name: "json",
          getFileHandle: async () => null,
          entries: async function* () {
            yield ["daily", {
              kind: "directory",
              name: "daily",
              entries: async function* () {
                yield ["storyline", {
                  kind: "directory",
                  name: "storyline",
                  entries: async function* () {
                    yield ["storyline_20140401.json", {
                      kind: "file",
                      name: "storyline_20140401.json",
                      getFile: async () => new File([contentBytes], "storyline_20140401.json", { type: "application/json" })
                    }];
                  }
                }];
                yield ["activities", {
                  kind: "directory",
                  name: "activities",
                  entries: async function* () {
                    yield ["activities_20140401.json", {
                      kind: "file",
                      name: "activities_20140401.json",
                      getFile: async () => new File([JSON.stringify([{ date: "20140401", segments: null }])], "activities_20140401.json", { type: "application/json" })
                    }];
                  }
                }];
                yield ["summary", {
                  kind: "directory",
                  name: "summary",
                  entries: async function* () {
                    yield ["summary_20140401.json", {
                      kind: "file",
                      name: "summary_20140401.json",
                      getFile: async () => new File([JSON.stringify([{ date: "20140401", summary: null, caloriesIdle: 1 }])], "summary_20140401.json", { type: "application/json" })
                    }];
                  }
                }];
              }
            }];
          }
        }];
      }
    });
  }, movesContent);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.getByRole("button", { name: "Select backup folder" }).click();

  let outcome = null;
  try {
    await page.getByText("Import file ready").waitFor({ timeout: 60_000 });
  } catch {}
  outcome = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: "/tmp/moves-only-dir-conversion.png", fullPage: true });
  await browser.close();

  const hasReady = outcome.includes("Import file ready");
  const hasError = /not recognized|could not find|could not finish/i.test(outcome);
  const reachedConverting = /Converting data|STEP 2 OF 3/.test(outcome);
  const reachedScanningButNotError = hasReady || reachedConverting;

  console.log("Body snippet:", outcome.slice(0, 500));
  console.log("Console (first 50):", allLog.slice(0, 50).join("\n"));
  console.log("Console errors:", errors.slice(0, 10).join("\n"));
  console.log({ hasReady, hasError, reachedConverting });

  if (hasError || !reachedScanningButNotError) {
    throw new Error(`Moves-only directory not recognized (still empty or explicit error). hasReady=${hasReady} hasError=${hasError} reachedConverting=${reachedConverting}`);
  }
  console.log("moves-only directory smoke passed (scan recognized folder, mock filesystem write incomplete but reached converting stage)");
}
