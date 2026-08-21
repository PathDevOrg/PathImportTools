import sqliteWasmBinary from "virtual:sqlite-wasm-binary";
import {
  type AuraRows,
  type ConversionResult,
  progressReportInterval,
  type StreamableAuraRows,
  type StreamableAuraTable,
  type TimelineIntegritySummary,
} from "@aura-importer/converter";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { acquireImporterStorageLease, cleanupStaleImporterStorage } from "./opfsCleanup";
import { pathSchema } from "./schema";

type DatabaseProgress = {
  phase: "schema" | "write" | "verify" | "export";
  message: string;
  completed: number;
  total: number;
};

type DatabaseOutputTarget = {
  filename: string;
  saveHandle?: FileSystemFileHandle;
  opfsDownload?: boolean;
};

type DatabaseOutput = {
  filename: string;
  savedToDisk: boolean;
  bytes?: Uint8Array;
  file?: File;
  release?: () => Promise<void>;
};

export type AuraDatabaseWriter = {
  outputMode: "direct-save" | "opfs-download" | "buffered";
  writeRows: <T extends StreamableAuraTable>(table: T, rows: StreamableAuraRows[T]) => void;
  finish: (result: ConversionResult) => Promise<DatabaseOutput>;
  abort: () => Promise<void>;
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

type SqlitePool = {
  OpfsSAHPoolDb: new (filename: string) => SqliteDatabase;
  exportFile: (filename: string) => Promise<Uint8Array>;
  unlink: (filename: string) => boolean;
  removeVfs: () => Promise<boolean>;
};

type SqliteInitOptions = {
  locateFile?: (file: string) => string;
  wasmBinary?: Uint8Array;
};

type SqliteModule = {
  installOpfsSAHPoolVfs?: (options: {
    name: string;
    directory: string;
    initialCapacity: number;
  }) => Promise<SqlitePool>;
  opfs?: {
    getDirForFilename: (filename: string, createDirs?: boolean) => Promise<[FileSystemDirectoryHandle, string]>;
  };
  oo1: {
    OpfsDb?: new (filename: string, flags?: string) => SqliteDatabase;
    DB: new (filename: string, flags?: string) => SqliteDatabase;
  };
};

const integrityCheckByteLimit = 512 * 1024 * 1024;
const bufferedExportByteLimit = 512 * 1024 * 1024;
const exportProgressChunkBytes = 8 * 1024 * 1024;

type TablePlan<K extends keyof AuraRows = keyof AuraRows> = {
  table: K;
  columns: ReadonlyArray<keyof AuraRows[K][number] & string>;
};

type AnyTablePlan = {
  [K in keyof AuraRows]: TablePlan<K>;
}[keyof AuraRows];

type InsertStatements = Map<keyof AuraRows, SqliteStatement>;

const insertPlans = [
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
      "country",
    ],
  },
  {
    table: "stays",
    columns: [
      "id",
      "start_ts",
      "end_ts",
      "centroid_lat",
      "centroid_lon",
      "radius_m",
      "type",
      "poi_id",
      "tz_offset_s",
      "end_tz_offset_s",
    ],
  },
  {
    table: "moves",
    columns: ["id", "start_ts", "end_ts", "mode", "distance_m", "tz_offset_s", "end_tz_offset_s", "provider"],
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
      "is_simulated",
    ],
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
      "tz_offset_s",
    ],
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
      "tz_offset_s",
    ],
  },
  {
    table: "raw_pedometer",
    columns: [
      "id",
      "ts",
      "steps_delta",
      "distance_m",
      "cadence_spm",
      "pace_s_per_m",
      "floors_up",
      "floors_down",
      "tz_offset_s",
    ],
  },
  {
    table: "raw_visits",
    columns: ["id", "arrival_ts", "departure_ts", "lat", "lon", "horizontal_acc_m", "tz_offset_s"],
  },
  {
    table: "no_data_gaps",
    columns: ["id", "start_ts", "end_ts", "reason", "uncertainty", "notes", "tz_offset_s", "end_tz_offset_s"],
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
      "lod_level",
    ],
  },
  {
    table: "stay_pois",
    columns: ["stay_id", "poi_id", "role", "distance_m"],
  },
] as const satisfies readonly AnyTablePlan[];

