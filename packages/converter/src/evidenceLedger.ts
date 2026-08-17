import sqlite3InitModule, {
  type CAPI,
  type Database,
  type PreparedStatement,
  type SAHPoolUtil,
  type WasmPointer,
} from "@sqlite.org/sqlite-wasm";
import { maximumObservationGapS, maximumUnlinkedObservationWindowS, streamingRowBatchSize } from "./constants.js";
import { acquireStorageLease, cleanupStaleDirectories } from "./opfsStorage.js";

export type ObservationEvidence = {
  identity: string;
  sampleId: string | null;
  timelineItemId: string | null;
  ts: number;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  horizontalAccuracy: number | null;
  verticalAccuracy: number | null;
  speed: number | null;
  speedAccuracy: number | null;
  course: number | null;
  courseAccuracy: number | null;
  timezoneOffset: number | null;
  locationQuality: number;
  locationTie: string;
  activity: string | null;
  activityRank: number;
  movingState: string | null;
  movingStateRank: number;
  revision: number;
};

type ObservationRow = Record<string, string | number | bigint | Uint8Array | ArrayBuffer | null>;

let sqliteModulePromise: ReturnType<typeof sqlite3InitModule> | null = null;

export class EvidenceLedger {
  private sealed = false;
  private closed = false;
  private fileSavepointOpen = false;

  private constructor(
    private readonly db: Database,
    private readonly insert: PreparedStatement,
    private readonly insertTombstone: PreparedStatement,
    private readonly insertMovesDay: PreparedStatement,
    private readonly pool: SAHPoolUtil | null,
    private readonly filename: string | null,
    private readonly releaseStorageLease: () => Promise<void>,
    private readonly capi: CAPI,
  ) {}

