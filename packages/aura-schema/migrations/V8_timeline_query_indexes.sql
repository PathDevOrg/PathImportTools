CREATE INDEX IF NOT EXISTS idx_timeline_window_start_end ON timeline_events(start_ts, end_ts);

CREATE INDEX IF NOT EXISTS idx_route_paths_move_lod_primary ON route_paths(move_id, lod_level, is_primary DESC);

PRAGMA user_version = 8;
