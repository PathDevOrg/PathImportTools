import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type AuraRows, type ConversionResult, type StreamableAuraRows, type StreamableAuraTable } from "@aura-importer/converter";
import type { AuraMigrationFile } from "@aura-importer/aura-schema";

type Migration = AuraMigrationFile & {
  sql: string;
};

export type DatabaseProgress = {
  phase: "schema" | "write" | "verify" | "export";
  message: string;
  completed: number;
  total: number;
};

export type DatabaseOutputTarget = {
  filename: string;
  saveHandle?: FileSystemFileHandle;
};

export type DatabaseOutput = {
  filename: string;
  size: number;
  savedToDisk: boolean;
  bytes?: Uint8Array;
};

export type AuraDatabaseWriter = {
  writeRows: <T extends StreamableAuraTable>(table: T, rows: StreamableAuraRows[T]) => void;
  finish: (result: ConversionResult) => Promise<DatabaseOutput>;
  abort: () => void;
};

type SqliteDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  selectValue: (sql: string) => unknown;
  close: () => void;
};

type SqliteStatement = {
  bind: (values: unknown[]) => SqliteStatement;
  stepReset: () => SqliteStatement;
  finalize: () => void;
};

type SqliteModule = {
  installOpfsSAHPoolVfs?: (options: { name: string; directory: string; initialCapacity: number }) => Promise<{
    OpfsSAHPoolDb: new (filename: string) => SqliteDatabase;
    exportFile: (filename: string) => Promise<Uint8Array>;
  }>;
  opfs?: {
    getDirForFilename: (filename: string, createDirs?: boolean) => Promise<[FileSystemDirectoryHandle, string]>;
  };
  oo1: {
    OpfsDb?: new (filename: string, flags?: string) => SqliteDatabase;
    DB: new (filename: string, flags?: string) => SqliteDatabase;
  };
};

const integrityCheckByteLimit = 512 * 1024 * 1024;
const exportProgressChunkBytes = 8 * 1024 * 1024;

const insertPlans: {
  [K in keyof AuraRows]: {
    table: K;
    columns: string[];
  }
}[keyof AuraRows][] = [
  {
    table: "pois",
    columns: [
      "id",
      "provider",
      "provider_poi_id",
      "name",
      "category",
      "subcategory",
      "lat",
      "lon",
      "radius_m",
      "visitCount",
      "first_seen_ts",
      "last_seen_ts",
      "thoroughfare",
      "sub_thoroughfare",
      "locality",
      "sub_locality",
      "administrative_area",
      "postal_code",
      "country"
    ]
  },
  {
    table: "stays",
    columns: ["id", "start_ts", "end_ts", "centroid_lat", "centroid_lon", "radius_m", "type", "poi_id", "tz_offset_s"]
  },
  {
    table: "moves",
    columns: ["id", "start_ts", "end_ts", "mode", "distance_m", "tz_offset_s", "provider"]
  },
  {
    table: "raw_gps",
    columns: [
      "id",
      "ts",
      "lat",
      "lon",
      "altitude_m",
      "h_acc_m",
      "v_acc_m",
      "speed_mps",
      "speed_acc_mps",
      "course_deg",
      "course_acc_deg",
      "tz_offset_s",
      "provider",
      "is_simulated"
    ]
  },
  {
    table: "samples",
    columns: [
      "id",
      "ts",
      "lat",
      "lon",
      "altitude_m",
      "speed_mps",
      "speed_acc_mps",
      "course_deg",
      "course_acc_deg",
      "h_acc_m",
      "v_acc_m",
      "estimator",
      "source_kind",
      "flags",
      "step_delta",
      "tz_offset_s"
    ]
  },
  {
    table: "raw_motion_activity",
    columns: [
      "id",
      "ts",
      "confidence",
      "is_stationary",
      "is_walking",
      "is_running",
      "is_automotive",
      "is_cycling",
      "is_on_foot",
      "is_unknown",
      "tz_offset_s"
    ]
  },
  {
    table: "raw_pedometer",
    columns: ["id", "ts", "steps_delta", "distance_m", "cadence_spm", "pace_s_per_m", "floors_up", "floors_down", "tz_offset_s"]
  },
  {
    table: "raw_visits",
    columns: ["id", "arrival_ts", "departure_ts", "lat", "lon", "horizontal_acc_m", "tz_offset_s"]
  },
  {
    table: "no_data_gaps",
    columns: ["id", "start_ts", "end_ts", "reason", "uncertainty", "notes"]
  },
  {
    table: "route_paths",
    columns: [
      "id",
      "move_id",
      "is_primary",
      "codec",
      "compression",
      "quantization_cm",
      "path_blob",
      "sample_count",
      "path_quality",
      "provider",
      "bbox_min_lat",
      "bbox_min_lon",
      "bbox_max_lat",
      "bbox_max_lon",
      "lod_level"
    ]
  },
  {
    table: "stay_pois",
    columns: ["stay_id", "poi_id", "role", "distance_m"]
  }
];

