-- V6: Add 'estimated' and 'simplified' to route_paths.path_quality CHECK constraint
-- 
-- SQLite doesn't support ALTER COLUMN to modify CHECK constraints directly.
-- We need to recreate the table with the new constraint.

PRAGMA foreign_keys = OFF;

-- 1. Create temporary table with new schema
CREATE TABLE route_paths_new (
  id               INTEGER PRIMARY KEY,
  move_id          INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  is_primary       INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
  codec            TEXT    NOT NULL CHECK (codec IN ('bqdc-v1','wkb','geojson')),
  compression      TEXT    NOT NULL DEFAULT 'lz4' CHECK (compression IN ('lz4','lzfse','none')),
  quantization_cm  INTEGER NOT NULL DEFAULT 100 CHECK (quantization_cm > 0),
  path_blob        BLOB    NOT NULL,
  sample_count     INTEGER CHECK (sample_count IS NULL OR sample_count >= 0),
  path_quality     TEXT    CHECK (path_quality IS NULL OR path_quality IN ('raw','filtered','map_matched','merged','healthkit','other','simplified','estimated')),
  provider         TEXT,
  bbox_min_lat     REAL,
  bbox_min_lon     REAL,
  bbox_max_lat     REAL,
  bbox_max_lon     REAL,
  created_ts       REAL NOT NULL DEFAULT (unixepoch()),
  updated_ts       REAL NOT NULL DEFAULT (unixepoch()),
  lod_level        INTEGER NOT NULL DEFAULT 0 CHECK (lod_level >= 0)
);

-- 2. Copy data from old table
INSERT INTO route_paths_new 
SELECT id, move_id, is_primary, codec, compression, quantization_cm, path_blob,
       sample_count, path_quality, provider, bbox_min_lat, bbox_min_lon,
       bbox_max_lat, bbox_max_lon, created_ts, updated_ts, lod_level
FROM route_paths;

-- 3. Drop old table
DROP TABLE route_paths;

-- 4. Rename new table
ALTER TABLE route_paths_new RENAME TO route_paths;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_route_paths_move_id ON route_paths(move_id);
CREATE INDEX IF NOT EXISTS idx_route_paths_move_primary ON route_paths(move_id, is_primary);

-- 6. Recreate triggers
CREATE TRIGGER IF NOT EXISTS route_paths_rtree_insert AFTER INSERT ON route_paths
WHEN NEW.bbox_min_lat IS NOT NULL AND NEW.bbox_min_lon IS NOT NULL AND NEW.bbox_max_lat IS NOT NULL AND NEW.bbox_max_lon IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO route_paths_rtree(path_id, min_lat, max_lat, min_lon, max_lon)
  VALUES (NEW.id, NEW.bbox_min_lat, NEW.bbox_max_lat, NEW.bbox_min_lon, NEW.bbox_max_lon);
END;

CREATE TRIGGER IF NOT EXISTS route_paths_rtree_delete AFTER DELETE ON route_paths
BEGIN
  DELETE FROM route_paths_rtree WHERE path_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS route_paths_rtree_update AFTER UPDATE OF bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon ON route_paths
WHEN NEW.bbox_min_lat IS NOT NULL AND NEW.bbox_min_lon IS NOT NULL AND NEW.bbox_max_lat IS NOT NULL AND NEW.bbox_max_lon IS NOT NULL
BEGIN
  UPDATE route_paths_rtree SET min_lat = NEW.bbox_min_lat, max_lat = NEW.bbox_max_lat, min_lon = NEW.bbox_min_lon, max_lon = NEW.bbox_max_lon
  WHERE path_id = NEW.id;
END;

PRAGMA foreign_keys = ON;

PRAGMA user_version = 6;