  static async create(): Promise<EvidenceLedger> {
    sqliteModulePromise ??= sqlite3InitModule();
    const sqlite3 = await sqliteModulePromise;
    await cleanupStaleDirectories("aura-importer-evidence-", "aura-importer-temp:evidence/");
    let pool: SAHPoolUtil | null = null;
    let filename: string | null = null;
    let db: Database;
    let releaseStorageLease = async (): Promise<void> => undefined;

    if (typeof navigator !== "undefined" && navigator.storage && sqlite3.installOpfsSAHPoolVfs) {
      const poolId = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
      const directoryName = `aura-importer-evidence-${poolId}`;
      releaseStorageLease = await acquireStorageLease(`aura-importer-temp:evidence/${directoryName}`);
      try {
        pool = await sqlite3.installOpfsSAHPoolVfs({
          name: directoryName,
          directory: `/${directoryName}`,
          initialCapacity: 12,
          clearOnInit: true,
        });
        filename = "/evidence.db";
        db = new pool.OpfsSAHPoolDb(filename);
      } catch (error) {
        try {
          if (pool) {
            if (filename) {
              pool.unlink(filename);
            }
            await pool.removeVfs();
          }
        } finally {
          await releaseStorageLease();
        }
        throw new Error("Unable to create the local evidence database", { cause: error });
      }
    } else {
      db = new sqlite3.oo1.DB(":memory:", "c");
    }

    try {
      db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      CREATE TABLE observations (
        identity TEXT PRIMARY KEY,
        sample_id TEXT,
        timeline_item_id TEXT,
        ts REAL NOT NULL,
        lat REAL,
        lon REAL,
        altitude REAL,
        horizontal_accuracy REAL,
        vertical_accuracy REAL,
        speed REAL,
        speed_accuracy REAL,
        course REAL,
        course_accuracy REAL,
        timezone_offset INTEGER,
        location_quality REAL NOT NULL,
        location_tie TEXT NOT NULL,
        activity TEXT,
        activity_rank INTEGER NOT NULL,
        moving_state TEXT,
        moving_state_rank INTEGER NOT NULL,
        revision REAL NOT NULL,
        link_revision REAL NOT NULL,
        location_revision REAL NOT NULL,
        activity_revision REAL NOT NULL,
        moving_state_revision REAL NOT NULL
      );
      CREATE TABLE observation_tombstones (
        sample_id TEXT PRIMARY KEY,
        revision REAL NOT NULL
      );
      CREATE TABLE moves_day_candidates (
        date TEXT NOT NULL,
        source_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        PRIMARY KEY(date, fingerprint, candidate_json)
      );
      CREATE TABLE fused_moves_days (
        date TEXT PRIMARY KEY,
        day_json TEXT NOT NULL
      );
      CREATE INDEX idx_observations_item_ts ON observations(timeline_item_id, ts);
      CREATE INDEX idx_observations_ts ON observations(ts);
      BEGIN;
    `);

      const insert = db.prepare(`
      INSERT INTO observations (
        identity, sample_id, timeline_item_id, ts,
        lat, lon, altitude, horizontal_accuracy, vertical_accuracy,
        speed, speed_accuracy, course, course_accuracy, timezone_offset,
        location_quality, location_tie, activity, activity_rank,
        moving_state, moving_state_rank, revision,
        link_revision, location_revision, activity_revision, moving_state_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity) DO UPDATE SET
        sample_id = COALESCE(observations.sample_id, excluded.sample_id),
        timeline_item_id = CASE
          WHEN observations.timeline_item_id IS NULL THEN excluded.timeline_item_id
          WHEN excluded.timeline_item_id IS NULL THEN observations.timeline_item_id
          WHEN excluded.revision > observations.link_revision THEN excluded.timeline_item_id
          WHEN excluded.revision < observations.link_revision THEN observations.timeline_item_id
          ELSE MIN(observations.timeline_item_id, excluded.timeline_item_id)
        END,
        link_revision = CASE
          WHEN excluded.timeline_item_id IS NULL THEN observations.link_revision
          WHEN observations.timeline_item_id IS NULL OR excluded.revision >= observations.link_revision THEN excluded.revision
          ELSE observations.link_revision
        END,
        ts = CASE WHEN ${preferredLocationSQL} THEN excluded.ts ELSE observations.ts END,
        lat = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.lat, observations.lat) ELSE COALESCE(observations.lat, excluded.lat) END,
        lon = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.lon, observations.lon) ELSE COALESCE(observations.lon, excluded.lon) END,
        altitude = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.altitude, observations.altitude) ELSE COALESCE(observations.altitude, excluded.altitude) END,
        horizontal_accuracy = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.horizontal_accuracy, observations.horizontal_accuracy) ELSE COALESCE(observations.horizontal_accuracy, excluded.horizontal_accuracy) END,
        vertical_accuracy = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.vertical_accuracy, observations.vertical_accuracy) ELSE COALESCE(observations.vertical_accuracy, excluded.vertical_accuracy) END,
        speed = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.speed, observations.speed) ELSE COALESCE(observations.speed, excluded.speed) END,
        speed_accuracy = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.speed_accuracy, observations.speed_accuracy) ELSE COALESCE(observations.speed_accuracy, excluded.speed_accuracy) END,
        course = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.course, observations.course) ELSE COALESCE(observations.course, excluded.course) END,
        course_accuracy = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.course_accuracy, observations.course_accuracy) ELSE COALESCE(observations.course_accuracy, excluded.course_accuracy) END,
        timezone_offset = CASE WHEN ${preferredLocationSQL} THEN COALESCE(excluded.timezone_offset, observations.timezone_offset) ELSE COALESCE(observations.timezone_offset, excluded.timezone_offset) END,
        location_quality = MAX(observations.location_quality, excluded.location_quality),
        location_tie = CASE WHEN ${preferredLocationSQL} THEN excluded.location_tie ELSE observations.location_tie END,
        activity = CASE WHEN ${preferredActivitySQL} THEN COALESCE(excluded.activity, observations.activity) ELSE COALESCE(observations.activity, excluded.activity) END,
        activity_rank = MAX(observations.activity_rank, excluded.activity_rank),
        moving_state = CASE
          WHEN excluded.moving_state_rank > observations.moving_state_rank
            OR (
              excluded.moving_state_rank = observations.moving_state_rank
              AND (
                excluded.revision > observations.moving_state_revision
                OR (
                  excluded.revision = observations.moving_state_revision
                  AND COALESCE(excluded.moving_state, '') > COALESCE(observations.moving_state, '')
                )
              )
            )
          THEN COALESCE(excluded.moving_state, observations.moving_state)
          ELSE COALESCE(observations.moving_state, excluded.moving_state)
        END,
        moving_state_rank = MAX(observations.moving_state_rank, excluded.moving_state_rank),
        location_revision = CASE WHEN ${preferredLocationSQL} THEN excluded.revision ELSE observations.location_revision END,
        activity_revision = CASE WHEN ${preferredActivitySQL} THEN excluded.revision ELSE observations.activity_revision END,
        moving_state_revision = CASE
          WHEN excluded.moving_state IS NOT NULL AND (
            excluded.moving_state_rank > observations.moving_state_rank
            OR excluded.moving_state_rank = observations.moving_state_rank AND excluded.revision >= observations.moving_state_revision
          ) THEN excluded.revision
          ELSE observations.moving_state_revision
        END,
        revision = MAX(observations.revision, excluded.revision)
    `);
      const insertTombstone = db.prepare(`
      INSERT INTO observation_tombstones (sample_id, revision)
      VALUES (?, ?)
      ON CONFLICT(sample_id) DO UPDATE SET
        revision = MAX(observation_tombstones.revision, excluded.revision)
    `);
      const insertMovesDay = db.prepare(`
      INSERT INTO moves_day_candidates (date, source_path, fingerprint, candidate_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date, fingerprint, candidate_json) DO UPDATE SET
        source_path = MIN(moves_day_candidates.source_path, excluded.source_path)
    `);

      return new EvidenceLedger(
        db,
        insert,
        insertTombstone,
        insertMovesDay,
        pool,
        filename,
        releaseStorageLease,
        sqlite3.capi,
      );
    } catch (error) {
      try {
        db.close();
        if (pool && filename) {
          pool.unlink(filename);
          await pool.removeVfs();
        }
      } finally {
        await releaseStorageLease();
      }
      throw error;
    }
  }

  addObservation(evidence: ObservationEvidence): void {
    if (this.sealed || this.closed) {
      throw new Error("Evidence ledger is no longer writable");
    }
    this.insert
      .bind([
        evidence.identity,
        evidence.sampleId,
        evidence.timelineItemId,
        evidence.ts,
        evidence.lat,
        evidence.lon,
        evidence.altitude,
        evidence.horizontalAccuracy,
        evidence.verticalAccuracy,
        evidence.speed,
        evidence.speedAccuracy,
        evidence.course,
        evidence.courseAccuracy,
        evidence.timezoneOffset,
        evidence.locationQuality,
        evidence.locationTie,
        evidence.activity,
        evidence.activityRank,
        evidence.movingState,
        evidence.movingStateRank,
        evidence.revision,
        evidence.revision,
        evidence.revision,
        evidence.revision,
        evidence.revision,
      ])
      .stepReset();
  }

  addTombstone(sampleId: string, revision: number): void {
    if (this.sealed || this.closed) {
      throw new Error("Evidence ledger is no longer writable");
    }
    this.insertTombstone.bind([sampleId, revision]).stepReset();
  }

  addMovesDayCandidate(date: string, sourcePath: string, fingerprint: string, candidateJson: string): void {
    if (this.sealed || this.closed) {
      throw new Error("Evidence ledger is no longer writable");
    }
    this.insertMovesDay.bind([date, sourcePath, fingerprint, candidateJson]).stepReset();
  }

  movesDayDates(): string[] {
    const dates: string[] = [];
    this.db.exec({
      sql: "SELECT DISTINCT date FROM moves_day_candidates ORDER BY date",
      rowMode: "object",
      callback: (row) => {
        const date = stringOrNull((row as ObservationRow).date);
        if (date) {
          dates.push(date);
        }
      },
    });
    return dates;
  }

  movesDayCandidates(date: string): Array<{
    path: string;
    fingerprint: string;
    day: Record<string, unknown>;
  }> {
    const candidates: Array<{ path: string; fingerprint: string; day: Record<string, unknown> }> = [];
    this.db.exec({
      sql: `
        SELECT source_path, fingerprint, candidate_json
        FROM moves_day_candidates
        WHERE date = ?
        ORDER BY candidate_json, source_path
      `,
      bind: [date],
      rowMode: "object",
      callback: (row) => {
        const typedRow = row as ObservationRow;
        const path = stringOrNull(typedRow.source_path);
        const fingerprint = stringOrNull(typedRow.fingerprint);
        const candidateJson = stringOrNull(typedRow.candidate_json);
        if (!path || !fingerprint || !candidateJson) {
          throw new Error(`Invalid stored Moves candidate for ${date}`);
        }
        const day = JSON.parse(candidateJson) as unknown;
        if (!day || typeof day !== "object" || Array.isArray(day)) {
          throw new Error(`Invalid stored Moves day for ${date}`);
        }
        candidates.push({ path, fingerprint, day: day as Record<string, unknown> });
      },
    });
    return candidates;
  }

  storeFusedMovesDay(date: string, day: Record<string, unknown>): void {
    if (this.sealed || this.closed) {
      throw new Error("Evidence ledger is no longer writable");
    }
    this.db.exec({
      sql: `
        INSERT INTO fused_moves_days (date, day_json)
        VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET day_json = excluded.day_json
      `,
      bind: [date, JSON.stringify(day)],
    });
    this.db.exec({ sql: "DELETE FROM moves_day_candidates WHERE date = ?", bind: [date] });
  }

  forEachFusedMovesDay(callback: (day: Record<string, unknown>) => void): void {
    this.seal();
    this.db.exec({
      sql: "SELECT day_json FROM fused_moves_days ORDER BY date",
      rowMode: "object",
      callback: (row) => {
        const dayJson = stringOrNull((row as ObservationRow).day_json);
        if (!dayJson) {
          throw new Error("Invalid stored fused Moves day");
        }
        const day = JSON.parse(dayJson) as unknown;
        if (!day || typeof day !== "object" || Array.isArray(day)) {
          throw new Error("Invalid stored fused Moves day");
        }
        callback(day as Record<string, unknown>);
      },
    });
  }

  beginFile(): void {
    if (this.sealed || this.closed || this.fileSavepointOpen) {
      throw new Error("Evidence ledger cannot begin a file transaction");
    }
    this.db.exec("SAVEPOINT history_file");
    this.fileSavepointOpen = true;
  }

  commitFile(): void {
    if (!this.fileSavepointOpen) {
      throw new Error("Evidence ledger has no file transaction to commit");
    }
    this.db.exec("RELEASE SAVEPOINT history_file");
    this.fileSavepointOpen = false;
  }

  rollbackFile(): void {
    if (!this.fileSavepointOpen) {
      return;
    }
    try {
      this.db.exec("ROLLBACK TO SAVEPOINT history_file");
      this.db.exec("RELEASE SAVEPOINT history_file");
    } catch {
      void 0;
    } finally {
      this.fileSavepointOpen = false;
    }
  }

  seal(): void {
    if (this.sealed) {
      return;
    }
    if (this.fileSavepointOpen) {
      throw new Error("Evidence ledger cannot seal an open file transaction");
    }
    this.insert.finalize();
    this.insertTombstone.finalize();
    this.insertMovesDay.finalize();
    this.db.exec(`
      DELETE FROM observations
      WHERE sample_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM observation_tombstones tombstone
          WHERE tombstone.sample_id = observations.sample_id
            AND tombstone.revision >= observations.revision
        );
      UPDATE observations AS identified
      SET timeline_item_id = COALESCE(
            identified.timeline_item_id,
            (SELECT anonymous.timeline_item_id
             FROM observations AS anonymous
             WHERE anonymous.sample_id IS NULL
               AND anonymous.ts = identified.ts
               AND anonymous.lat IS identified.lat
               AND anonymous.lon IS identified.lon
               AND anonymous.timeline_item_id IS NOT NULL
             ORDER BY anonymous.link_revision DESC, anonymous.identity
             LIMIT 1)
          ),
          activity = CASE
            WHEN identified.activity IS NULL OR COALESCE((SELECT MAX(anonymous.activity_rank)
                                                          FROM observations AS anonymous
                                                          WHERE anonymous.sample_id IS NULL
                                                            AND anonymous.ts = identified.ts
                                                            AND anonymous.lat IS identified.lat
                                                            AND anonymous.lon IS identified.lon), 0) > identified.activity_rank
              THEN (SELECT anonymous.activity
                    FROM observations AS anonymous
                    WHERE anonymous.sample_id IS NULL
                      AND anonymous.ts = identified.ts
                      AND anonymous.lat IS identified.lat
                      AND anonymous.lon IS identified.lon
                      AND anonymous.activity IS NOT NULL
                    ORDER BY anonymous.activity_rank DESC, anonymous.activity_revision DESC, anonymous.identity
                    LIMIT 1)
            ELSE identified.activity
          END,
          activity_rank = MAX(
            identified.activity_rank,
            COALESCE((SELECT MAX(anonymous.activity_rank)
                      FROM observations AS anonymous
                      WHERE anonymous.sample_id IS NULL
                        AND anonymous.ts = identified.ts
                        AND anonymous.lat IS identified.lat
                        AND anonymous.lon IS identified.lon), 0)
          ),
          moving_state = CASE
            WHEN identified.moving_state IS NULL OR COALESCE((SELECT MAX(anonymous.moving_state_rank)
                                                              FROM observations AS anonymous
                                                              WHERE anonymous.sample_id IS NULL
                                                                AND anonymous.ts = identified.ts
                                                                AND anonymous.lat IS identified.lat
                                                                AND anonymous.lon IS identified.lon), 0) > identified.moving_state_rank
              THEN (SELECT anonymous.moving_state
                    FROM observations AS anonymous
                    WHERE anonymous.sample_id IS NULL
                      AND anonymous.ts = identified.ts
                      AND anonymous.lat IS identified.lat
                      AND anonymous.lon IS identified.lon
                      AND anonymous.moving_state IS NOT NULL
                    ORDER BY anonymous.moving_state_rank DESC, anonymous.moving_state_revision DESC, anonymous.identity
                    LIMIT 1)
            ELSE identified.moving_state
          END,
          moving_state_rank = MAX(
            identified.moving_state_rank,
            COALESCE((SELECT MAX(anonymous.moving_state_rank)
                      FROM observations AS anonymous
                      WHERE anonymous.sample_id IS NULL
                        AND anonymous.ts = identified.ts
                        AND anonymous.lat IS identified.lat
                        AND anonymous.lon IS identified.lon), 0)
          )
      WHERE identified.sample_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM observations AS anonymous
          WHERE anonymous.sample_id IS NULL
            AND anonymous.ts = identified.ts
            AND anonymous.lat IS identified.lat
            AND anonymous.lon IS identified.lon
        );
      DELETE FROM observations AS anonymous
      WHERE anonymous.sample_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM observations AS identified
          WHERE identified.sample_id IS NOT NULL
            AND identified.ts = anonymous.ts
            AND identified.lat IS anonymous.lat
            AND identified.lon IS anonymous.lon
        );
      COMMIT;
    `);
    this.sealed = true;
  }

  observationsForTimelineItem(timelineItemId: string): Record<string, unknown>[] {
    this.seal();
    const samples: Record<string, unknown>[] = [];
    const statement = this.db.prepare(`${selectObservationsSQL} WHERE timeline_item_id = ? ORDER BY ts, identity`);
    try {
      statement.bind([timelineItemId]);
      stepRows(statement, this.capi, observationRowFrom, (row) => {
        samples.push(observationRowToSample(row));
      });
    } finally {
      statement.finalize();
    }
    return samples;
  }

  observationsBetween(start: number, end: number): Record<string, unknown>[] {
    this.seal();
    const samples: Record<string, unknown>[] = [];
    const statement = this.db.prepare(`${selectObservationsSQL} WHERE ts >= ? AND ts < ? ORDER BY ts, identity`);
    try {
      statement.bind([start, end]);
      stepRows(statement, this.capi, observationRowFrom, (row) => {
        samples.push(observationRowToSample(row));
      });
    } finally {
      statement.finalize();
    }
    return samples;
  }

  unlinkedObservationsBetween(
    start: number,
    end: number,
    knownTimelineItemIds: ReadonlySet<string> = new Set(),
  ): Record<string, unknown>[] {
    this.seal();
    const samples: Record<string, unknown>[] = [];
    const statement = this.db.prepare(`${selectObservationsSQL} WHERE ts >= ? AND ts < ? ORDER BY ts, identity`);
    try {
      statement.bind([start, end]);
      stepRows(statement, this.capi, observationRowFrom, (row) => {
        const timelineItemId = stringOrNull(row.timeline_item_id);
        if (
          timelineItemId === null ||
          (!timelineItemId.startsWith("moves:") && !knownTimelineItemIds.has(timelineItemId))
        ) {
          samples.push(observationRowToSample(row));
        }
      });
    } finally {
      statement.finalize();
    }
    return samples;
  }

  unlinkedObservationWindows(
    knownTimelineItemIds: ReadonlySet<string> = new Set(),
    maxGap = maximumObservationGapS,
    maxDuration = maximumUnlinkedObservationWindowS,
  ): Array<{ start: number; end: number }> {
    this.seal();
    const windows: Array<{ start: number; end: number }> = [];
    let start: number | null = null;
    let previous: number | null = null;
    let positiveDeltaTotal = 0;
    let positiveDeltaCount = 0;
    let sampleCount = 0;
    const flush = (): void => {
      if (start !== null && previous !== null && sampleCount >= 2) {
        const extension = Math.max(
          1,
          Math.min(60, positiveDeltaCount > 0 ? positiveDeltaTotal / positiveDeltaCount : 60),
        );
        windows.push({ start, end: previous + extension });
      }
      start = null;
      previous = null;
      positiveDeltaTotal = 0;
      positiveDeltaCount = 0;
      sampleCount = 0;
    };

    const statement = this.db.prepare("SELECT ts, timeline_item_id FROM observations ORDER BY ts, identity");
    try {
      stepRows(
        statement,
        this.capi,
        (capi, pointer) => ({
          ts: numberFrom(capi.sqlite3_column_double(pointer, 0)),
          timelineItemId: stringOrNull(capi.sqlite3_column_text(pointer, 1)),
        }),
        (row) => {
          if (
            row.timelineItemId !== null &&
            (row.timelineItemId.startsWith("moves:") || knownTimelineItemIds.has(row.timelineItemId))
          ) {
            return;
          }
          if (start === null || previous === null || row.ts - previous > maxGap || row.ts - start >= maxDuration) {
            flush();
            start = row.ts;
          } else {
            const delta = row.ts - previous;
            if (delta > 0 && delta <= maxGap) {
              positiveDeltaTotal += delta;
              positiveDeltaCount += 1;
            }
          }
          previous = row.ts;
          sampleCount += 1;
        },
      );
    } finally {
      statement.finalize();
    }
    flush();
    return windows;
  }

  forEachTimelineItem(callback: (timelineItemId: string | null, samples: Record<string, unknown>[]) => void): void {
    this.seal();
    let currentItem: string | null | undefined;
    let samples: Record<string, unknown>[] = [];
    const flush = (): void => {
      if (currentItem !== undefined && samples.length > 0) {
        callback(currentItem, samples);
      }
      samples = [];
    };

    const statement = this.db.prepare(`${selectObservationsSQL} ORDER BY COALESCE(timeline_item_id, ''), ts, identity`);
    try {
      stepRows(statement, this.capi, observationRowFrom, (row) => {
        const timelineItemId = stringOrNull(row.timeline_item_id);
        if (currentItem !== undefined && timelineItemId !== currentItem) {
          flush();
        }
        currentItem = timelineItemId;
        samples.push(observationRowToSample(row));
        if (timelineItemId === null && samples.length >= streamingRowBatchSize) {
          flush();
        }
      });
    } finally {
      statement.finalize();
    }
    flush();
  }

  forEachCanonicalObservation(callback: (samples: Record<string, unknown>[]) => void): void {
    this.seal();
    let currentTs: number | null = null;
    let currentLat: number | null = null;
    let currentLon: number | null = null;
    let group: ObservationRow[] = [];
    let samples: Record<string, unknown>[] = [];
    const emit = (sample: Record<string, unknown>): void => {
      samples.push(sample);
      if (samples.length >= streamingRowBatchSize) {
        callback(samples);
        samples = [];
      }
    };
    const flushGroup = (): void => {
      if (group.length === 0) {
        return;
      }
      if (currentLat === null || currentLon === null) {
        for (const row of group) {
          emit(observationRowToSample(row));
        }
      } else {
        emit(canonicalObservationToSample(group));
      }
      group = [];
    };

    const statement = this.db.prepare(`${selectCanonicalObservationsSQL}
        ORDER BY ts, lat IS NULL OR lon IS NULL, lat, lon, identity`);
    try {
      stepRows(statement, this.capi, canonicalRowFrom, (row) => {
        const ts = numberFrom(row.ts);
        const lat = numberOrNull(row.lat);
        const lon = numberOrNull(row.lon);
        const sharesLocation =
          group.length > 0 &&
          lat !== null &&
          lon !== null &&
          currentLat === lat &&
          currentLon === lon &&
          currentTs === ts;
        if (group.length > 0 && !sharesLocation) {
          flushGroup();
        }
        if (group.length === 0) {
          currentTs = ts;
          currentLat = lat;
          currentLon = lon;
        }
        group.push(row);
      });
    } finally {
      statement.finalize();
    }
    flushGroup();
    if (samples.length > 0) {
      callback(samples);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      if (!this.sealed) {
        this.insert.finalize();
        this.insertTombstone.finalize();
        this.insertMovesDay.finalize();
        try {
          this.db.exec("ROLLBACK");
        } catch {
          void 0;
        }
      }
      this.db.close();
      if (this.pool && this.filename) {
        this.pool.unlink(this.filename);
        await this.pool.removeVfs();
      }
    } finally {
      await this.releaseStorageLease();
      this.closed = true;
    }
  }
}

const preferredLocationSQL = `(
  excluded.location_quality > observations.location_quality
  OR (
      excluded.location_quality = observations.location_quality
      AND (
      excluded.revision > observations.location_revision
      OR (
        excluded.revision = observations.location_revision
        AND excluded.location_tie > observations.location_tie
      )
    )
  )
)`;

const preferredActivitySQL = `(
  excluded.activity_rank > observations.activity_rank
  OR (
      excluded.activity_rank = observations.activity_rank
      AND (
      excluded.revision > observations.activity_revision
      OR (
        excluded.revision = observations.activity_revision
        AND COALESCE(excluded.activity, '') > COALESCE(observations.activity, '')
      )
    )
  )
)`;

const selectObservationsSQL = `
  SELECT
    sample_id, timeline_item_id, ts, lat, lon, altitude,
    horizontal_accuracy, vertical_accuracy, speed, speed_accuracy,
    course, course_accuracy, timezone_offset, activity, activity_rank,
    moving_state
  FROM observations