export async function createAuraDatabaseOutput(
  result: ConversionResult,
  migrations: Migration[],
  onProgress: (progress: DatabaseProgress) => void,
  target: DatabaseOutputTarget
): Promise<DatabaseOutput> {
  const writer = await createAuraDatabaseWriter(migrations, onProgress, target);
  try {
    return await writer.finish(result);
  } catch (error) {
    writer.abort();
    throw error;
  }
}

export async function createAuraDatabaseWriter(
  migrations: Migration[],
  onProgress: (progress: DatabaseProgress) => void,
  target: DatabaseOutputTarget
): Promise<AuraDatabaseWriter> {
  const sqlite3 = await sqlite3InitModule() as SqliteModule;
  const canStreamToSaveHandle = Boolean(target.saveHandle && sqlite3.oo1.OpfsDb && sqlite3.opfs);

  const internalFilename = canStreamToSaveHandle ? `/aura-importer-output/${Date.now()}-${Math.round(Math.random() * 100000)}-${target.filename}` : `/aura-import-${Date.now()}-${Math.round(Math.random() * 100000)}.db`;
  const OpfsDb = sqlite3.oo1.OpfsDb;
  const pool = canStreamToSaveHandle ? null : sqlite3.installOpfsSAHPoolVfs
    ? await sqlite3.installOpfsSAHPoolVfs({
      name: `aura-importer-${Date.now()}`,
      directory: `/aura-importer-${Date.now()}`,
      initialCapacity: 8
    })
    : null;
  const db = canStreamToSaveHandle && OpfsDb ? new OpfsDb(internalFilename, "cw") : pool ? new pool.OpfsSAHPoolDb(internalFilename) : new sqlite3.oo1.DB(":memory:", "ct");
  let statements: Map<keyof AuraRows, SqliteStatement> | null = null;
  let closed = false;
  let finished = false;
  let statementsFinalized = false;
  let transactionOpen = false;

  const finalizeStatements = (): void => {
    if (!statementsFinalized) {
      if (statements) {
        for (const statement of statements.values()) {
          statement.finalize();
        }
      }
      statementsFinalized = true;
    }
  };
  const closeDb = (): void => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };

  try {
    onProgress({ phase: "schema", message: "Applying Path schema", completed: 0, total: migrations.length });
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const [index, migration] of migrations.entries()) {
      db.exec(migration.sql);
      onProgress({ phase: "schema", message: `Applied ${migration.name}`, completed: index + 1, total: migrations.length });
    }
    db.exec("PRAGMA foreign_keys = ON");
    statements = makeInsertStatements(db);
    db.exec("BEGIN");
    transactionOpen = true;
  } catch (error) {
    finalizeStatements();
    closeDb();
    throw error;
  }

  return {
    writeRows: (table, rows) => {
      if (!statements) {
        throw new Error("Database writer is not ready");
      }
      insertTableRows(statements, tablePlan(table), rows as Array<Record<string, unknown>>);
    },
    finish: async (result) => {
      try {
        if (!statements) {
          throw new Error("Database writer is not ready");
        }
        insertRowsWithStatements(statements, result.rows, onProgress);
        insertMigrationRows(db, migrations);
        finalizeStatements();
        db.exec("COMMIT");
        transactionOpen = false;

        const estimatedBytes = databaseSizeBytes(db);
        if (estimatedBytes <= integrityCheckByteLimit) {
          onProgress({ phase: "verify", message: "Checking database integrity", completed: 0, total: 3 });
          const integrity = db.selectValue("PRAGMA integrity_check");
          if (integrity !== "ok") {
            throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
          }
          onProgress({ phase: "verify", message: "Integrity check passed", completed: 1, total: 3 });
        } else {
          onProgress({ phase: "verify", message: "Large database integrity scan skipped", completed: 1, total: 3 });
        }

        const foreignKeyRows = db.selectValue("SELECT COUNT(*) FROM pragma_foreign_key_check");
        if (typeof foreignKeyRows === "number" && foreignKeyRows > 0) {
          throw new Error(`SQLite foreign key check failed: ${foreignKeyRows}`);
        }
        onProgress({ phase: "verify", message: "Foreign key check passed", completed: 2, total: 3 });

        const version = db.selectValue("PRAGMA user_version");
        if (version !== result.report.userVersion) {
          throw new Error(`Unexpected schema version: ${String(version)}`);
        }
        onProgress({ phase: "verify", message: "Schema version verified", completed: 3, total: 3 });

        if (target.saveHandle && canStreamToSaveHandle) {
          closeDb();
          const size = await saveOpfsFile(sqlite3, internalFilename, target.saveHandle, onProgress);
          finished = true;
          return { filename: target.filename, size, savedToDisk: true };
        }

        onProgress({ phase: "export", message: "Exporting database file", completed: 0, total: 1 });
        if (pool) {
          closeDb();
          const bytes = await pool.exportFile(internalFilename);
          onProgress({ phase: "export", message: "Database file exported", completed: 1, total: 1 });
          finished = true;
          return { filename: target.filename, size: bytes.byteLength, savedToDisk: false, bytes };
        }

        const fallback = sqlite3 as unknown as { capi?: { sqlite3_js_db_export?: (pointer: unknown) => Uint8Array } };
        const pointer = (db as unknown as { pointer: unknown }).pointer;
        const bytes = fallback.capi?.sqlite3_js_db_export?.(pointer);
        if (!bytes) {
          throw new Error("This browser cannot export the in-memory SQLite database");
        }
        closeDb();
        onProgress({ phase: "export", message: "Database file exported", completed: 1, total: 1 });
        finished = true;
        return { filename: target.filename, size: bytes.byteLength, savedToDisk: false, bytes };
      } catch (error) {
        finalizeStatements();
        if (transactionOpen) {
          db.exec("ROLLBACK");
          transactionOpen = false;
        }
        closeDb();
        throw error;
      }
    },
    abort: () => {
      if (finished) {
        return;
      }
      finalizeStatements();
      if (transactionOpen) {
        try {
          db.exec("ROLLBACK");
        } catch {
          transactionOpen = false;
        }
        transactionOpen = false;
      }
      closeDb();
    }
  };
}