export async function createAuraDatabaseWriter(
  onProgress: (progress: DatabaseProgress) => void,
  target: DatabaseOutputTarget,
  options: { signal?: AbortSignal } = {},
): Promise<AuraDatabaseWriter> {
  throwIfAborted(options.signal);
  const initializeSqlite = sqlite3InitModule as unknown as (options?: SqliteInitOptions) => Promise<SqliteModule>;
  const useStableWasmPath = typeof location !== "undefined" && location.protocol.startsWith("http");
  const sqlite3 = useStableWasmPath
    ? await initializeSqlite({ locateFile: () => "/sqlite3.wasm", wasmBinary: sqliteWasmBinary })
    : await initializeSqlite();
  await cleanupStaleImporterStorage();
  const canUseCanonicalOpfs = Boolean((target.saveHandle || target.opfsDownload) && sqlite3.oo1.OpfsDb && sqlite3.opfs);
  const outputMode: AuraDatabaseWriter["outputMode"] =
    target.saveHandle && canUseCanonicalOpfs
      ? "direct-save"
      : target.opfsDownload && canUseCanonicalOpfs
        ? "opfs-download"
        : "buffered";

  const internalFilename = canUseCanonicalOpfs
    ? `/aura-importer-output/${Date.now()}-${Math.round(Math.random() * 100000)}-${target.filename}`
    : `/aura-import-${Date.now()}-${Math.round(Math.random() * 100000)}.db`;
  const OpfsDb = sqlite3.oo1.OpfsDb;
  const poolId = `${Date.now()}-${Math.round(Math.random() * 100000)}`;
  const storageLease = await acquireImporterStorageLease(
    canUseCanonicalOpfs ? `output/${internalFilename.split("/").at(-1)!}` : `pool/aura-importer-${poolId}`,
  );
  let initializingPool: SqlitePool | null = null;
  const initialized = await (async () => {
    try {
      initializingPool = canUseCanonicalOpfs
        ? null
        : sqlite3.installOpfsSAHPoolVfs
          ? await sqlite3.installOpfsSAHPoolVfs({
              name: `aura-importer-${poolId}`,
              directory: `/aura-importer-${poolId}`,
              initialCapacity: 8,
            })
          : null;
      const db =
        canUseCanonicalOpfs && OpfsDb
          ? new OpfsDb(internalFilename, "cw")
          : initializingPool
            ? new initializingPool.OpfsSAHPoolDb(internalFilename)
            : new sqlite3.oo1.DB(":memory:", "c");
      return { pool: initializingPool, db };
    } catch (error) {
      try {
        if (initializingPool) {
          initializingPool.unlink(internalFilename);
          await initializingPool.removeVfs();
        } else if (canUseCanonicalOpfs) {
          await removeOpfsFile(sqlite3, internalFilename);
        }
      } finally {
        await storageLease();
      }
      throw error;
    }
  })();
  const { pool, db } = initialized;
  let statements: InsertStatements | null = null;
  let closed = false;
  let finished = false;
  let statementsFinalized = false;
  let transactionOpen = false;
  let storageCleaned = false;
  let storageLeaseReleased = false;

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
  const releaseStorageLease = async (): Promise<void> => {
    if (storageLeaseReleased) {
      return;
    }
    storageLeaseReleased = true;
    await storageLease();
  };
  const cleanupStorage = async (): Promise<void> => {
    if (storageCleaned) {
      return;
    }
    storageCleaned = true;
    try {
      closeDb();
      if (pool) {
        pool.unlink(internalFilename);
        await pool.removeVfs();
      } else if (canUseCanonicalOpfs) {
        await removeOpfsFile(sqlite3, internalFilename);
      }
    } finally {
      await releaseStorageLease();
    }
  };

  try {
    onProgress({ phase: "schema", message: `Applying Path V${pathSchema.version} schema`, completed: 0, total: 1 });
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(pathSchema.sql);
    onProgress({ phase: "schema", message: `Applied ${pathSchema.name}`, completed: 1, total: 1 });
    db.exec("PRAGMA foreign_keys = ON");
    statements = makeInsertStatements(db);
    db.exec("BEGIN");
    transactionOpen = true;
  } catch (error) {
    finalizeStatements();
    await cleanupStorage();
    throw error;
  }

  return {
    outputMode,
    writeRows: (table, rows) => {
      throwIfAborted(options.signal);
      if (!statements) {
        throw new Error("Database writer is not ready");
      }
      insertTableRows(statements, tablePlan(table), rows);
    },
    finish: async (result) => {
      try {
        throwIfAborted(options.signal);
        if (!statements) {
          throw new Error("Database writer is not ready");
        }
        insertRowsWithStatements(statements, result.rows, onProgress, options.signal);
        insertSchemaRecord(db);
        finalizeStatements();
        db.exec("COMMIT");
        transactionOpen = false;

        const estimatedBytes = databaseSizeBytes(db);
        const integrityPragma = estimatedBytes <= integrityCheckByteLimit ? "integrity_check" : "quick_check";
        onProgress({ phase: "verify", message: `Running SQLite ${integrityPragma}`, completed: 0, total: 4 });
        const integrity = db.selectValue(`PRAGMA ${integrityPragma}`);
        if (integrity !== "ok") {
          throw new Error(`SQLite ${integrityPragma} failed: ${String(integrity)}`);
        }
        onProgress({ phase: "verify", message: `SQLite ${integrityPragma} passed`, completed: 1, total: 4 });

        const foreignKeyRows = db.selectValue("SELECT COUNT(*) FROM pragma_foreign_key_check");
        if (typeof foreignKeyRows === "number" && foreignKeyRows > 0) {
          throw new Error(`SQLite foreign key check failed: ${foreignKeyRows}`);
        }
        onProgress({ phase: "verify", message: "Foreign key check passed", completed: 2, total: 4 });

        verifyPersistedTimeline(db, result.report.timelineIntegrity);
        onProgress({ phase: "verify", message: "Timeline requirements verified", completed: 3, total: 4 });

        const version = db.selectValue("PRAGMA user_version");
        if (version !== result.report.userVersion) {
          throw new Error(`Unexpected schema version: ${String(version)}`);
        }
        onProgress({ phase: "verify", message: "Schema version verified", completed: 4, total: 4 });

        if (target.saveHandle && canUseCanonicalOpfs) {
          closeDb();
          await saveOpfsFile(sqlite3, internalFilename, target.saveHandle, onProgress, options.signal);
          await cleanupStorage();
          finished = true;
          return { filename: target.filename, savedToDisk: true };
        }

        if (target.opfsDownload && canUseCanonicalOpfs) {
          onProgress({ phase: "export", message: "Preparing database download", completed: 0, total: 1 });
          closeDb();
          const file = await getOpfsFile(sqlite3, internalFilename);
          onProgress({ phase: "export", message: "Database file ready", completed: 1, total: 1 });
          finished = true;
          return {
            filename: target.filename,
            savedToDisk: false,
            file,
            release: releaseStorageLease,
          };
        }

        onProgress({ phase: "export", message: "Exporting database file", completed: 0, total: 1 });
        if (estimatedBytes > bufferedExportByteLimit) {
          throw new Error(
            "This database is too large for this browser's buffered download. Use a current desktop browser with disk-backed OPFS or direct file saving.",
          );
        }
        let bytes: Uint8Array;
        if (pool) {
          closeDb();
          bytes = await pool.exportFile(internalFilename);
        } else {
          const fallback = sqlite3 as unknown as { capi?: { sqlite3_js_db_export?: (pointer: unknown) => Uint8Array } };
          const pointer = (db as unknown as { pointer: unknown }).pointer;
          const exported = fallback.capi?.sqlite3_js_db_export?.(pointer);
          if (!exported) {
            throw new Error("This browser cannot export the in-memory SQLite database");
          }
          bytes = exported;
        }

        if (target.saveHandle) {
          await saveBytesToFile(target.saveHandle, bytes, onProgress, options.signal);
          await cleanupStorage();
          finished = true;
          return { filename: target.filename, savedToDisk: true };
        }

        await cleanupStorage();
        onProgress({ phase: "export", message: "Database file exported", completed: 1, total: 1 });
        finished = true;
        return { filename: target.filename, savedToDisk: false, bytes };
      } catch (error) {
        finalizeStatements();
        if (transactionOpen) {
          db.exec("ROLLBACK");
          transactionOpen = false;
        }
        await cleanupStorage();
        throw error;
      }
    },
    abort: async () => {
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
      await cleanupStorage();
    },
  };
}