`;

const selectCanonicalObservationsSQL = `
  SELECT
    identity, sample_id, timeline_item_id, ts, lat, lon, altitude,
    horizontal_accuracy, vertical_accuracy, speed, speed_accuracy,
    course, course_accuracy, timezone_offset,
    location_quality, location_tie, location_revision,
    activity, activity_rank, activity_revision,
    moving_state, moving_state_rank, moving_state_revision,
    link_revision
  FROM observations
`;

function stepRows<T>(
  statement: PreparedStatement,
  capi: CAPI,
  readRow: (capi: CAPI, pointer: WasmPointer) => T,
  onRow: (row: T) => void,
): void {
  const pointer = statementPointer(statement);
  while (capi.sqlite3_step(pointer) === capi.SQLITE_ROW) {
    onRow(readRow(capi, pointer));
  }
}

function statementPointer(statement: PreparedStatement): WasmPointer {
  const pointer = statement.pointer;
  if (!pointer) {
    throw new Error("Prepared statement has no pointer");
  }
  return pointer;
}

function observationRowFrom(capi: CAPI, pointer: WasmPointer): ObservationRow {
  return {
    sample_id: stringOrNull(capi.sqlite3_column_text(pointer, 0)),
    timeline_item_id: stringOrNull(capi.sqlite3_column_text(pointer, 1)),
    ts: numberFrom(capi.sqlite3_column_double(pointer, 2)),
    lat: nullableColumnNumber(capi, pointer, 3),
    lon: nullableColumnNumber(capi, pointer, 4),
    altitude: nullableColumnNumber(capi, pointer, 5),
    horizontal_accuracy: nullableColumnNumber(capi, pointer, 6),
    vertical_accuracy: nullableColumnNumber(capi, pointer, 7),
    speed: nullableColumnNumber(capi, pointer, 8),
    speed_accuracy: nullableColumnNumber(capi, pointer, 9),
    course: nullableColumnNumber(capi, pointer, 10),
    course_accuracy: nullableColumnNumber(capi, pointer, 11),
    timezone_offset: nullableColumnInteger(capi, pointer, 12),
    activity: stringOrNull(capi.sqlite3_column_text(pointer, 13)),
    activity_rank: numberFrom(capi.sqlite3_column_int(pointer, 14)),
    moving_state: stringOrNull(capi.sqlite3_column_text(pointer, 15)),
  };
}

function canonicalRowFrom(capi: CAPI, pointer: WasmPointer): ObservationRow {
  return {
    identity: stringOrNull(capi.sqlite3_column_text(pointer, 0)),
    sample_id: stringOrNull(capi.sqlite3_column_text(pointer, 1)),
    timeline_item_id: stringOrNull(capi.sqlite3_column_text(pointer, 2)),
    ts: numberFrom(capi.sqlite3_column_double(pointer, 3)),
    lat: nullableColumnNumber(capi, pointer, 4),
    lon: nullableColumnNumber(capi, pointer, 5),
    altitude: nullableColumnNumber(capi, pointer, 6),
    horizontal_accuracy: nullableColumnNumber(capi, pointer, 7),
    vertical_accuracy: nullableColumnNumber(capi, pointer, 8),
    speed: nullableColumnNumber(capi, pointer, 9),
    speed_accuracy: nullableColumnNumber(capi, pointer, 10),
    course: nullableColumnNumber(capi, pointer, 11),
    course_accuracy: nullableColumnNumber(capi, pointer, 12),
    timezone_offset: nullableColumnInteger(capi, pointer, 13),
    location_quality: numberFrom(capi.sqlite3_column_double(pointer, 14)),
    location_tie: stringOrNull(capi.sqlite3_column_text(pointer, 15)),
    location_revision: numberFrom(capi.sqlite3_column_double(pointer, 16)),
    activity: stringOrNull(capi.sqlite3_column_text(pointer, 17)),
    activity_rank: numberFrom(capi.sqlite3_column_int(pointer, 18)),
    activity_revision: numberFrom(capi.sqlite3_column_double(pointer, 19)),
    moving_state: stringOrNull(capi.sqlite3_column_text(pointer, 20)),
    moving_state_rank: numberFrom(capi.sqlite3_column_int(pointer, 21)),
    moving_state_revision: numberFrom(capi.sqlite3_column_double(pointer, 22)),
    link_revision: numberFrom(capi.sqlite3_column_double(pointer, 23)),
  };
}

function nullableColumnNumber(capi: CAPI, pointer: WasmPointer, index: number): number | null {
  return capi.sqlite3_column_type(pointer, index) === capi.SQLITE_NULL
    ? null
    : capi.sqlite3_column_double(pointer, index);
}

function nullableColumnInteger(capi: CAPI, pointer: WasmPointer, index: number): number | null {
  return capi.sqlite3_column_type(pointer, index) === capi.SQLITE_NULL ? null : capi.sqlite3_column_int(pointer, index);
}

function canonicalObservationToSample(rows: ObservationRow[]): Record<string, unknown> {
  const byLocation = [...rows].sort(
    (lhs, rhs) =>
      compareNumberDescending(lhs.location_quality, rhs.location_quality) ||
      compareNumberDescending(lhs.location_revision, rhs.location_revision) ||
      compareStringDescending(lhs.location_tie, rhs.location_tie) ||
      compareStringAscending(lhs.identity, rhs.identity),
  );
  const byActivity = [...rows].sort(
    (lhs, rhs) =>
      compareNumberDescending(lhs.activity_rank, rhs.activity_rank) ||
      compareNumberDescending(lhs.activity_revision, rhs.activity_revision) ||
      compareStringDescending(lhs.activity, rhs.activity) ||
      compareStringAscending(lhs.identity, rhs.identity),
  );
  const byMovingState = [...rows].sort(
    (lhs, rhs) =>
      compareNumberDescending(lhs.moving_state_rank, rhs.moving_state_rank) ||
      compareNumberDescending(lhs.moving_state_revision, rhs.moving_state_revision) ||
      compareStringDescending(lhs.moving_state, rhs.moving_state) ||
      compareStringAscending(lhs.identity, rhs.identity),
  );
  const byLink = [...rows].sort(
    (lhs, rhs) =>
      compareNumberDescending(lhs.link_revision, rhs.link_revision) ||
      compareStringAscending(lhs.timeline_item_id, rhs.timeline_item_id) ||
      compareStringAscending(lhs.identity, rhs.identity),
  );
  const row: ObservationRow = { ...byLocation[0] };
  for (const field of [
    "altitude",
    "horizontal_accuracy",
    "vertical_accuracy",
    "speed",
    "speed_accuracy",
    "course",
    "course_accuracy",
    "timezone_offset",
  ]) {
    row[field] = firstPresent(byLocation, field);
  }
  row.sample_id = firstPresent(
    [...rows].sort(
      (lhs, rhs) =>
        compareStringAscending(lhs.sample_id, rhs.sample_id) || compareStringAscending(lhs.identity, rhs.identity),
    ),
    "sample_id",
  );
  row.timeline_item_id = firstPresent(byLink, "timeline_item_id");
  row.activity = firstPresent(byActivity, "activity");
  row.activity_rank = byActivity[0]?.activity_rank ?? 0;
  row.moving_state = firstPresent(byMovingState, "moving_state");
  return observationRowToSample(row);
}

function firstPresent(rows: ObservationRow[], field: string): ObservationRow[string] {
  return rows.find((row) => row[field] !== null)?.[field] ?? null;
}

function compareNumberDescending(lhs: ObservationRow[string], rhs: ObservationRow[string]): number {
  return numberFrom(rhs) - numberFrom(lhs);
}

function compareStringAscending(lhs: ObservationRow[string], rhs: ObservationRow[string]): number {
  const left = stringOrNull(lhs) ?? "";
  const right = stringOrNull(rhs) ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStringDescending(lhs: ObservationRow[string], rhs: ObservationRow[string]): number {
  return compareStringAscending(rhs, lhs);
}

function observationRowToSample(row: ObservationRow): Record<string, unknown> {
  const ts = numberFrom(row.ts);
  const sample: Record<string, unknown> = {
    date: new Date(ts * 1000).toISOString(),
  };
  const lat = numberOrNull(row.lat);
  const lon = numberOrNull(row.lon);
  if (lat !== null && lon !== null) {
    const location: Record<string, unknown> = {
      timestamp: new Date(ts * 1000).toISOString(),
      latitude: lat,
      longitude: lon,
    };
    assignNumber(location, "altitude", row.altitude);
    assignNumber(location, "horizontalAccuracy", row.horizontal_accuracy);
    assignNumber(location, "verticalAccuracy", row.vertical_accuracy);
    assignNumber(location, "speed", row.speed);
    assignNumber(location, "speedAccuracy", row.speed_accuracy);
    assignNumber(location, "course", row.course);
    assignNumber(location, "courseAccuracy", row.course_accuracy);
    sample.location = location;
  }
  assignString(sample, "sampleId", row.sample_id);
  assignString(sample, "timelineItemId", row.timeline_item_id);
  assignNumber(sample, "secondsFromGMT", row.timezone_offset);
  const activity = stringOrNull(row.activity);
  const activityRank = numberFrom(row.activity_rank);
  if (activity) {
    if (activityRank >= 3) {
      sample.confirmedType = activity;
    } else if (activityRank >= 2) {
      sample.coreMotionActivityType = activity;
    }
  }
  assignString(sample, "movingState", row.moving_state);
  return sample;
}

function assignNumber(target: Record<string, unknown>, key: string, value: ObservationRow[string]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function assignString(target: Record<string, unknown>, key: string, value: ObservationRow[string]): void {
  const string = stringOrNull(value);
  if (string) {
    target[key] = string;
  }
}

function numberFrom(value: ObservationRow[string]): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Invalid numeric observation value: ${String(value)}`);
}

function numberOrNull(value: ObservationRow[string]): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: ObservationRow[string]): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
