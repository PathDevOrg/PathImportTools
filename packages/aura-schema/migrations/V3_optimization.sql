-- V3_optimization.sql
-- 目的: 添加表达式索引以优化基于本地时间的查询性能, 以及添加部分索引优化未结束事件的查询。
-- 优势: 极大提升 StatisticsDataService 中按天/月聚合查询的速度, 消除全表扫描。

-- ================================================================
-- 1. 表达式索引 (Expression Indexes) - 本地时间查询优化
-- ================================================================

-- 优化 samples 表按本地时间查询
CREATE INDEX IF NOT EXISTS idx_samples_local_time ON samples(ts + ifnull(tz_offset_s, 0));

-- 优化 raw_gps 表按本地时间查询
CREATE INDEX IF NOT EXISTS idx_raw_gps_local_time ON raw_gps(ts + ifnull(tz_offset_s, 0));

-- 优化 raw_pedometer 表按本地时间查询 (StatisticsDataService 核心依赖)
CREATE INDEX IF NOT EXISTS idx_raw_pedometer_local_time ON raw_pedometer(ts + ifnull(tz_offset_s, 0));

-- 优化 raw_motion_activity 表按本地时间查询
CREATE INDEX IF NOT EXISTS idx_raw_motion_local_time ON raw_motion_activity(ts + ifnull(tz_offset_s, 0));

-- 优化 moves 表按本地时间查询 (注意 moves 使用 start_ts)
CREATE INDEX IF NOT EXISTS idx_moves_local_time ON moves(start_ts + ifnull(tz_offset_s, 0));

-- 优化 stays 表按本地时间查询 (注意 stays 使用 start_ts)
CREATE INDEX IF NOT EXISTS idx_stays_local_time ON stays(start_ts + ifnull(tz_offset_s, 0));

-- ================================================================
-- 2. 部分索引 (Partial Indexes) - 状态查询优化
-- ================================================================

-- 优化 TimelineDAO.openEvent 查询 (查找当前未结束的事件)
-- 这是一个极小的索引, 只包含当前正在进行的事件 (通常只有 0 或 1 条记录)
CREATE INDEX IF NOT EXISTS idx_timeline_open_events ON timeline_events(start_ts) WHERE end_ts IS NULL;

-- 优化 GapsDAO.openGap 查询
CREATE INDEX IF NOT EXISTS idx_gaps_open ON no_data_gaps(start_ts) WHERE end_ts IS NULL;

-- ================================================================
-- 3. 其他查询优化 (DAO Review 发现)
-- ================================================================

-- 优化 MapSnapshotDAO.loadLeastRecentlyUsed (LRU 缓存淘汰)
CREATE INDEX IF NOT EXISTS idx_map_snapshots_last_access ON map_snapshots(last_access_ts);

-- 优化 POIDAO.fetchNearby (简单的经纬度边界框查询)
-- 虽然有 R-Tree, 但代码目前使用简单的 BETWEEN 查询, 添加复合索引可显著加速
CREATE INDEX IF NOT EXISTS idx_pois_location ON pois(lat, lon);

-- ================================================================
-- 4. 更新数据库版本
-- ================================================================
PRAGMA user_version = 3;
