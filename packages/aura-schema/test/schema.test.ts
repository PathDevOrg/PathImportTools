import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { schemaFile } from "../src/index.js";

const configuredAppSchemaPath = process.env.AURA_SCHEMA_PATH;
const liveAppSchemaPath = configuredAppSchemaPath ? resolve(configuredAppSchemaPath) : null;

describe("Aura schema metadata", () => {
  test("describes one directly installable V13 schema", () => {
    expect(schemaFile).toEqual({ version: 13, name: "V13_schema.sql" });
  });

  test("builds a valid SQLite database directly from the V13 schema", () => {
    const workdir = mkdtempSync(join(tmpdir(), "aura-importer-schema-"));
    const dbPath = join(workdir, "schema.db");
    const schemaSql = readFileSync(resolve("packages/aura-schema", schemaFile.name), "utf8");
    const result = spawnSync(
      "sqlite3",
      [dbPath],
      {
        input: `${schemaSql}\nPRAGMA integrity_check;\nPRAGMA user_version;\nSELECT name FROM sqlite_master WHERE type='table' AND name IN ('custom_move_modes','move_mode_decisions','moves','route_paths','raw_device_motion','stay_place_rules') ORDER BY name;\nSELECT name FROM pragma_table_info('stays') WHERE name='end_tz_offset_s';\nSELECT name FROM pragma_table_info('moves') WHERE name='end_tz_offset_s';\nSELECT name FROM pragma_table_info('no_data_gaps') WHERE name IN ('tz_offset_s','end_tz_offset_s') ORDER BY name;\n`,
        encoding: "utf8"
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ok\n13\n");
    expect(result.stdout).toContain("custom_move_modes");
    expect(result.stdout).toContain("move_mode_decisions");
    expect(result.stdout).toContain("moves");
    expect(result.stdout).toContain("raw_device_motion");
    expect(result.stdout).toContain("route_paths");
    expect(result.stdout).toContain("stay_place_rules");
    expect(result.stdout.match(/end_tz_offset_s/g)).toHaveLength(3);
    expect(result.stdout.trim().split("\n").filter((value) => value === "tz_offset_s")).toHaveLength(1);
  });

  const schemaComparisonTest = liveAppSchemaPath ? test : test.skip;

  schemaComparisonTest("matches the live Path V13 schema when AURA_SCHEMA_PATH is provided", () => {
    const importerSchema = readFileSync(resolve("packages/aura-schema", schemaFile.name), "utf8");
    const appSchema = readFileSync(liveAppSchemaPath as string, "utf8");
    expect(schemaSnapshot(importerSchema)).toEqual(schemaSnapshot(appSchema));
  });

  test("contains creation-only V13 DDL without the removed samples R-Tree", () => {
    const schemaSql = readFileSync(resolve("packages/aura-schema", schemaFile.name), "utf8");

    expect(schemaSql).not.toMatch(/\b(?:DROP|ALTER)\b/i);
    expect(schemaSql).not.toContain("samples_rtree");
    expect(schemaSql).toContain("CREATE TRIGGER tle_no_overlap_ins");
    expect(schemaSql).toContain("CREATE TRIGGER tle_no_adjacent_same_kind_del");
    expect(schemaSql).toContain("PRAGMA user_version = 13");
  });

  test("enforces globally unique timeline start times in exported databases", () => {
    const workdir = mkdtempSync(join(tmpdir(), "aura-importer-timeline-start-"));
    const dbPath = join(workdir, "schema.db");
    const schemaSql = readFileSync(resolve("packages/aura-schema", schemaFile.name), "utf8");
    const result = spawnSync(
      "sqlite3",
      [dbPath],
      {
        input: `${schemaSql}\nSELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='uidx_timeline_start_ts';\n`,
        encoding: "utf8"
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe("1");

    const duplicateInsert = spawnSync(
      "sqlite3",
      [dbPath],
      {
        input: `
          INSERT INTO stays(id, start_ts, end_ts, centroid_lat, centroid_lon, radius_m)
          VALUES (1, 100, 100, 0, 0, 10);
          INSERT INTO moves(id, start_ts, end_ts, mode)
          VALUES (1, 100, 100, 'walking');
        `,
        encoding: "utf8"
      }
    );

    expect(duplicateInsert.status).not.toBe(0);
    expect(duplicateInsert.stderr).toContain("UNIQUE constraint failed: timeline_events.start_ts");
  });

  test("counts pedometer steps independently from distance quality", () => {
    const schemaSql = readFileSync(resolve("packages/aura-schema", schemaFile.name), "utf8");
    const result = spawnSync(
      "sqlite3",
      [":memory:"],
      {
        input: `${schemaSql}
          INSERT INTO raw_pedometer(id, ts, steps_delta, distance_m)
          VALUES
            (1, 100, 100, NULL),
            (2, 101, 200, 200),
            (3, 102, 300, 3000);
          SELECT total_steps || '|' || total_distance_m FROM daily_pedometer_stats;
          SELECT total_steps || '|' || total_distance_m FROM hourly_pedometer_stats;
          SELECT total_steps || '|' || total_distance_m FROM monthly_pedometer_stats;
        `,
        encoding: "utf8"
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").slice(-3)).toEqual(["600|200.0", "600|200.0", "600|200.0"]);
  });
});

function schemaSnapshot(sql: string): string[] {
  const marker = "__AURA_SCHEMA_SNAPSHOT__";
  const result = spawnSync(
    "sqlite3",
    [":memory:"],
    {
      input: `${sql}\nSELECT '${marker}';\nSELECT type || '|' || name || '|' || tbl_name || '|' || IFNULL(hex(sql), '') FROM sqlite_schema ORDER BY type, name;\nSELECT 'user_version|' || user_version FROM pragma_user_version;\n`,
      encoding: "utf8"
    }
  );
  expect(result.status, result.stderr).toBe(0);
  const markerIndex = result.stdout.indexOf(`${marker}\n`);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return result.stdout.slice(markerIndex + marker.length + 1).trim().split("\n");
}
