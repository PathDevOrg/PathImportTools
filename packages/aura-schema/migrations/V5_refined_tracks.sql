CREATE TABLE IF NOT EXISTS refinement_jobs (
  id                INTEGER PRIMARY KEY,
  day_key           TEXT    NOT NULL,
  algorithm_version TEXT    NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('pending','running','paused','done','failed')),
  cursor_ts         REAL,
  started_ts        REAL,
  finished_ts       REAL,
  last_error        TEXT,
  created_ts        REAL NOT NULL DEFAULT (unixepoch()),
  updated_ts        REAL NOT NULL DEFAULT (unixepoch()),
  UNIQUE(day_key, algorithm_version)
);
CREATE INDEX IF NOT EXISTS idx_refinement_jobs_status ON refinement_jobs(status);
CREATE INDEX IF NOT EXISTS idx_refinement_jobs_day ON refinement_jobs(day_key);

CREATE TABLE IF NOT EXISTS refined_tracks (
  id               INTEGER PRIMARY KEY,
  day_key          TEXT    NOT NULL,
  algorithm_version TEXT   NOT NULL,
  tz_offset_s      INTEGER NOT NULL DEFAULT 0 CHECK (tz_offset_s BETWEEN -50400 AND 50400),
  quantization_cm  INTEGER NOT NULL DEFAULT 100 CHECK (quantization_cm > 0),
  codec            TEXT    NOT NULL DEFAULT 'bqdc-v1',
  compression      TEXT    NOT NULL DEFAULT 'lz4' CHECK (compression IN ('lz4','lzfse','none')),
  particle_count   INTEGER,
  confidence       REAL,
  frame_count      INTEGER NOT NULL DEFAULT 0 CHECK (frame_count >= 0),
  bbox_min_lat     REAL,
  bbox_min_lon     REAL,
  bbox_max_lat     REAL,
  bbox_max_lon     REAL,
  start_ts         REAL,
  end_ts           REAL,
  created_ts       REAL NOT NULL DEFAULT (unixepoch()),
  updated_ts       REAL NOT NULL DEFAULT (unixepoch()),
  UNIQUE(day_key, algorithm_version)
);
CREATE INDEX IF NOT EXISTS idx_refined_tracks_day ON refined_tracks(day_key);

CREATE TABLE IF NOT EXISTS refined_track_frames (
  id               INTEGER PRIMARY KEY,
  track_id         INTEGER NOT NULL REFERENCES refined_tracks(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  ts_start         REAL    NOT NULL,
  ts_end           REAL    NOT NULL CHECK (ts_end >= ts_start),
  bbox_min_lat     REAL,
  bbox_min_lon     REAL,
  bbox_max_lat     REAL,
  bbox_max_lon     REAL,
  payload          BLOB    NOT NULL,
  byte_size        INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 65536),
  created_ts       REAL NOT NULL DEFAULT (unixepoch()),
  UNIQUE(track_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_refined_track_frames_ts ON refined_track_frames(track_id, ts_start, ts_end);

CREATE TABLE IF NOT EXISTS refined_track_segments (
  id               INTEGER PRIMARY KEY,
  track_id         INTEGER NOT NULL REFERENCES refined_tracks(id) ON DELETE CASCADE,
  start_ts         REAL    NOT NULL,
  end_ts           REAL    NOT NULL CHECK (end_ts >= start_ts),
  mode             TEXT    NOT NULL,
  confidence       REAL,
  avg_speed_mps    REAL,
  created_ts       REAL NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_refined_track_segments_ts ON refined_track_segments(track_id, start_ts, end_ts);

PRAGMA user_version = 5;
