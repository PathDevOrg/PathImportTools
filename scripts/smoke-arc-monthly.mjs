import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { openPage, withPreview } from "./smoke-common.mjs";

await withPreview(4176, async (baseUrl) => {
  const gzBytes = readFileSync(monthlyGzPath);
  if (gzBytes.length < 10_000_000) {
    throw new Error(`Expected a large (>10MB) real monthly gz at ${monthlyGzPath}, got ${gzBytes.length} bytes`);
  }

  const archive = zipSync({
    "Export/JSON/Monthly/2024-05.json.gz": [gzBytes, { level: 0 }],
  });

  const { browser, page, errors } = await openPage();
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
    buffer: Buffer.from(archive),
  });
  await page.getByText("Import file ready").waitFor({ timeout: 120_000 });
  await page.getByText("Download again").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/path-import-monthly-smoke.png", fullPage: true });
  await browser.close();

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  console.log("arc monthly smoke passed");
});