async function saveOpfsFile(
  sqlite3: SqliteModule,
  filename: string,
  saveHandle: FileSystemFileHandle,
  onProgress: (progress: DatabaseProgress) => void
): Promise<number> {
  if (!sqlite3.opfs) {
    throw new Error("OPFS output is not available in this browser.");
  }
  const [directory, filePart] = await sqlite3.opfs.getDirForFilename(filename, false);
  const sourceHandle = await directory.getFileHandle(filePart);
  const sourceFile = await sourceHandle.getFile();
  const total = Math.max(1, Math.ceil(sourceFile.size / exportProgressChunkBytes));
  onProgress({ phase: "export", message: "Saving database file", completed: 0, total });

  let writable: FileSystemWritableFileStream | null = null;
  let writableClosed = false;
  try {
    writable = await saveHandle.createWritable();
    const reader = sourceFile.stream().getReader();
    let completedBytes = 0;
    let completedUnits = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await writable.write(value);
      completedBytes += value.byteLength;
      const nextUnits = Math.min(total, Math.floor(completedBytes / exportProgressChunkBytes));
      if (nextUnits > completedUnits) {
        completedUnits = nextUnits;
        onProgress({ phase: "export", message: "Saving database file", completed: completedUnits, total });
      }
    }
    await writable.close();
    writableClosed = true;
    onProgress({ phase: "export", message: "Database file saved", completed: total, total });
    return sourceFile.size;
  } catch (error) {
    if (writable && !writableClosed) {
      await writable.abort(error).catch(() => undefined);
    }
    throw error;
  }
}

function databaseSizeBytes(db: SqliteDatabase): number {
  const pageCount = numberSelect(db, "PRAGMA page_count");
  const pageSize = numberSelect(db, "PRAGMA page_size");
  return pageCount * pageSize;
}