async function getOpfsFile(sqlite3: SqliteModule, filename: string): Promise<File> {
  if (!sqlite3.opfs) {
    throw new Error("OPFS output is not available in this browser.");
  }
  const [directory, filePart] = await sqlite3.opfs.getDirForFilename(filename, false);
  const sourceHandle = await directory.getFileHandle(filePart);
  return sourceHandle.getFile();
}

async function removeOpfsFile(sqlite3: SqliteModule, filename: string): Promise<void> {
  if (!sqlite3.opfs) {
    return;
  }
  const [directory, filePart] = await sqlite3.opfs.getDirForFilename(filename, false);
  await directory.removeEntry(filePart).catch((error: unknown) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  });
}

async function saveOpfsFile(
  sqlite3: SqliteModule,
  filename: string,
  saveHandle: FileSystemFileHandle,
  onProgress: (progress: DatabaseProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
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
      throwIfAborted(signal);
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

function verifyPersistedTimeline(db: SqliteDatabase, expected: TimelineIntegritySummary): void {
  const actual: TimelineIntegritySummary = {
    eventCount: numberSelect(db, "SELECT COUNT(*) FROM timeline_events"),
    duplicateStartCount: numberSelect(
      db,
      `
      SELECT COUNT(*)
      FROM (
        SELECT start_ts
        FROM timeline_events
        GROUP BY start_ts
        HAVING COUNT(*) > 1
      )
    `,
    ),
    overlapCount: numberSelect(
      db,
      `
      WITH ordered AS (
        SELECT
          start_ts,
          MAX(end_ts) OVER (
            ORDER BY start_ts
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS previous_max_end
        FROM timeline_events
      )
      SELECT COUNT(*)
      FROM ordered
      WHERE previous_max_end IS NOT NULL
        AND start_ts < previous_max_end
    `,
    ),
    adjacentSameKindCount: numberSelect(
      db,
      `
      WITH ordered AS (
        SELECT kind, LAG(kind) OVER (ORDER BY start_ts) AS previous_kind
        FROM timeline_events
      )
      SELECT COUNT(*)
      FROM ordered
      WHERE kind <> 'move'
        AND kind = previous_kind
    `,
    ),
    openEventCount: numberSelect(db, "SELECT COUNT(*) FROM timeline_events WHERE end_ts IS NULL"),
    openEventNotLastCount: numberSelect(
      db,
      `
      SELECT COUNT(*)
      FROM timeline_events current
      WHERE current.end_ts IS NULL
        AND EXISTS (
          SELECT 1
          FROM timeline_events later
          WHERE later.start_ts > current.start_ts
        )
    `,
    ),
    nonPositiveDurationCount: numberSelect(
      db,
      "SELECT COUNT(*) FROM timeline_events WHERE end_ts IS NOT NULL AND end_ts <= start_ts",
    ),
  };
  const projectionMismatchCount = numberSelect(
    db,
    `
    SELECT
      ABS((SELECT COUNT(*) FROM timeline_events) - (
        (SELECT COUNT(*) FROM stays)
        + (SELECT COUNT(*) FROM moves)
        + (SELECT COUNT(*) FROM no_data_gaps)
      ))
  `,
  );
  if (projectionMismatchCount > 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `SQLite timeline verification failed: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)} projectionMismatchCount=${projectionMismatchCount}`,
    );
  }
}

function makeInsertStatements(db: SqliteDatabase): InsertStatements {
  const statements = new Map<keyof AuraRows, SqliteStatement>();
  for (const plan of insertPlans) {
    const placeholders = plan.columns.map(() => "?").join(", ");
    statements.set(
      plan.table,
      db.prepare(`INSERT INTO ${plan.table} (${plan.columns.join(", ")}) VALUES (${placeholders})`),
    );
  }
  return statements;
}

function insertRowsWithStatements(
  statements: InsertStatements,
  rows: AuraRows,
  onProgress: (progress: DatabaseProgress) => void,
  signal?: AbortSignal,
): void {
  const total = Object.values(rows).reduce((sum, tableRows) => sum + tableRows.length, 0);
  let completed = 0;
  const insertRow = <K extends keyof AuraRows>(plan: TablePlan<K>, row: AuraRows[K][number]): void => {
    throwIfAborted(signal);
    insertRowWithStatements(statements, plan, row);
    completed += 1;
    if (completed === total || completed % progressReportInterval === 0) {
      onProgress({ phase: "write", message: `Building ${plan.table}`, completed, total });
    }
  };

  insertTableRows(statements, tablePlan("pois"), rows.pois, insertRow);
  insertSemanticRows(rows, insertRow);

  for (const plan of insertPlans) {
    if (plan.table === "pois" || plan.table === "stays" || plan.table === "moves" || plan.table === "no_data_gaps") {
      continue;
    }
    insertTableRows(statements, tablePlan(plan.table), rows[plan.table] as AuraRows[typeof plan.table]);
  }
}

function insertTableRows<K extends keyof AuraRows>(
  statements: InsertStatements,
  plan: TablePlan<K>,
  tableRows: ReadonlyArray<AuraRows[K][number]>,
  insertRow?: (plan: TablePlan<K>, row: AuraRows[K][number]) => void,
): void {
  for (const row of tableRows) {
    if (insertRow) {
      insertRow(plan, row);
    } else {
      insertRowWithStatements(statements, plan, row);
    }
  }
}

function insertRowWithStatements<K extends keyof AuraRows>(
  statements: InsertStatements,
  plan: TablePlan<K>,
  row: AuraRows[K][number],
): void {
  const statement = statements.get(plan.table);
  if (!statement) {
    throw new Error(`No statement for ${plan.table}`);
  }
  statement.bind(plan.columns.map((column) => row[column] ?? null)).stepReset();
}

type SemanticInsertRow =
  | { table: "stays"; start: number; row: AuraRows["stays"][number] }
  | { table: "moves"; start: number; row: AuraRows["moves"][number] }
  | { table: "no_data_gaps"; start: number; row: AuraRows["no_data_gaps"][number] };

function insertSemanticRows(
  rows: AuraRows,
  insertRow: <K extends "stays" | "moves" | "no_data_gaps">(plan: TablePlan<K>, row: AuraRows[K][number]) => void,
): void {
  const semanticRows: SemanticInsertRow[] = [];
  for (const row of rows.stays) {
    semanticRows.push({ table: "stays", start: row.start_ts, row });
  }
  for (const row of rows.moves) {
    semanticRows.push({ table: "moves", start: row.start_ts, row });
  }
  for (const row of rows.no_data_gaps) {
    semanticRows.push({ table: "no_data_gaps", start: row.start_ts, row });
  }
  semanticRows.sort((lhs, rhs) => {
    if (lhs.start !== rhs.start) {
      return lhs.start - rhs.start;
    }
    const order = { stays: 0, moves: 1, no_data_gaps: 2 };
    return order[lhs.table] - order[rhs.table];
  });

  for (const entry of semanticRows) {
    if (entry.table === "stays") {
      insertRow(tablePlan("stays"), entry.row);
    } else if (entry.table === "moves") {
      insertRow(tablePlan("moves"), entry.row);
    } else {
      insertRow(tablePlan("no_data_gaps"), entry.row);
    }
  }
}

function tablePlan<K extends keyof AuraRows>(table: K): TablePlan<K> {
  const plan = insertPlans.find((item) => item.table === table) as TablePlan<K> | undefined;
  if (!plan) {
    throw new Error(`No insert plan for ${table}`);
  }
  return plan;
}

async function saveBytesToFile(
  saveHandle: FileSystemFileHandle,
  bytes: Uint8Array,
  onProgress: (progress: DatabaseProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = Math.max(1, Math.ceil(bytes.byteLength / exportProgressChunkBytes));
  onProgress({ phase: "export", message: "Saving database file", completed: 0, total });

  let writable: FileSystemWritableFileStream | null = null;
  let writableClosed = false;
  try {
    writable = await saveHandle.createWritable();
    let completedUnits = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += exportProgressChunkBytes) {
      throwIfAborted(signal);
      await writable.write(
        new Uint8Array(bytes.subarray(offset, Math.min(bytes.byteLength, offset + exportProgressChunkBytes))),
      );
      completedUnits += 1;
      onProgress({ phase: "export", message: "Saving database file", completed: completedUnits, total });
    }
    await writable.close();
    writableClosed = true;
    onProgress({ phase: "export", message: "Database file saved", completed: total, total });
  } catch (error) {
    if (writable && !writableClosed) {
      await writable.abort(error).catch(() => undefined);
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was cancelled", "AbortError");
  }
}

function insertSchemaRecord(db: SqliteDatabase): void {
  const statement = db.prepare(
    "INSERT INTO migrations (applied_at_ts, from_version, to_version, notes) VALUES (?, ?, ?, ?)",
  );
  try {
    statement.bind([Date.now() / 1000, 0, pathSchema.version, `Aura Importer ${pathSchema.name}`]).stepReset();
  } finally {
    statement.finalize();
  }
}
