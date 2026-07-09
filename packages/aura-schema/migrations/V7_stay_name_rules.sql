CREATE TABLE IF NOT EXISTS stay_place_rules (
    source_stay_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    category TEXT,
    center_lat REAL NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
    center_lon REAL NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
    radius_m REAL NOT NULL CHECK (radius_m >= 0),
    updated_ts REAL NOT NULL CHECK (updated_ts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_stay_place_rules_updated ON stay_place_rules(updated_ts DESC);

PRAGMA user_version = 7;
