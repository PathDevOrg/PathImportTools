CREATE TABLE devices (
  id          INTEGER PRIMARY KEY,
  platform    TEXT    NOT NULL,
  model       TEXT,
  os_version  TEXT,
  app_build   TEXT,
  source_tag  TEXT
);
CREATE TABLE config_snapshots (
  id           INTEGER PRIMARY KEY,
  created_ts   REAL    NOT NULL CHECK (created_ts >= 0),
  config_hash  TEXT    NOT NULL UNIQUE,
  config_json  TEXT    NOT NULL
);
CREATE INDEX idx_config_created_ts ON config_snapshots(created_ts);
CREATE TABLE settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE weather_snapshots (
  id                 INTEGER PRIMARY KEY,
  created_ts         REAL    NOT NULL CHECK (created_ts >= 0),
  ref_start_ts       REAL        CHECK (ref_start_ts IS NULL OR ref_start_ts >= 0),
  ref_end_ts         REAL        CHECK (ref_end_ts IS NULL OR ref_end_ts >= ref_start_ts),
  lat                REAL    NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon                REAL    NOT NULL CHECK (lon BETWEEN -180 AND 180),
  condition_code     TEXT,
  temperature_c      REAL,
  feels_like_c       REAL,
  humidity_pct       REAL        CHECK (humidity_pct IS NULL OR (humidity_pct >= 0 AND humidity_pct <= 100)),
  wind_speed_mps     REAL        CHECK (wind_speed_mps IS NULL OR wind_speed_mps >= 0),
  wind_direction_deg REAL        CHECK (wind_direction_deg IS NULL OR (wind_direction_deg >= 0 AND wind_direction_deg < 360)),
  precipitation_type TEXT,
  precipitation_intensity REAL   CHECK (precipitation_intensity IS NULL OR precipitation_intensity >= 0),
  daylight           INTEGER NOT NULL DEFAULT 0 CHECK (daylight IN (0,1)),
  provider           TEXT,
  fetch_status       TEXT    CHECK (fetch_status IS NULL OR fetch_status IN ('success','retry','fail','unavailable')),
  cache_key          TEXT,
  version            INTEGER DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX idx_weather_created_ts ON weather_snapshots(created_ts);
CREATE INDEX idx_weather_ref_window ON weather_snapshots(ref_start_ts, ref_end_ts);
CREATE INDEX idx_weather_cache_key ON weather_snapshots(cache_key);
CREATE TABLE pois (
  id              INTEGER PRIMARY KEY,
  provider        TEXT,
  provider_poi_id TEXT,
  name            TEXT NOT NULL CHECK (length(name) > 0),
  category        TEXT,
  subcategory     TEXT,
  lat             REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon             REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  radius_m        REAL CHECK (radius_m IS NULL OR radius_m >= 0),
  visitCount      INTEGER NOT NULL DEFAULT 0 CHECK (visitCount >= 0),
  first_seen_ts   REAL    CHECK (first_seen_ts IS NULL OR first_seen_ts >= 0),
  last_seen_ts    REAL    CHECK (last_seen_ts IS NULL OR last_seen_ts >= 0),
  thoroughfare    TEXT,
  sub_thoroughfare TEXT,
  locality        TEXT,
  sub_locality    TEXT,
  administrative_area TEXT,
  postal_code     TEXT,
  country         TEXT
);
CREATE UNIQUE INDEX uidx_pois_provider_id ON pois(provider, provider_poi_id) WHERE provider_poi_id IS NOT NULL;
CREATE INDEX idx_pois_name ON pois(name);
CREATE INDEX idx_pois_visitCount ON pois(visitCount DESC);
CREATE TABLE hk_workouts (
  id                   INTEGER PRIMARY KEY,
  workout_uuid         TEXT UNIQUE,
  workout_type         TEXT NOT NULL,
  start_ts             REAL    NOT NULL CHECK (start_ts >= 0),
  end_ts               REAL        CHECK (end_ts IS NULL OR end_ts >= start_ts),
  duration_s           REAL        CHECK (duration_s IS NULL OR duration_s >= 0),
  total_distance_m     REAL        CHECK (total_distance_m IS NULL OR total_distance_m >= 0),
  total_energy_kcal    REAL        CHECK (total_energy_kcal IS NULL OR total_energy_kcal >= 0),
  avg_heart_rate_bpm   REAL        CHECK (avg_heart_rate_bpm IS NULL OR avg_heart_rate_bpm >= 0),
  max_heart_rate_bpm   REAL        CHECK (max_heart_rate_bpm IS NULL OR max_heart_rate_bpm >= 0),
  avg_speed_mps        REAL        CHECK (avg_speed_mps IS NULL OR avg_speed_mps >= 0),
  device_json          TEXT,
  source_revision_json TEXT,
  metadata_json        TEXT
);
CREATE INDEX idx_hk_workouts_start_ts ON hk_workouts(start_ts);
CREATE INDEX idx_hk_workouts_window ON hk_workouts(start_ts, end_ts);
CREATE TABLE migrations (
  id            INTEGER PRIMARY KEY,
  applied_at_ts REAL    NOT NULL CHECK (applied_at_ts >= 0),
  from_version  INTEGER,
  to_version    INTEGER NOT NULL,
  notes         TEXT
);
CREATE INDEX idx_migrations_ts ON migrations(applied_at_ts);
CREATE TABLE raw_gps (
  id           INTEGER PRIMARY KEY,
  ts           REAL    NOT NULL CHECK (ts >= 0),
  lat          REAL    NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon          REAL    NOT NULL CHECK (lon BETWEEN -180 AND 180),
  altitude_m   REAL,
  h_acc_m      REAL    CHECK (h_acc_m IS NULL OR h_acc_m >= 0),
  v_acc_m      REAL    CHECK (v_acc_m IS NULL OR v_acc_m >= 0),
  speed_mps    REAL    CHECK (speed_mps IS NULL OR speed_mps >= 0),
  speed_acc_mps REAL   CHECK (speed_acc_mps IS NULL OR speed_acc_mps >= 0),
  course_deg   REAL    CHECK (course_deg IS NULL OR (course_deg >= 0 AND course_deg < 360)),
  course_acc_deg REAL  CHECK (course_acc_deg IS NULL OR (course_acc_deg >= 0 AND course_acc_deg < 360)),
  tz_offset_s  INTEGER CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400)),
  provider     TEXT    CHECK (provider IS NULL OR provider IN ('standard','slc','visit','microburst','unknown')),
  is_simulated INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0,1))
);
CREATE INDEX idx_raw_gps_ts ON raw_gps(ts);
CREATE TABLE raw_accel (
  id         INTEGER PRIMARY KEY,
  ts         REAL    NOT NULL CHECK (ts >= 0),
  ax         REAL    NOT NULL,
  ay         REAL    NOT NULL,
  az         REAL    NOT NULL
);
CREATE INDEX idx_raw_accel_ts ON raw_accel(ts);
CREATE TABLE raw_gyro (
  id         INTEGER PRIMARY KEY,
  ts         REAL    NOT NULL CHECK (ts >= 0),
  gx         REAL    NOT NULL,
  gy         REAL    NOT NULL,
  gz         REAL    NOT NULL
);
CREATE INDEX idx_raw_gyro_ts ON raw_gyro(ts);
CREATE TABLE raw_mag (
  id         INTEGER PRIMARY KEY,
  ts         REAL    NOT NULL CHECK (ts >= 0),
  mx         REAL    NOT NULL,
  my         REAL    NOT NULL,
  mz         REAL    NOT NULL
);
CREATE INDEX idx_raw_mag_ts ON raw_mag(ts);
CREATE TABLE raw_pedometer (
  id           INTEGER PRIMARY KEY,
  ts           REAL    NOT NULL CHECK (ts >= 0),
  steps_delta  INTEGER CHECK (steps_delta IS NULL OR steps_delta >= 0),
  distance_m   REAL    CHECK (distance_m IS NULL OR distance_m >= 0),
  cadence_spm  REAL    CHECK (cadence_spm IS NULL OR cadence_spm >= 0),
  pace_s_per_m REAL    CHECK (pace_s_per_m IS NULL OR pace_s_per_m >= 0),
  floors_up    REAL    CHECK (floors_up IS NULL OR floors_up >= 0),
  floors_down  REAL    CHECK (floors_down IS NULL OR floors_down >= 0),
  tz_offset_s  INTEGER CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
);
CREATE INDEX idx_raw_pedometer_ts ON raw_pedometer(ts);
CREATE TABLE raw_barometer (
  id             INTEGER PRIMARY KEY,
  ts             REAL    NOT NULL CHECK (ts >= 0),
  pressure_kpa   REAL    NOT NULL,
  relative_alt_m REAL    NOT NULL,
  tz_offset_s    INTEGER CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
);
CREATE INDEX idx_raw_barometer_ts ON raw_barometer(ts);
CREATE TABLE raw_motion_activity (
  id            INTEGER PRIMARY KEY,
  ts            REAL    NOT NULL CHECK (ts >= 0),
  confidence    INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 2),
  is_stationary INTEGER NOT NULL DEFAULT 0 CHECK (is_stationary IN (0,1)),
  is_walking    INTEGER NOT NULL DEFAULT 0 CHECK (is_walking    IN (0,1)),
  is_running    INTEGER NOT NULL DEFAULT 0 CHECK (is_running    IN (0,1)),
  is_automotive INTEGER NOT NULL DEFAULT 0 CHECK (is_automotive IN (0,1)),
  is_cycling    INTEGER NOT NULL DEFAULT 0 CHECK (is_cycling    IN (0,1)),
  is_on_foot    INTEGER NOT NULL DEFAULT 0 CHECK (is_on_foot    IN (0,1)),
  is_unknown    INTEGER NOT NULL DEFAULT 0 CHECK (is_unknown    IN (0,1)),
  tz_offset_s   INTEGER CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
);
CREATE INDEX idx_raw_motion_activity_ts ON raw_motion_activity(ts);
CREATE TABLE raw_visits (
  id                  INTEGER PRIMARY KEY,
  arrival_ts          REAL    NOT NULL CHECK (arrival_ts >= 0),
  departure_ts        REAL        CHECK (departure_ts IS NULL OR departure_ts >= arrival_ts),
  lat                 REAL    NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon                 REAL    NOT NULL CHECK (lon BETWEEN -180 AND 180),
  horizontal_acc_m    REAL        CHECK (horizontal_acc_m IS NULL OR horizontal_acc_m >= 0),
  tz_offset_s         INTEGER     CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
);
CREATE INDEX idx_raw_visits_arrival ON raw_visits(arrival_ts);
CREATE TABLE raw_monitor_events (
  id           INTEGER PRIMARY KEY,
  ts           REAL    NOT NULL CHECK (ts >= 0),
  anchor_id    TEXT    NOT NULL,
  event_type   TEXT    NOT NULL CHECK (event_type IN ('enter','exit')),
  tz_offset_s  INTEGER     CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
);
CREATE INDEX idx_raw_monitor_events_ts ON raw_monitor_events(ts);
CREATE TABLE hk_workout_events (
  id            INTEGER PRIMARY KEY,
  workout_id    INTEGER NOT NULL REFERENCES hk_workouts(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  start_ts      REAL    NOT NULL CHECK (start_ts >= 0),
  end_ts        REAL        CHECK (end_ts IS NULL OR end_ts >= start_ts),
  metadata_json TEXT
);
CREATE INDEX idx_hk_workout_events_wid_ts ON hk_workout_events(workout_id, start_ts);
CREATE TABLE samples (
  id          INTEGER PRIMARY KEY,
  ts          REAL    NOT NULL CHECK (ts >= 0),
  lat         REAL    NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon         REAL    NOT NULL CHECK (lon BETWEEN -180 AND 180),
  altitude_m  REAL,
  speed_mps   REAL,
  speed_acc_mps REAL   CHECK (speed_acc_mps IS NULL OR speed_acc_mps >= 0),
  course_deg  REAL    CHECK (course_deg IS NULL OR (course_deg >= 0 AND course_deg < 360)),
  course_acc_deg REAL CHECK (course_acc_deg IS NULL OR (course_acc_deg >= 0 AND course_acc_deg < 360)),
  h_acc_m     REAL    CHECK (h_acc_m IS NULL OR h_acc_m >= 0),
  v_acc_m     REAL    CHECK (v_acc_m IS NULL OR v_acc_m >= 0),
  estimator   TEXT    NOT NULL CHECK (estimator IN ('kf','pf','ukf','iekf','raw')),
  source_kind TEXT    NOT NULL CHECK (source_kind IN ('fused','mapMatched','drOnly','raw','synthetic')),
  flags       TEXT,
  step_delta  INTEGER,
  tz_offset_s INTEGER CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
);
CREATE INDEX idx_samples_ts ON samples(ts);
CREATE TABLE stays (
  id                  INTEGER PRIMARY KEY,
  start_ts            REAL    NOT NULL CHECK (start_ts >= 0),
  end_ts              REAL        CHECK (end_ts IS NULL OR end_ts >= start_ts),
  centroid_lat        REAL    NOT NULL CHECK (centroid_lat BETWEEN -90 AND 90),
  centroid_lon        REAL    NOT NULL CHECK (centroid_lon BETWEEN -180 AND 180),
  radius_m            REAL    NOT NULL CHECK (radius_m >= 0),
  type                TEXT    CHECK (type IS NULL OR type IN ('anchor','venue','short')),
  poi_id              INTEGER REFERENCES pois(id) ON DELETE SET NULL ON UPDATE CASCADE,
  tz_offset_s         INTEGER CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400))
