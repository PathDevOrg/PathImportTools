-- V2_timeline_view.sql
-- 目的: 创建 timeline_enriched_events 视图, 将四表联查下沉到数据库层
-- 优势: 消除代码层 Join 的 N+1 查询问题
-- 注意: 此版本移除了步数实时聚合子查询 (move_steps), 以避免在海量数据下导致 View 查询卡死。
--      步数数据现在由 Swift 层在检测到 move_steps 为 NULL 时按需懒加载。

PRAGMA foreign_keys = ON;

-- ================================================================
-- 1. 清理旧视图
-- ================================================================
DROP VIEW IF EXISTS timeline_enriched_events;

-- ================================================================
-- 2. 创建 timeline_enriched_events 视图
-- ================================================================
CREATE VIEW timeline_enriched_events AS
SELECT
    te.id as event_id,
    te.start_ts,
    te.end_ts,
    te.kind,
    te.stay_id,
    te.move_id,
    -- Stay Context
    s.type as stay_type,
    s.centroid_lat,
    s.centroid_lon,
    s.radius_m,
    s.poi_id,
    -- POI Context
    p.name as poi_name,
    p.category as poi_category,
    p.subcategory as poi_subcategory,
    p.thoroughfare,
    p.sub_thoroughfare,
    p.locality,
    p.sub_locality,
    p.administrative_area,
    p.postal_code,
    p.country,
    -- Move Context
    m.mode as move_mode,
    m.distance_m as move_distance_m,
    -- Performance Optimization:
    -- 这里的子查询在 3GB+ 大数据库上会导致严重的读取放大和 UI 卡顿。
    -- 我们将其替换为 NULL, 改由 Swift 层进行 "Hybrid Fallback" (按需查询)。
    NULL as move_steps
FROM timeline_events te
LEFT JOIN stays s ON te.stay_id = s.id
LEFT JOIN pois p ON s.poi_id = p.id
LEFT JOIN moves m ON te.move_id = m.id;

-- 支持轨迹多级精度存储 (LOD) 和 静态地图快照缓存


-- 为 route_paths 添加精度层级字段
-- 0 = 原始高精 (用于详情页)
-- 1 = 抽稀概览 (用于周/月/年视图)
ALTER TABLE route_paths ADD COLUMN lod_level INTEGER NOT NULL DEFAULT 0;

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_route_paths_lod ON route_paths(move_id, lod_level);

-- 创建快照元数据表
CREATE TABLE IF NOT EXISTS map_snapshots (
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

CREATE INDEX IF NOT EXISTS idx_map_snapshots_key ON map_snapshots(cache_key);

-- ================================================================
-- 3. 修复统计视图 (解决时区漂移和异常距离问题)
-- ================================================================

-- 3.1 每日步数统计
-- 修正: 使用 tz_offset_s 替代 localtime
-- 修正: 过滤异常步幅 (0.3m - 2.5m) 以剔除交通工具产生的"伪步数"和距离
DROP VIEW IF EXISTS daily_pedometer_stats;
CREATE VIEW daily_pedometer_stats AS
SELECT
    DATE(ts + COALESCE(tz_offset_s, 0), 'unixepoch') as date,
    SUM(CASE 
        WHEN steps_delta > 0 
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5 
        THEN steps_delta 
        ELSE 0 
    END) as total_steps,
    SUM(CASE 
        WHEN steps_delta > 0 
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5 
        THEN distance_m 
        ELSE 0 
    END) as total_distance_m
FROM raw_pedometer
GROUP BY 1;

-- 3.2 每小时步数统计
DROP VIEW IF EXISTS hourly_pedometer_stats;
CREATE VIEW hourly_pedometer_stats AS
SELECT
    DATE(ts + COALESCE(tz_offset_s, 0), 'unixepoch') as date,
    STRFTIME('%H', ts + COALESCE(tz_offset_s, 0), 'unixepoch') as hour,
    SUM(CASE 
        WHEN steps_delta > 0 
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5 
        THEN steps_delta 
        ELSE 0 
    END) as total_steps,
    SUM(CASE 
        WHEN steps_delta > 0 
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5 
        THEN distance_m 
        ELSE 0 
    END) as total_distance_m
FROM raw_pedometer
GROUP BY 1, 2;

-- 3.3 每月步数统计
DROP VIEW IF EXISTS monthly_pedometer_stats;
CREATE VIEW monthly_pedometer_stats AS
SELECT
    STRFTIME('%Y-%m', ts + COALESCE(tz_offset_s, 0), 'unixepoch') as month,
    SUM(CASE 
        WHEN steps_delta > 0 
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5 
        THEN steps_delta 
        ELSE 0 
    END) as total_steps,
    SUM(CASE 
        WHEN steps_delta > 0 
             AND (CAST(distance_m AS REAL) / steps_delta) BETWEEN 0.3 AND 2.5 
        THEN distance_m 
        ELSE 0 
    END) as total_distance_m
FROM raw_pedometer
GROUP BY 1;

-- 3.4 每日活动统计
-- 修正: 使用 moves 表的 tz_offset_s
DROP VIEW IF EXISTS daily_activity_stats;
CREATE VIEW daily_activity_stats AS
SELECT
    DATE(start_ts + COALESCE(tz_offset_s, 0), 'unixepoch') as date,
    mode,
    SUM(COALESCE(distance_m, 0)) as total_distance_m,
    SUM(end_ts - start_ts) as total_duration_s
FROM moves
WHERE end_ts IS NOT NULL
GROUP BY 1, 2;

-- ================================================================
-- 4. 更新数据库版本
-- ================================================================
PRAGMA user_version = 2;
