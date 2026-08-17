import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright";
import { withPreview } from "./smoke-common.mjs";

await withPreview(4181, async (baseUrl) => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 808 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleAll = [];
  page.on("console", (m) => consoleAll.push(`[${m.type()}] ${m.text()}`));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.addInitScript(() => {
    window.showDirectoryPicker = undefined;
    window.showSaveFilePicker = undefined;
  });

  const arcArchive = zipSync({
    "Export/JSON/Daily/2024-05-01.json": strToU8(
      JSON.stringify({
        timelineItems: [
          {
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:20:00Z",
            activityType: "walk",
            samples: [{ date: "2024-05-01T10:00:00Z", latitude: -33.8688, longitude: 151.2093, horizontalAccuracy: 8 }],
          },
        ],
      }),
    ),
  });
  const movesArchive = zipSync({
    "moves_export/json/daily/storyline/storyline_20140401.json": strToU8(
      JSON.stringify([
        {
          date: "20140401",
          segments: [
            {
              type: "place",
              startTime: "20140401T080000+0300",
              endTime: "20140401T090000+0300",
              place: { id: 42, name: "Home", location: { lat: 60.17, lon: 24.94 } },
            },
          ],
        },
      ]),
    ),
  });

  // 1) Online warmup. Load the page, take it through one full conversion so all assets (including wasm) are read.
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const input = document.querySelector("input[type=file]");
    input?.removeAttribute("webkitdirectory");
    input?.removeAttribute("directory");
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "arc-export.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(arcArchive),
  });
  await page.getByText("Import file ready").waitFor({ timeout: 30_000 });
  console.log("[online] conversion reached Import file ready");

  // 2) Wait for the SW to be the controlling SW for this page.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, { timeout: 15_000 });
  const swState = await page.evaluate(() => navigator.serviceWorker.controller?.state);
  console.log("[online] SW controller state:", swState);

  // 3) Wait a moment for the SW fetch handler to finish caching warm assets already requested by the page.
  await page.waitForTimeout(1500);

  // 4) Now go offline and hard-reload.
  await context.setOffline(true);
  console.log("[offline] context offline set");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e) => {
    console.log("[offline] reload error:", e.message);
  });

  // 5) Page should be served from cache. Verify the React app actually boots.
  await page
    .waitForFunction(
      () => !!document.querySelector("button") && document.body.innerText.includes("Select backup folder"),
      { timeout: 30_000 },
    )
    .catch(async () => {
      const html = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 1500));
      console.log("[offline] page did not boot from cache. HTML head:", html);
    });

  await page.evaluate(() => {
    const input = document.querySelector("input[type=file]");
    input?.removeAttribute("webkitdirectory");
    input?.removeAttribute("directory");
  });

  // 6) Trigger the moves-only conversion offline. wasm will be served from cache.
  await page.locator("input[type=file]").setInputFiles({
    name: "moves-only.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(movesArchive),
  });
  await page
    .getByText("Import file ready")
    .waitFor({ timeout: 30_000 })
    .catch(async () => {
      console.log("[offline] did not reach Import file ready after offline conversion");
    });
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: "/tmp/offline-moves-conversion.png", fullPage: true });
  await browser.close();

  const hasReady = bodyText.includes("Import file ready");
  const hasError = /not recognized|could not find|could not finish|Aborted|NetworkError/i.test(bodyText);
  console.log("[offline] body snippet:", bodyText.slice(0, 400));
  console.log("[offline] console errors:", errors.slice(0, 10).join("\n"));
  console.log("[offline] console (first 30):", consoleAll.slice(0, 30).join("\n"));
  console.log({ hasReady, hasError });

  if (!hasReady || hasError) {
    throw new Error(`Offline conversion failed. hasReady=${hasReady}, hasError=${hasError}`);
  }
  console.log("offline smoke passed");
});
