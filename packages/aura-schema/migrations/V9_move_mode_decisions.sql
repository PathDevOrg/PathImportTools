CREATE TABLE IF NOT EXISTS move_mode_decisions (
  move_id             INTEGER PRIMARY KEY REFERENCES moves(id) ON DELETE CASCADE,
  mode                TEXT    NOT NULL,
  source              TEXT    NOT NULL CHECK (source IN ('user_confirmed','automatic')),
  confidence          REAL    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  is_locked           INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),
  is_learning_anchor  INTEGER NOT NULL DEFAULT 0 CHECK (is_learning_anchor IN (0,1)),
  created_ts          REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts          REAL    NOT NULL CHECK (updated_ts >= created_ts)
);

CREATE INDEX IF NOT EXISTS idx_move_mode_decisions_source
ON move_mode_decisions(source, is_learning_anchor, updated_ts DESC);

CREATE TABLE IF NOT EXISTS move_mode_feedback (
  id             INTEGER PRIMARY KEY,
  move_id        INTEGER NOT NULL,
  previous_mode  TEXT    NOT NULL,
  new_mode       TEXT    NOT NULL,
  feedback_type  TEXT    NOT NULL CHECK (feedback_type IN ('user_confirmation','user_correction')),
  created_ts     REAL    NOT NULL CHECK (created_ts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_move_mode_feedback_move
ON move_mode_feedback(move_id, created_ts DESC);

CREATE TABLE IF NOT EXISTS mobility_nodes (
  id             INTEGER PRIMARY KEY,
  centroid_lat   REAL    NOT NULL CHECK (centroid_lat BETWEEN -90 AND 90),
  centroid_lon   REAL    NOT NULL CHECK (centroid_lon BETWEEN -180 AND 180),
  radius_m       REAL    NOT NULL CHECK (radius_m >= 0),
  first_seen_ts  REAL    NOT NULL CHECK (first_seen_ts >= 0),
  last_seen_ts   REAL    NOT NULL CHECK (last_seen_ts >= first_seen_ts),
  stay_count     INTEGER NOT NULL CHECK (stay_count > 0)
);

CREATE TABLE IF NOT EXISTS mobility_node_members (
  node_id      INTEGER NOT NULL REFERENCES mobility_nodes(id) ON DELETE CASCADE,
  stay_id      INTEGER NOT NULL UNIQUE REFERENCES stays(id) ON DELETE CASCADE,
  distance_m   REAL    NOT NULL CHECK (distance_m >= 0),
  created_ts   REAL    NOT NULL CHECK (created_ts >= 0),
  PRIMARY KEY (node_id, stay_id)
);

CREATE INDEX IF NOT EXISTS idx_mobility_node_members_node
ON mobility_node_members(node_id);

CREATE TABLE IF NOT EXISTS mobility_edges (
  id                   INTEGER PRIMARY KEY,
  origin_node_id       INTEGER NOT NULL REFERENCES mobility_nodes(id) ON DELETE CASCADE,
  destination_node_id  INTEGER NOT NULL REFERENCES mobility_nodes(id) ON DELETE CASCADE,
  first_seen_ts        REAL    NOT NULL CHECK (first_seen_ts >= 0),
  last_seen_ts         REAL    NOT NULL CHECK (last_seen_ts >= first_seen_ts),
  UNIQUE(origin_node_id, destination_node_id)
);

CREATE TABLE IF NOT EXISTS mobility_route_clusters (
  id              INTEGER PRIMARY KEY,
  edge_id         INTEGER NOT NULL REFERENCES mobility_edges(id) ON DELETE CASCADE,
  route_signature BLOB    NOT NULL,
  first_seen_ts   REAL    NOT NULL CHECK (first_seen_ts >= 0),
  last_seen_ts    REAL    NOT NULL CHECK (last_seen_ts >= first_seen_ts)
);

CREATE INDEX IF NOT EXISTS idx_mobility_route_clusters_edge
ON mobility_route_clusters(edge_id);

CREATE TABLE IF NOT EXISTS mobility_route_cluster_members (
  route_cluster_id  INTEGER NOT NULL REFERENCES mobility_route_clusters(id) ON DELETE CASCADE,
  move_id           INTEGER NOT NULL UNIQUE REFERENCES moves(id) ON DELETE CASCADE,
  similarity        REAL    NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  created_ts        REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts        REAL    NOT NULL CHECK (updated_ts >= created_ts),
  PRIMARY KEY (route_cluster_id, move_id)
);

CREATE INDEX IF NOT EXISTS idx_mobility_route_cluster_members_cluster
ON mobility_route_cluster_members(route_cluster_id);

CREATE TABLE IF NOT EXISTS move_mode_suggestions (
  move_id          INTEGER PRIMARY KEY REFERENCES moves(id) ON DELETE CASCADE,
  suggested_mode   TEXT    NOT NULL,
  confidence       REAL    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  is_active        INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_ts       REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts       REAL    NOT NULL CHECK (updated_ts >= created_ts)
);

CREATE INDEX IF NOT EXISTS idx_move_mode_suggestions_active
ON move_mode_suggestions(is_active, updated_ts);

CREATE TABLE IF NOT EXISTS move_motion_signatures (
  move_id        INTEGER PRIMARY KEY REFERENCES moves(id) ON DELETE CASCADE,
  feature_data   BLOB    NOT NULL,
  sample_count   INTEGER NOT NULL CHECK (sample_count > 0),
  created_ts     REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts     REAL    NOT NULL CHECK (updated_ts >= created_ts)
);

CREATE TABLE IF NOT EXISTS custom_move_modes (
  identifier   TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  created_ts   REAL    NOT NULL CHECK (created_ts >= 0),
  updated_ts   REAL    NOT NULL CHECK (updated_ts >= created_ts)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_move_modes_name
ON custom_move_modes(name COLLATE NOCASE);

PRAGMA user_version = 9;
