-- V4: Add raw_device_motion table for storing iOS DeviceMotion fusion data
-- This stores only the data that cannot be reconstructed from raw_accel/raw_gyro

CREATE TABLE IF NOT EXISTS raw_device_motion (
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

CREATE INDEX IF NOT EXISTS idx_raw_device_motion_ts ON raw_device_motion(ts);

PRAGMA user_version = 4;