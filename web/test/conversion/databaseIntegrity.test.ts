import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { convertImportEntries } from "@aura-importer/converter";
import { describe, expect, test } from "vitest";
import { createAuraDatabaseWriter } from "../../src/conversion/database.js";

const encoder = new TextEncoder();

describe("Aura database timeline verification", () => {
  test("exports a database after persisted timeline verification passes", async () => {
    const result = await convertedMove();
    const writer = await createAuraDatabaseWriter(() => undefined, { filename: "history.db" });
    expect(writer.outputMode).toBe("buffered");

    const output = await writer.finish(result);

    expect(output.bytes?.byteLength).toBeGreaterThan(0);
    const workdir = mkdtempSync(join(tmpdir(), "aura-importer-output-"));
    const databasePath = join(workdir, "history.db");
    writeFileSync(databasePath, output.bytes!);
    const verification = spawnSync("sqlite3", [databasePath], {
      input: "PRAGMA user_version; SELECT from_version, to_version, notes FROM migrations; SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'samples_rtree%';",
      encoding: "utf8"
    });
    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout.trim().split("\n")).toEqual([
      "12",
      "0|12|Aura Importer V12_schema.sql",
      "0"
    ]);
  });

  test("rejects a database whose persisted timeline differs from the verified conversion", async () => {
    const result = await convertedMove();
    result.report.timelineIntegrity.eventCount += 1;

    const writer = await createAuraDatabaseWriter(() => undefined, { filename: "history.db" });

    await expect(writer.finish(result)).rejects.toThrow("timeline verification failed");
  });

  test("persists mixed timeline events in chronological trigger-safe order", async () => {
    const result = await convertImportEntries([{
      path: "history.json",
      data: encoder.encode(JSON.stringify({ timelineItems: [
        { itemId: "stay-a", isVisit: true, startDate: "2024-05-01T08:00:00Z", endDate: "2024-05-01T09:00:00Z", center: { latitude: 1, longitude: 1 } },
        { itemId: "move", isVisit: false, startDate: "2024-05-01T09:00:00Z", endDate: "2024-05-01T10:00:00Z", activityType: "walking" },
        { itemId: "stay-b", isVisit: true, startDate: "2024-05-01T10:00:00Z", endDate: "2024-05-01T11:00:00Z", center: { latitude: 1.01, longitude: 1.01 } }
      ] }))
    }]);
    const writer = await createAuraDatabaseWriter(() => undefined, { filename: "history.db" });
    const output = await writer.finish(result);
    const workdir = mkdtempSync(join(tmpdir(), "aura-importer-mixed-"));
    const databasePath = join(workdir, "history.db");
    writeFileSync(databasePath, output.bytes!);

    const verification = spawnSync("sqlite3", [databasePath], {
      input: "SELECT kind || '|' || CAST(start_ts AS INTEGER) FROM timeline_events ORDER BY start_ts;",
      encoding: "utf8"
    });

    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout.trim().split("\n")).toEqual([
      `stay|${Date.parse("2024-05-01T08:00:00Z") / 1000}`,
      `move|${Date.parse("2024-05-01T09:00:00Z") / 1000}`,
      `stay|${Date.parse("2024-05-01T10:00:00Z") / 1000}`
    ]);
  });
});

async function convertedMove() {
  return convertImportEntries([{
    path: "Export/JSON/Daily/2024-05-01.json",
    data: encoder.encode(JSON.stringify({
      timelineItems: [{
        itemId: "move-1",
        isVisit: false,
        startDate: "2024-05-01T10:00:00Z",
        endDate: "2024-05-01T10:20:00Z",
        activityType: "walk"
      }]
    }))
  }]);
}