, end_tz_offset_s INTEGER
    CHECK (end_tz_offset_s IS NULL OR end_tz_offset_s BETWEEN -50400 AND 50400));
CREATE INDEX idx_stays_start_ts ON stays(start_ts);
CREATE TABLE moves (
  id                  INTEGER PRIMARY KEY,
  start_ts            REAL    NOT NULL CHECK (start_ts >= 0),
  end_ts              REAL        CHECK (end_ts IS NULL OR end_ts >= start_ts),
  mode                TEXT    NOT NULL,
  distance_m          REAL        CHECK (distance_m IS NULL OR distance_m >= 0),
  tz_offset_s         INTEGER     CHECK (tz_offset_s IS NULL OR (tz_offset_s BETWEEN -50400 AND 50400)),
  provider            TEXT
, end_tz_offset_s INTEGER
    CHECK (end_tz_offset_s IS NULL OR end_tz_offset_s BETWEEN -50400 AND 50400));
CREATE INDEX idx_moves_start_ts ON moves(start_ts);
CREATE INDEX idx_moves_mode_ts ON moves(mode, start_ts);
CREATE TABLE no_data_gaps (
  id           INTEGER PRIMARY KEY,
  start_ts     REAL    NOT NULL CHECK (start_ts >= 0),
  end_ts       REAL        CHECK (end_ts IS NULL OR end_ts >= start_ts),
  reason       TEXT    NOT NULL CHECK (reason IN ('PermissionDenied','RadioOff','FlightSuspected','Underground','AppInactive','Unknown')),
  uncertainty  REAL        CHECK (uncertainty IS NULL OR uncertainty >= 0),
  notes        TEXT
, tz_offset_s INTEGER
    CHECK (tz_offset_s IS NULL OR tz_offset_s BETWEEN -50400 AND 50400), end_tz_offset_s INTEGER
    CHECK (end_tz_offset_s IS NULL OR end_tz_offset_s BETWEEN -50400 AND 50400));