function numberSelect(db: SqliteDatabase, sql: string): number {
  const value = db.selectValue(sql);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Unexpected SQLite numeric value for ${sql}: ${String(value)}`);
}

function makeInsertStatements(db: SqliteDatabase): Map<keyof AuraRows, SqliteStatement> {
  const statements = new Map<keyof AuraRows, SqliteStatement>();
  for (const plan of insertPlans) {
    const placeholders = plan.columns.map(() => "?").join(", ");
    statements.set(plan.table, db.prepare(`INSERT INTO ${plan.table} (${plan.columns.join(", ")}) VALUES (${placeholders})`));
  }
  return statements;
}

function insertRowsWithStatements(statements: Map<keyof AuraRows, SqliteStatement>, rows: AuraRows, onProgress: (progress: DatabaseProgress) => void): void {
  const total = Object.values(rows).reduce((sum, tableRows) => sum + tableRows.length, 0);
  let completed = 0;
  const insertRow = (plan: { table: keyof AuraRows; columns: string[] }, row: Record<string, unknown>): void => {
    insertRowWithStatements(statements, plan, row);
    completed += 1;
    if (completed === total || completed % 500 === 0) {
      onProgress({ phase: "write", message: `Building ${plan.table}`, completed, total });
    }
  };

  insertTableRows(statements, tablePlan("pois"), rows.pois as Array<Record<string, unknown>>, insertRow);
  insertSemanticRows(rows, insertRow);

  for (const plan of insertPlans) {
    if (plan.table === "pois" || plan.table === "stays" || plan.table === "moves" || plan.table === "no_data_gaps") {
      continue;
    }
    insertTableRows(statements, plan, rows[plan.table] as Array<Record<string, unknown>>, insertRow);
  }
}

function insertTableRows(
  statements: Map<keyof AuraRows, SqliteStatement>,
  plan: { table: keyof AuraRows; columns: string[] },
  tableRows: Array<Record<string, unknown>>,
  insertRow?: (plan: { table: keyof AuraRows; columns: string[] }, row: Record<string, unknown>) => void
): void {
  for (const row of tableRows) {
    if (insertRow) {
      insertRow(plan, row);
    } else {
      insertRowWithStatements(statements, plan, row);
    }
  }
}

function insertRowWithStatements(statements: Map<keyof AuraRows, SqliteStatement>, plan: { table: keyof AuraRows; columns: string[] }, row: Record<string, unknown>): void {
  const statement = statements.get(plan.table);
  if (!statement) {
    throw new Error(`No statement for ${plan.table}`);
  }
  statement.bind(plan.columns.map((column) => row[column] ?? null)).stepReset();
}

function insertSemanticRows(
  rows: AuraRows,
  insertRow: (plan: { table: keyof AuraRows; columns: string[] }, row: Record<string, unknown>) => void
): void {
  const semanticRows: Array<{
    table: "stays" | "moves" | "no_data_gaps";
    start: number;
    row: Record<string, unknown>;
  }> = [];
  for (const row of rows.stays) {
    semanticRows.push({ table: "stays", start: row.start_ts, row: row as Record<string, unknown> });
  }
  for (const row of rows.moves) {
    semanticRows.push({ table: "moves", start: row.start_ts, row: row as Record<string, unknown> });
  }
  for (const row of rows.no_data_gaps) {
    semanticRows.push({ table: "no_data_gaps", start: row.start_ts, row: row as Record<string, unknown> });
  }
  semanticRows.sort((lhs, rhs) => {
    if (lhs.start !== rhs.start) {
      return lhs.start - rhs.start;
    }
    const order = { stays: 0, moves: 1, no_data_gaps: 2 };
    return order[lhs.table] - order[rhs.table];
  });

  for (const entry of semanticRows) {
    insertRow(tablePlan(entry.table), entry.row);
  }
}

function tablePlan(table: keyof AuraRows): {
  table: keyof AuraRows;
  columns: string[];
} {
  const plan = insertPlans.find((item) => item.table === table);
  if (!plan) {
    throw new Error(`No insert plan for ${table}`);
  }
  return plan;
}

function insertMigrationRows(db: SqliteDatabase, migrations: Migration[]): void {
  const statement = db.prepare("INSERT INTO migrations (applied_at_ts, from_version, to_version, notes) VALUES (?, ?, ?, ?)");
  try {
    let previous = 0;
    const now = Date.now() / 1000;
    for (const migration of migrations) {
      statement.bind([now, previous, migration.version, `Path Import ${migration.name}`]).stepReset();
      previous = migration.version;
    }
  } finally {
    statement.finalize();
  }
}
