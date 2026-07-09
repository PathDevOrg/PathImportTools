import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getLatestSchemaVersion, migrationFiles } from "../src/index.js";

describe("Aura schema metadata", () => {
  test("tracks Aura migrations through V9", () => {
    expect(getLatestSchemaVersion()).toBe(9);
    expect(migrationFiles.map((file) => file.name)).toEqual([
      "V1_schema.sql",
      "V2_timeline_view.sql",
      "V3_optimization.sql",
      "V4_device_motion.sql",
      "V5_refined_tracks.sql",
      "V6_estimated_quality.sql",
      "V7_stay_name_rules.sql",
      "V8_timeline_query_indexes.sql",
      "V9_move_mode_decisions.sql"
    ]);
  });

  test("builds a valid SQLite database from vendored migrations", () => {
    const workdir = mkdtempSync(join(tmpdir(), "aura-importer-schema-"));
    const dbPath = join(workdir, "schema.db");
    const migrationSql = migrationFiles
      .map((file) => readFileSync(resolve("packages/aura-schema/migrations", file.name), "utf8"))
      .join("\n");
    const result = spawnSync(
      "sqlite3",
      [dbPath],
      {
        input: `${migrationSql}\nPRAGMA integrity_check;\nPRAGMA user_version;\nSELECT name FROM sqlite_master WHERE type='table' AND name IN ('custom_move_modes','move_mode_decisions','moves','route_paths','raw_device_motion','stay_place_rules') ORDER BY name;\n`,
        encoding: "utf8"
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ok\n9\n");
    expect(result.stdout).toContain("custom_move_modes");
    expect(result.stdout).toContain("move_mode_decisions");
    expect(result.stdout).toContain("moves");
    expect(result.stdout).toContain("raw_device_motion");
    expect(result.stdout).toContain("route_paths");
    expect(result.stdout).toContain("stay_place_rules");
  });
});