CREATE INDEX idx_gaps_start_ts ON no_data_gaps(start_ts);
CREATE TABLE monitor_anchors (
  id               INTEGER PRIMARY KEY,
  anchor_id        TEXT    NOT NULL UNIQUE,
  lat              REAL    NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon              REAL    NOT NULL CHECK (lon BETWEEN -180 AND 180),
  radius_m         REAL    NOT NULL CHECK (radius_m > 0),
  kind             TEXT    NOT NULL CHECK (kind IN ('home','work','frequent','historical','other')),
  priority_score   INTEGER NOT NULL CHECK (priority_score >= 0),
  created_ts       REAL    NOT NULL CHECK (created_ts >= 0),
  last_access_ts   REAL        CHECK (last_access_ts IS NULL OR last_access_ts >= 0),
  is_active        INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1))
);
CREATE INDEX idx_monitor_anchors_active ON monitor_anchors(is_active);
CREATE INDEX idx_monitor_anchors_created ON monitor_anchors(created_ts);
CREATE TABLE stay_pois (
  stay_id    INTEGER NOT NULL REFERENCES stays(id) ON DELETE CASCADE,
  poi_id     INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  role       TEXT CHECK (role IS NULL OR role IN ('primary','secondary','inferred')),
  distance_m REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  PRIMARY KEY (stay_id, poi_id)
);
CREATE INDEX idx_stay_pois_poi ON stay_pois(poi_id);
CREATE TABLE timeline_events (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('stay','move','gap')),
  start_ts   REAL    NOT NULL CHECK (start_ts >= 0),
  end_ts     REAL        CHECK (end_ts IS NULL OR end_ts >= start_ts),
  stay_id    INTEGER REFERENCES stays(id) ON DELETE CASCADE,
  move_id    INTEGER REFERENCES moves(id) ON DELETE CASCADE,
  gap_id     INTEGER REFERENCES no_data_gaps(id) ON DELETE CASCADE,
  weather_snapshot_id INTEGER REFERENCES weather_snapshots(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CHECK (
    (kind='stay' AND stay_id IS NOT NULL AND move_id IS NULL AND gap_id IS NULL) OR
    (kind='move' AND move_id IS NOT NULL AND stay_id IS NULL AND gap_id IS NULL) OR
    (kind='gap'  AND gap_id IS NOT NULL AND stay_id IS NULL AND move_id IS NULL)
  )
);
CREATE UNIQUE INDEX uidx_timeline_start_ts ON timeline_events(start_ts);
CREATE UNIQUE INDEX uidx_timeline_stay ON timeline_events(stay_id) WHERE stay_id IS NOT NULL;
CREATE UNIQUE INDEX uidx_timeline_move ON timeline_events(move_id) WHERE move_id IS NOT NULL;
CREATE UNIQUE INDEX uidx_timeline_gap ON timeline_events(gap_id) WHERE gap_id IS NOT NULL;
CREATE INDEX idx_timeline_weather ON timeline_events(weather_snapshot_id);
CREATE TABLE sync_metadata (
  table_name       TEXT    NOT NULL,
  local_id         INTEGER NOT NULL,
  cloud_record_name TEXT    NOT NULL UNIQUE,
  modification_tag TEXT,
  last_sync_ts     REAL    NOT NULL,
  sync_status      TEXT    NOT NULL CHECK (sync_status IN ('local_only', 'in_sync', 'pending_upload', 'pending_deletion')),
  PRIMARY KEY (table_name, local_id)
);
CREATE INDEX idx_sync_metadata_cloud_name ON sync_metadata(cloud_record_name);
CREATE INDEX idx_sync_metadata_status ON sync_metadata(sync_status);
CREATE VIRTUAL TABLE pois_rtree USING rtree(poi_id, min_lat, max_lat, min_lon, max_lon);
CREATE VIRTUAL TABLE route_paths_rtree USING rtree(path_id, min_lat, max_lat, min_lon, max_lon);
CREATE TABLE bqdc_streams (
  id               INTEGER PRIMARY KEY,
  day_key          TEXT    NOT NULL UNIQUE,
  tz_offset_s      INTEGER NOT NULL DEFAULT 0 CHECK (tz_offset_s BETWEEN -50400 AND 50400),
  quantization_cm  INTEGER NOT NULL DEFAULT 100 CHECK (quantization_cm > 0),
  codec            TEXT    NOT NULL DEFAULT 'bqdc-v1',
  compression      TEXT    NOT NULL DEFAULT 'lz4' CHECK (compression IN ('lz4','lzfse','none')),
  frame_count      INTEGER NOT NULL DEFAULT 0 CHECK (frame_count >= 0),
  bbox_min_lat     REAL,
  bbox_min_lon     REAL,
  bbox_max_lat     REAL,
  bbox_max_lon     REAL,
  start_ts         REAL,
  end_ts           REAL,
  created_ts       REAL NOT NULL DEFAULT (unixepoch()),
  updated_ts       REAL NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_bqdc_streams_day ON bqdc_streams(day_key);
CREATE TABLE bqdc_frames (
  id               INTEGER PRIMARY KEY,
  stream_id        INTEGER NOT NULL REFERENCES bqdc_streams(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  ts_start         REAL    NOT NULL,
  ts_end           REAL    NOT NULL CHECK (ts_end >= ts_start),
  bbox_min_lat     REAL,
  bbox_min_lon     REAL,
  bbox_max_lat     REAL,
  bbox_max_lon     REAL,
  payload          BLOB    NOT NULL,
  byte_size        INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 65536),
  created_ts       REAL NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX uidx_bqdc_frames_stream_seq ON bqdc_frames(stream_id, seq);
CREATE INDEX idx_bqdc_frames_stream_ts ON bqdc_frames(stream_id, ts_start, ts_end);
CREATE VIRTUAL TABLE bqdc_frames_rtree USING rtree(frame_rowid, min_lat, max_lat, min_lon, max_lon);
CREATE TABLE tilesets (
  id               INTEGER PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('daily','weekly','monthly','yearly','range')),
  period_start_ts  REAL NOT NULL,
  period_end_ts    REAL NOT NULL,
  minzoom          INTEGER NOT NULL DEFAULT 0,
  maxzoom          INTEGER NOT NULL DEFAULT 16,
  extent           INTEGER NOT NULL DEFAULT 4096,
  format           TEXT NOT NULL CHECK (format IN ('mvt')),
  storage          TEXT NOT NULL CHECK (storage IN ('embedded','external')),
  location         TEXT,
  bbox_min_lat     REAL,
  bbox_min_lon     REAL,
  bbox_max_lat     REAL,
  bbox_max_lon     REAL,
  meta_json        TEXT,
  created_ts       REAL NOT NULL DEFAULT (unixepoch()),
  updated_ts       REAL NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_tilesets_kind_period ON tilesets(kind, period_start_ts, period_end_ts);
CREATE TABLE tiles (
  tileset_id   INTEGER NOT NULL REFERENCES tilesets(id) ON DELETE CASCADE,
  z            INTEGER NOT NULL,
  x            INTEGER NOT NULL,
  y            INTEGER NOT NULL,
  data         BLOB    NOT NULL,
  etag         TEXT,
  last_modified_ts REAL,
  PRIMARY KEY (tileset_id, z, x, y)
);
CREATE TABLE tile_invalidations (
  id            INTEGER PRIMARY KEY,
  tileset_id    INTEGER REFERENCES tilesets(id) ON DELETE CASCADE,
  cause         TEXT NOT NULL,
  min_lat       REAL,
  min_lon       REAL,
  max_lat       REAL,
  max_lon       REAL,
  start_ts      REAL,
  end_ts        REAL,
  created_ts    REAL NOT NULL DEFAULT (unixepoch()),
  processed_ts  REAL
);
CREATE VIRTUAL TABLE tile_invalidations_rtree USING rtree(invalidation_id, min_lat, max_lat, min_lon, max_lon);
CREATE TABLE tile_dirty (
  tileset_id  INTEGER NOT NULL REFERENCES tilesets(id) ON DELETE CASCADE,
  z           INTEGER NOT NULL,
  x           INTEGER NOT NULL,
  y           INTEGER NOT NULL,
  reason      TEXT,
  first_seen_ts REAL NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tileset_id, z, x, y)
);
CREATE TABLE tile_build_jobs (
  id            INTEGER PRIMARY KEY,
  tileset_id    INTEGER NOT NULL REFERENCES tilesets(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','skipped')),
  priority      INTEGER NOT NULL DEFAULT 5,
  requested_ts  REAL NOT NULL DEFAULT (unixepoch()),
  started_ts    REAL,
  finished_ts   REAL,
  stats_json    TEXT
);
CREATE TABLE stay_weather_snapshots (
  stay_id             INTEGER NOT NULL REFERENCES stays(id) ON DELETE CASCADE,
  weather_snapshot_id INTEGER NOT NULL REFERENCES weather_snapshots(id) ON DELETE CASCADE,
  sampled_at          REAL    NOT NULL CHECK (sampled_at >= 0),
  sample_reason       TEXT    CHECK (sample_reason IS NULL OR sample_reason IN ('start', 'end', 'periodic', 'manual')),
  PRIMARY KEY (stay_id, weather_snapshot_id)
);
CREATE INDEX idx_stay_weather_stay_id ON stay_weather_snapshots(stay_id);
CREATE INDEX idx_stay_weather_snapshot_id ON stay_weather_snapshots(weather_snapshot_id);
CREATE INDEX idx_stay_weather_sampled_at ON stay_weather_snapshots(stay_id, sampled_at);
CREATE TABLE move_weather_snapshots (
  move_id             INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  weather_snapshot_id INTEGER NOT NULL REFERENCES weather_snapshots(id) ON DELETE CASCADE,
  sampled_at          REAL    NOT NULL CHECK (sampled_at >= 0),
  sample_reason       TEXT    CHECK (sample_reason IS NULL OR sample_reason IN ('start', 'end', 'periodic', 'manual')),
  PRIMARY KEY (move_id, weather_snapshot_id)
);
CREATE INDEX idx_move_weather_move_id ON move_weather_snapshots(move_id);
CREATE INDEX idx_move_weather_snapshot_id ON move_weather_snapshots(weather_snapshot_id);
CREATE INDEX idx_move_weather_sampled_at ON move_weather_snapshots(move_id, sampled_at);
CREATE TRIGGER pois_rtree_ins AFTER INSERT ON pois
BEGIN
  INSERT OR REPLACE INTO pois_rtree(poi_id, min_lat, max_lat, min_lon, max_lon)
  VALUES (NEW.id, NEW.lat, NEW.lat, NEW.lon, NEW.lon);
END;
CREATE TRIGGER pois_rtree_del AFTER DELETE ON pois
BEGIN
  DELETE FROM pois_rtree WHERE poi_id = OLD.id;
END;
CREATE TRIGGER pois_rtree_upd AFTER UPDATE OF lat, lon ON pois
BEGIN
  UPDATE pois_rtree SET min_lat = NEW.lat, max_lat = NEW.lat, min_lon = NEW.lon, max_lon = NEW.lon
  WHERE poi_id = NEW.id;
END;
CREATE TRIGGER bqdc_frames_rtree_insert AFTER INSERT ON bqdc_frames
WHEN NEW.bbox_min_lat IS NOT NULL AND NEW.bbox_max_lat IS NOT NULL AND NEW.bbox_min_lon IS NOT NULL AND NEW.bbox_max_lon IS NOT NULL
BEGIN
  INSERT INTO bqdc_frames_rtree(frame_rowid, min_lat, max_lat, min_lon, max_lon)
  VALUES (NEW.id, NEW.bbox_min_lat, NEW.bbox_max_lat, NEW.bbox_min_lon, NEW.bbox_max_lon);
END;
CREATE TRIGGER bqdc_frames_rtree_delete AFTER DELETE ON bqdc_frames
BEGIN
  DELETE FROM bqdc_frames_rtree WHERE frame_rowid = OLD.id;
END;
CREATE TRIGGER tile_inv_rtree_insert AFTER INSERT ON tile_invalidations
WHEN NEW.min_lat IS NOT NULL AND NEW.max_lat IS NOT NULL AND NEW.min_lon IS NOT NULL AND NEW.max_lon IS NOT NULL
BEGIN
  INSERT INTO tile_invalidations_rtree(invalidation_id, min_lat, max_lat, min_lon, max_lon)
  VALUES (NEW.id, NEW.min_lat, NEW.max_lat, NEW.min_lon, NEW.max_lon);
END;
CREATE TRIGGER tile_inv_rtree_delete AFTER DELETE ON tile_invalidations
BEGIN
  DELETE FROM tile_invalidations_rtree WHERE invalidation_id = OLD.id;
END;
CREATE TRIGGER bqdc_frames_agg_after_insert AFTER INSERT ON bqdc_frames
BEGIN
  UPDATE bqdc_streams
    SET frame_count = frame_count + 1,
        start_ts = COALESCE(start_ts, NEW.ts_start),
        end_ts   = MAX(COALESCE(end_ts, NEW.ts_end), NEW.ts_end),
        bbox_min_lat = CASE WHEN bbox_min_lat IS NULL THEN NEW.bbox_min_lat ELSE MIN(bbox_min_lat, NEW.bbox_min_lat) END,
        bbox_min_lon = CASE WHEN bbox_min_lon IS NULL THEN NEW.bbox_min_lon ELSE MIN(bbox_min_lon, NEW.bbox_min_lon) END,
        bbox_max_lat = CASE WHEN bbox_max_lat IS NULL THEN NEW.bbox_max_lat ELSE MAX(bbox_max_lat, NEW.bbox_max_lat) END,
        bbox_max_lon = CASE WHEN bbox_max_lon IS NULL THEN NEW.bbox_max_lon ELSE MAX(bbox_max_lon, NEW.bbox_max_lon) END,
        updated_ts   = unixepoch()
  WHERE id = NEW.stream_id;
END;
CREATE TRIGGER inv_on_bqdc_frame_ins AFTER INSERT ON bqdc_frames
BEGIN
  INSERT INTO tile_invalidations (tileset_id, cause, min_lat, min_lon, max_lat, max_lon, start_ts, end_ts, created_ts)
  SELECT t.id, 'bqdc_frame',
         NEW.bbox_min_lat, NEW.bbox_min_lon, NEW.bbox_max_lat, NEW.bbox_max_lon,
         NEW.ts_start, NEW.ts_end, unixepoch()
  FROM tilesets t
  WHERE NEW.ts_end   > t.period_start_ts
    AND NEW.ts_start < t.period_end_ts;
END;
CREATE TRIGGER tle_sync_stay_ins AFTER INSERT ON stays
BEGIN
  INSERT INTO timeline_events(kind, start_ts, end_ts, stay_id) VALUES ('stay', NEW.start_ts, NEW.end_ts, NEW.id);
END;
CREATE TRIGGER tle_sync_stay_upd AFTER UPDATE OF start_ts, end_ts ON stays
BEGIN
  UPDATE timeline_events SET start_ts = NEW.start_ts, end_ts = NEW.end_ts WHERE stay_id = NEW.id;
END;
CREATE TRIGGER tle_sync_stay_del AFTER DELETE ON stays
BEGIN
  DELETE FROM timeline_events WHERE stay_id = OLD.id;
END;
CREATE TRIGGER tle_sync_move_ins AFTER INSERT ON moves
BEGIN
  INSERT INTO timeline_events(kind, start_ts, end_ts, move_id) VALUES ('move', NEW.start_ts, NEW.end_ts, NEW.id);
END;
CREATE TRIGGER tle_sync_move_upd AFTER UPDATE OF start_ts, end_ts ON moves
BEGIN
  UPDATE timeline_events SET start_ts = NEW.start_ts, end_ts = NEW.end_ts WHERE move_id = NEW.id;
END;
CREATE TRIGGER tle_sync_move_del AFTER DELETE ON moves
BEGIN
  DELETE FROM timeline_events WHERE move_id = OLD.id;
END;
CREATE TRIGGER tle_sync_gap_ins AFTER INSERT ON no_data_gaps
BEGIN
  INSERT INTO timeline_events(kind, start_ts, end_ts, gap_id) VALUES ('gap', NEW.start_ts, NEW.end_ts, NEW.id);
END;
CREATE TRIGGER tle_sync_gap_upd AFTER UPDATE OF start_ts, end_ts ON no_data_gaps
BEGIN
  UPDATE timeline_events SET start_ts = NEW.start_ts, end_ts = NEW.end_ts WHERE gap_id = NEW.id;
END;
CREATE TRIGGER tle_sync_gap_del AFTER DELETE ON no_data_gaps
BEGIN
  DELETE FROM timeline_events WHERE gap_id = OLD.id;
END;
CREATE TABLE map_snapshots (
  id               INTEGER PRIMARY KEY,
  cache_key        TEXT NOT NULL UNIQUE, -- e.g. "move_123", "day_20231027", "month_202310"
  file_path        TEXT NOT NULL,        -- e.g. "Snapshots/month_202310.png"
  data_version_tag TEXT,                 -- 用于检测数据源是否变更
  width            INTEGER,              -- 图片宽度 (px)
  height           INTEGER,              -- 图片高度 (px)
  theme            TEXT,                 -- e.g. "light", "dark"
  created_ts       REAL NOT NULL DEFAULT (unixepoch()),
  last_access_ts   REAL NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_map_snapshots_key ON map_snapshots(cache_key);
CREATE VIEW daily_activity_stats AS
SELECT
    DATE(start_ts + COALESCE(tz_offset_s, 0), 'unixepoch') as date,
    mode,
    SUM(COALESCE(distance_m, 0)) as total_distance_m,
    SUM(end_ts - start_ts) as total_duration_s
FROM moves
WHERE end_ts IS NOT NULL
GROUP BY 1, 2;
CREATE INDEX idx_samples_local_time ON samples(ts + ifnull(tz_offset_s, 0));
CREATE INDEX idx_raw_gps_local_time ON raw_gps(ts + ifnull(tz_offset_s, 0));
CREATE INDEX idx_raw_pedometer_local_time ON raw_pedometer(ts + ifnull(tz_offset_s, 0));
CREATE INDEX idx_raw_motion_local_time ON raw_motion_activity(ts + ifnull(tz_offset_s, 0));
CREATE INDEX idx_moves_local_time ON moves(start_ts + ifnull(tz_offset_s, 0));
CREATE INDEX idx_stays_local_time ON stays(start_ts + ifnull(tz_offset_s, 0));
CREATE INDEX idx_map_snapshots_last_access ON map_snapshots(last_access_ts);
CREATE INDEX idx_pois_location ON pois(lat, lon);
CREATE TABLE raw_device_motion (
  id              INTEGER PRIMARY KEY,
  ts              REAL    NOT NULL CHECK (ts >= 0),
  attitude_x      REAL    NOT NULL,
  attitude_y      REAL    NOT NULL,
  attitude_z      REAL    NOT NULL,
  attitude_w      REAL    NOT NULL,
  gravity_x       REAL    NOT NULL,
  gravity_y       REAL    NOT NULL,
  gravity_z       REAL    NOT NULL
);
CREATE INDEX idx_raw_device_motion_ts ON raw_device_motion(ts);
CREATE TABLE refinement_jobs (
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
CREATE INDEX idx_refinement_jobs_status ON refinement_jobs(status);
CREATE INDEX idx_refinement_jobs_day ON refinement_jobs(day_key);
CREATE TABLE refined_tracks (
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
CREATE INDEX idx_refined_tracks_day ON refined_tracks(day_key);
CREATE TABLE refined_track_frames (
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
CREATE INDEX idx_refined_track_frames_ts ON refined_track_frames(track_id, ts_start, ts_end);
CREATE TABLE refined_track_segments (
  id               INTEGER PRIMARY KEY,
  track_id         INTEGER NOT NULL REFERENCES refined_tracks(id) ON DELETE CASCADE,
  start_ts         REAL    NOT NULL,
  end_ts           REAL    NOT NULL CHECK (end_ts >= start_ts),
  mode             TEXT    NOT NULL,
  confidence       REAL,
  avg_speed_mps    REAL,
  created_ts       REAL NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_refined_track_segments_ts ON refined_track_segments(track_id, start_ts, end_ts);
CREATE TABLE "route_paths" (
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
CREATE INDEX idx_route_paths_move_id ON route_paths(move_id);
CREATE INDEX idx_route_paths_move_primary ON route_paths(move_id, is_primary);
CREATE TRIGGER route_paths_rtree_insert AFTER INSERT ON route_paths
WHEN NEW.bbox_min_lat IS NOT NULL AND NEW.bbox_min_lon IS NOT NULL AND NEW.bbox_max_lat IS NOT NULL AND NEW.bbox_max_lon IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO route_paths_rtree(path_id, min_lat, max_lat, min_lon, max_lon)
  VALUES (NEW.id, NEW.bbox_min_lat, NEW.bbox_max_lat, NEW.bbox_min_lon, NEW.bbox_max_lon);
END;
CREATE TRIGGER route_paths_rtree_delete AFTER DELETE ON route_paths
BEGIN
  DELETE FROM route_paths_rtree WHERE path_id = OLD.id;
END;
CREATE TRIGGER route_paths_rtree_update AFTER UPDATE OF bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon ON route_paths
WHEN NEW.bbox_min_lat IS NOT NULL AND NEW.bbox_min_lon IS NOT NULL AND NEW.bbox_max_lat IS NOT NULL AND NEW.bbox_max_lon IS NOT NULL
BEGIN
  UPDATE route_paths_rtree SET min_lat = NEW.bbox_min_lat, max_lat = NEW.bbox_max_lat, min_lon = NEW.bbox_min_lon, max_lon = NEW.bbox_max_lon
  WHERE path_id = NEW.id;
END;
CREATE TABLE stay_place_rules (
    source_stay_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    category TEXT,
    center_lat REAL NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
    center_lon REAL NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
    radius_m REAL NOT NULL CHECK (radius_m >= 0),
    updated_ts REAL NOT NULL CHECK (updated_ts >= 0)
);
CREATE INDEX idx_stay_place_rules_updated ON stay_place_rules(updated_ts DESC);
CREATE INDEX idx_route_paths_move_lod_primary ON route_paths(move_id, lod_level, is_primary DESC);
CREATE TABLE move_mode_decisions (
  move_id             INTEGER PRIMARY KEY REFERENCES moves(id) ON DELETE CASCADE,
  mode                TEXT    NOT NULL,
  source              TEXT    NOT NULL CHECK (source IN ('user_confirmed','automatic')),
  confidence          REAL    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  is_locked           INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),
  is_learning_anchor  INTEGER NOT NULL DEFAULT 0 CHECK (is_learning_anchor IN (0,1)),
  created_ts          REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts          REAL    NOT NULL CHECK (updated_ts >= created_ts)
);
CREATE INDEX idx_move_mode_decisions_source
ON move_mode_decisions(source, is_learning_anchor, updated_ts DESC);
CREATE TABLE move_mode_feedback (
  id             INTEGER PRIMARY KEY,
  move_id        INTEGER NOT NULL,
  previous_mode  TEXT    NOT NULL,
  new_mode       TEXT    NOT NULL,
  feedback_type  TEXT    NOT NULL CHECK (feedback_type IN ('user_confirmation','user_correction')),
  created_ts     REAL    NOT NULL CHECK (created_ts >= 0)
);
CREATE INDEX idx_move_mode_feedback_move
ON move_mode_feedback(move_id, created_ts DESC);
CREATE TABLE mobility_nodes (
  id             INTEGER PRIMARY KEY,
  centroid_lat   REAL    NOT NULL CHECK (centroid_lat BETWEEN -90 AND 90),
  centroid_lon   REAL    NOT NULL CHECK (centroid_lon BETWEEN -180 AND 180),
  radius_m       REAL    NOT NULL CHECK (radius_m >= 0),
  first_seen_ts  REAL    NOT NULL CHECK (first_seen_ts >= 0),
  last_seen_ts   REAL    NOT NULL CHECK (last_seen_ts >= first_seen_ts),
  stay_count     INTEGER NOT NULL CHECK (stay_count > 0)
);
CREATE TABLE mobility_node_members (
  node_id      INTEGER NOT NULL REFERENCES mobility_nodes(id) ON DELETE CASCADE,
  stay_id      INTEGER NOT NULL UNIQUE REFERENCES stays(id) ON DELETE CASCADE,
  distance_m   REAL    NOT NULL CHECK (distance_m >= 0),
  created_ts   REAL    NOT NULL CHECK (created_ts >= 0),
  PRIMARY KEY (node_id, stay_id)
);
CREATE INDEX idx_mobility_node_members_node
ON mobility_node_members(node_id);
CREATE TABLE mobility_edges (
  id                   INTEGER PRIMARY KEY,
  origin_node_id       INTEGER NOT NULL REFERENCES mobility_nodes(id) ON DELETE CASCADE,
  destination_node_id  INTEGER NOT NULL REFERENCES mobility_nodes(id) ON DELETE CASCADE,
  first_seen_ts        REAL    NOT NULL CHECK (first_seen_ts >= 0),
  last_seen_ts         REAL    NOT NULL CHECK (last_seen_ts >= first_seen_ts),
  UNIQUE(origin_node_id, destination_node_id)
);
CREATE TABLE mobility_route_clusters (
  id              INTEGER PRIMARY KEY,
  edge_id         INTEGER NOT NULL REFERENCES mobility_edges(id) ON DELETE CASCADE,
  route_signature BLOB    NOT NULL,
  first_seen_ts   REAL    NOT NULL CHECK (first_seen_ts >= 0),
  last_seen_ts    REAL    NOT NULL CHECK (last_seen_ts >= first_seen_ts)
);
CREATE INDEX idx_mobility_route_clusters_edge
ON mobility_route_clusters(edge_id);
CREATE TABLE mobility_route_cluster_members (
  route_cluster_id  INTEGER NOT NULL REFERENCES mobility_route_clusters(id) ON DELETE CASCADE,
  move_id           INTEGER NOT NULL UNIQUE REFERENCES moves(id) ON DELETE CASCADE,
  similarity        REAL    NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  created_ts        REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts        REAL    NOT NULL CHECK (updated_ts >= created_ts),
  PRIMARY KEY (route_cluster_id, move_id)
);
CREATE INDEX idx_mobility_route_cluster_members_cluster
ON mobility_route_cluster_members(route_cluster_id);
CREATE TABLE move_mode_suggestions (
  move_id          INTEGER PRIMARY KEY REFERENCES moves(id) ON DELETE CASCADE,
  suggested_mode   TEXT    NOT NULL,
  confidence       REAL    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  is_active        INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_ts       REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts       REAL    NOT NULL CHECK (updated_ts >= created_ts)
);
CREATE INDEX idx_move_mode_suggestions_active
ON move_mode_suggestions(is_active, updated_ts);
CREATE TABLE move_motion_signatures (
  move_id        INTEGER PRIMARY KEY REFERENCES moves(id) ON DELETE CASCADE,
  feature_data   BLOB    NOT NULL,
  sample_count   INTEGER NOT NULL CHECK (sample_count > 0),
  created_ts     REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts     REAL    NOT NULL CHECK (updated_ts >= created_ts)
);
CREATE TABLE custom_move_modes (
  identifier   TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  created_ts   REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts   REAL    NOT NULL CHECK (updated_ts >= created_ts)
);
CREATE UNIQUE INDEX idx_custom_move_modes_name
ON custom_move_modes(name COLLATE NOCASE);
CREATE TRIGGER tle_no_overlap_ins BEFORE INSERT ON timeline_events
WHEN COALESCE((
  SELECT end_ts IS NULL OR end_ts > NEW.start_ts
  FROM timeline_events
  WHERE start_ts < NEW.start_ts
  ORDER BY start_ts DESC
  LIMIT 1
), 0)
OR COALESCE((
  SELECT NEW.end_ts IS NULL OR NEW.end_ts > start_ts
  FROM timeline_events
  WHERE start_ts > NEW.start_ts
  ORDER BY start_ts ASC
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'timeline_events overlap');
END;
CREATE TRIGGER tle_no_overlap_upd BEFORE UPDATE OF start_ts, end_ts ON timeline_events
WHEN COALESCE((
  SELECT end_ts IS NULL OR end_ts > NEW.start_ts
  FROM timeline_events
  WHERE id <> NEW.id AND start_ts < NEW.start_ts
  ORDER BY start_ts DESC
  LIMIT 1
), 0)
OR COALESCE((
  SELECT NEW.end_ts IS NULL OR NEW.end_ts > start_ts
  FROM timeline_events
  WHERE id <> NEW.id AND start_ts > NEW.start_ts
  ORDER BY start_ts ASC
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'timeline_events overlap');
END;
CREATE TRIGGER tle_no_adjacent_same_kind_ins BEFORE INSERT ON timeline_events
WHEN NEW.kind <> 'move'
AND (
  NEW.kind = COALESCE((
    SELECT kind
    FROM timeline_events
    WHERE start_ts < NEW.start_ts
    ORDER BY start_ts DESC
    LIMIT 1
  ), '')
  OR NEW.kind = COALESCE((
    SELECT kind
    FROM timeline_events
    WHERE start_ts > NEW.start_ts
    ORDER BY start_ts ASC
    LIMIT 1
  ), '')
)
BEGIN
  SELECT RAISE(ABORT, 'timeline_events: cannot insert adjacent events of same kind');
END;
CREATE TRIGGER tle_no_adjacent_same_kind_upd
BEFORE UPDATE OF kind, start_ts ON timeline_events
WHEN (
  (
    NEW.kind <> 'move'
    AND (
      NEW.kind = COALESCE((
        SELECT kind
        FROM timeline_events
        WHERE id <> NEW.id AND start_ts < NEW.start_ts
        ORDER BY start_ts DESC
        LIMIT 1
      ), '')
      OR NEW.kind = COALESCE((
        SELECT kind
        FROM timeline_events
        WHERE id <> NEW.id AND start_ts > NEW.start_ts
        ORDER BY start_ts ASC
        LIMIT 1
      ), '')
    )
  )
  OR EXISTS (
    SELECT 1
    FROM (
      SELECT kind, start_ts
      FROM timeline_events
      WHERE id <> NEW.id AND start_ts < OLD.start_ts
      ORDER BY start_ts DESC
      LIMIT 1
    ) previous
    CROSS JOIN (
      SELECT kind, start_ts
      FROM timeline_events
      WHERE id <> NEW.id AND start_ts > OLD.start_ts
      ORDER BY start_ts ASC
      LIMIT 1
    ) following
    WHERE previous.kind = following.kind
      AND previous.kind IN ('stay', 'gap')
      AND NOT (
        NEW.start_ts > previous.start_ts
        AND NEW.start_ts < following.start_ts
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'timeline_events: cannot update to create adjacent events of same kind');
END;
CREATE TRIGGER tle_no_adjacent_same_kind_del BEFORE DELETE ON timeline_events
WHEN EXISTS (
  SELECT 1
  FROM (
    SELECT kind
    FROM timeline_events
    WHERE start_ts < OLD.start_ts
    ORDER BY start_ts DESC
    LIMIT 1
  ) previous
  CROSS JOIN (
    SELECT kind
    FROM timeline_events
    WHERE start_ts > OLD.start_ts
    ORDER BY start_ts ASC
    LIMIT 1
  ) following
  WHERE previous.kind = following.kind
    AND previous.kind IN ('stay', 'gap')
)
BEGIN
  SELECT RAISE(ABORT, 'timeline_events: cannot delete to create adjacent events of same kind');
END;
CREATE VIEW daily_pedometer_stats AS
SELECT
    DATE(ts + COALESCE(tz_offset_s, 0), 'unixepoch') as date,
    SUM(CASE WHEN steps_delta > 0 THEN steps_delta ELSE 0 END) as total_steps,
    SUM(CASE
        WHEN steps_delta > 0
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5
        THEN distance_m
        ELSE 0
    END) as total_distance_m
FROM raw_pedometer
GROUP BY 1;
CREATE VIEW hourly_pedometer_stats AS
SELECT
    DATE(ts + COALESCE(tz_offset_s, 0), 'unixepoch') as date,
    STRFTIME('%H', ts + COALESCE(tz_offset_s, 0), 'unixepoch') as hour,
    SUM(CASE WHEN steps_delta > 0 THEN steps_delta ELSE 0 END) as total_steps,
    SUM(CASE
        WHEN steps_delta > 0
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5
        THEN distance_m
        ELSE 0
    END) as total_distance_m
FROM raw_pedometer
GROUP BY 1, 2;
CREATE VIEW monthly_pedometer_stats AS
SELECT
    STRFTIME('%Y-%m', ts + COALESCE(tz_offset_s, 0), 'unixepoch') as month,
    SUM(CASE WHEN steps_delta > 0 THEN steps_delta ELSE 0 END) as total_steps,
    SUM(CASE
        WHEN steps_delta > 0
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5
        THEN distance_m
        ELSE 0
    END) as total_distance_m
FROM raw_pedometer
GROUP BY 1;
CREATE VIEW timeline_enriched_events AS
SELECT
    te.id AS event_id,
    te.start_ts,
    te.end_ts,
    te.kind,
    te.stay_id,
    te.move_id,
    te.gap_id,
    COALESCE(s.tz_offset_s, m.tz_offset_s, g.tz_offset_s) AS start_tz_offset_s,
    COALESCE(s.end_tz_offset_s, m.end_tz_offset_s, g.end_tz_offset_s) AS end_tz_offset_s,
    s.type AS stay_type,
    s.centroid_lat,
    s.centroid_lon,
    s.radius_m,
    s.poi_id,
    p.name AS poi_name,
    p.category AS poi_category,
    p.subcategory AS poi_subcategory,
    p.thoroughfare,
    p.sub_thoroughfare,
    p.locality,
    p.sub_locality,
    p.administrative_area,
    p.postal_code,
    p.country,
    m.mode AS move_mode,
    m.distance_m AS move_distance_m,
    NULL AS move_steps
FROM timeline_events te
LEFT JOIN stays s ON te.stay_id = s.id
LEFT JOIN pois p ON s.poi_id = p.id
LEFT JOIN moves m ON te.move_id = m.id
LEFT JOIN no_data_gaps g ON te.gap_id = g.id;
PRAGMA user_version = 13;
