import { open } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { openPage, withPreview } from "./smoke-common.mjs";

await withPreview(4175, async (baseUrl) => {
  await runMockedDirectoryCheck(baseUrl);
  await runActualConversionCheck(baseUrl);
});

async function runMockedDirectoryCheck(baseUrl) {
  const { browser, page, errors } = await openPage();
  await page.addInitScript(() => {
    window.__savePickerCalled = false;
    window.__lastOutput = null;
    window.showSaveFilePicker = async () => {
      window.__savePickerCalled = true;
      throw new Error("showSaveFilePicker should not be used on the directory picker path");
    };
    window.showDirectoryPicker = async () => ({
      kind: "directory",
      name: "movesarc",
      getFileHandle: async (name, options) => {
        if (name === "storyline.json" || options?.create) {
          return { kind: "file", name };
        }
        throw new DOMException("File not found", "NotFoundError");
      },
      entries: async function* () {
        yield [
          "storyline.json",
          {
            kind: "file",
            name: "storyline.json",
            getFile: async () => new File(["{}"], "storyline.json", { type: "application/json" }),
          },
        ];
      },
    });
    class MockWorker {
      constructor() {
        this.onmessage = null;
      }

      postMessage(request) {
        if (request.type === "scan") {
          setTimeout(
            () =>
              this.onmessage?.({
                data: {
                  id: request.id,
                  type: "scan-complete",
                  scan: { totalFileCount: 1, supportedFileCount: 1, bySource: [] },
                },
              }),
            10,
          );
        } else {
          window.__lastOutput = request.output;
          setTimeout(
            () =>
              this.onmessage?.({
                data: {
                  id: request.id,
                  type: "convert-complete",
                  filename: request.output.filename,
                  size: 3,
                  savedToDisk: Boolean(request.output.saveHandle),
                  report: {},
                  diagnostics: [],
                },
              }),
            10,
          );
        }
      }

      terminate() {}
    }
    window.Worker = MockWorker;
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.getByRole("button", { name: "Select backup folder" }).click();
  await page.getByText("Import file ready").waitFor({ timeout: 5_000 });
  await page.getByText("Saved to disk").waitFor({ timeout: 5_000 });
  const result = await page.evaluate(() => ({
    savePickerCalled: window.__savePickerCalled,
    outputName: window.__lastOutput?.filename,
    hasSaveHandle: Boolean(window.__lastOutput?.saveHandle),
    githubHref: document.querySelector(".github-badge")?.href,
    body: document.body.innerText,
  }));
  await page.screenshot({ path: "/tmp/path-import-smoke.png", fullPage: true });
  await browser.close();

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  if (result.savePickerCalled || !result.hasSaveHandle || !result.outputName?.endsWith(".db")) {
    throw new Error(JSON.stringify(result, null, 2));
  }
  if (
    result.githubHref !== "https://github.com/PathDevOrg/PathImportTools" ||
    !result.body.includes("designed to work offline")
  ) {
    throw new Error(JSON.stringify(result, null, 2));
  }
}

async function runActualConversionCheck(baseUrl) {
  const { browser, page, errors } = await openPage();
  await page.addInitScript(() => {
    window.showDirectoryPicker = undefined;
    window.showSaveFilePicker = undefined;
  });

  const archive = zipSync({
    "Export/JSON/Daily/2024-05-01.json": strToU8(
      JSON.stringify({
        timelineItems: [
          {
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:20:00Z",
            activityType: "walk",
            samples: [
              {
                date: "2024-05-01T10:00:00Z",
                latitude: -33.8688,
                longitude: 151.2093,
                horizontalAccuracy: 8,
              },
            ],
          },
        ],
      }),
    ),
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.evaluate(() => {
    const input = document.querySelector("input[type=file]");
    input?.removeAttribute("webkitdirectory");
    input?.removeAttribute("directory");
  });
  const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("input[type=file]").setInputFiles({
    name: "arc-export.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await page.getByText("Import file ready").waitFor({ timeout: 20_000 });
  await page.getByText("Download again").waitFor({ timeout: 5_000 });
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) {
    throw new Error("Browser download did not produce a local file");
  }
  const downloadedFile = await open(downloadedPath, "r");
  const header = Buffer.alloc(16);
  try {
    await downloadedFile.read(header, 0, header.length, 0);
  } finally {
    await downloadedFile.close();
  }
  if (header.toString("utf8") !== "SQLite format 3\u0000") {
    throw new Error(`Unexpected downloaded database header: ${header.toString("hex")}`);
  }
  const retainedOpfsOutputs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const output = await root.getDirectoryHandle("aura-importer-output");
    let count = 0;
    for await (const _ of output.values()) {
      count += 1;
    }
    return count;
  });
  if (retainedOpfsOutputs < 1) {
    throw new Error("OPFS download source was removed before the browser completed the download");
  }
  await page.screenshot({ path: "/tmp/path-import-actual-conversion-smoke.png", fullPage: true });
  await browser.close();

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  console.log("web smoke passed");
}
