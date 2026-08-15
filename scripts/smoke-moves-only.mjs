import { strToU8, zipSync } from "fflate";
import { openPage, withPreview } from "./smoke-common.mjs";

const useDirectory = process.argv.includes("--dir");
const port = useDirectory ? 4178 : 4177;

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

await withPreview(port, async (baseUrl) => {
  const { browser, page, errors, consoleLog } = await openPage();

  if (useDirectory) {
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
        getFileHandle: async (n, options) => {
          if (!options?.create) {
            throw new DOMException("File not found", "NotFoundError");
          }
          return {
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
          };
        },
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
    }, JSON.stringify(movesStoryline));
  } else {
    await page.addInitScript(() => {
      window.showDirectoryPicker = undefined;
      window.showSaveFilePicker = undefined;
    });
  }

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });

  if (useDirectory) {
    await page.getByRole("button", { name: "Select backup folder" }).click();
  } else {
    await page.evaluate(() => {
      const input = document.querySelector("input[type=file]");
      input?.removeAttribute("webkitdirectory");
      input?.removeAttribute("directory");
    });
    const archive = zipSync({
      "moves_export/json/daily/storyline/storyline_20140401.json": strToU8(JSON.stringify(movesStoryline))
    });
    await page.locator("input[type=file]").setInputFiles({
      name: "moves-only.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(archive)
    });
  }

  let outcome = null;
  try {
    await Promise.race([
      page.getByText("Import file ready").waitFor({ timeout: 60_000 }),
      page.getByText("not recognized").waitFor({ timeout: 60_000 }),
      page.getByText(/could not find/i).waitFor({ timeout: 60_000 })
    ]);
  } catch {
    void 0;
  }
  outcome = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: `/tmp/moves-only-${useDirectory ? "dir-" : ""}conversion.png`, fullPage: true });
  await browser.close();

  const hasReady = outcome.includes("Import file ready");
  const hasError = /not recognized|could not find|could not finish/i.test(outcome);
  const reachedConverting = /Converting data|STEP 2 OF 3/.test(outcome);

  console.log("Body snippet:", outcome.slice(0, 500));
  console.log("Console (first 50):", consoleLog.slice(0, 50).join("\n"));
  console.log("Console errors:", errors.slice(0, 10).join("\n"));
  console.log({ hasReady, hasError, reachedConverting });

  if (hasError || !(hasReady || reachedConverting)) {
    throw new Error(`Moves-only ${useDirectory ? "directory " : ""}not recognized. hasReady=${hasReady} hasError=${hasError} reachedConverting=${reachedConverting}`);
  }
  console.log(`moves-only ${useDirectory ? "directory " : ""}smoke passed`);
});
