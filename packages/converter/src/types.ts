export type MoveMode =
  | "walk"
  | "run"
  | "bicycle"
  | "car"
  | "bus"
  | "train"
  | "metro"
  | "tram"
  | "transit"
  | "eScooter"
  | "motorcycle"
  | "boat"
  | "ferry"
  | "airplane"
  | "other";

export type SourceType = "arc-export" | "arc-backup" | "moves-export";

export type ImportFileEntry = {
  path: string;
  data: Uint8Array;
  size?: number;
};

export type ImportFileHandle = {
  path: string;
  size: number;
  readData: () => Promise<Uint8Array>;
};

export type ImportProgressPhase = "scan" | "read" | "parse" | "normalize" | "report";

export type ImportProgress = {
  phase: ImportProgressPhase;
  message: string;
  completed: number;
  total: number;
  bytesCompleted?: number;
  bytesTotal?: number;
};

export type Bounds = {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

export type PoiRow = {
  id: number;
  provider: string | null;
  provider_poi_id: string | null;
  name: string;
  category: string | null;
  subcategory: string | null;
  lat: number;
  lon: number;
  radius_m: number | null;
  visitCount: number;
  first_seen_ts: number | null;
  last_seen_ts: number | null;
  thoroughfare: string | null;
  sub_thoroughfare: string | null;
  locality: string | null;
  sub_locality: string | null;
  administrative_area: string | null;
  postal_code: string | null;
  country: string | null;
};

export type StayRow = {
  id: number;
  start_ts: number;
  end_ts: number | null;
  centroid_lat: number;
  centroid_lon: number;
  radius_m: number;
  type: "anchor" | "venue" | "short" | null;
  poi_id: number | null;
  tz_offset_s: number | null;
};

export type MoveRow = {
  id: number;
  start_ts: number;
  end_ts: number | null;
  mode: MoveMode;
  distance_m: number | null;
  tz_offset_s: number | null;
  provider: string | null;
};

export type RoutePathRow = {
  id: number;
  move_id: number;
  is_primary: 0 | 1;
  codec: "bqdc-v1";
  compression: "none";
  quantization_cm: number;
  path_blob: Uint8Array;
  sample_count: number;
  path_quality: "raw";
  provider: string;
  bbox_min_lat: number;
  bbox_min_lon: number;
  bbox_max_lat: number;
  bbox_max_lon: number;
  lod_level: number;
};

export type RawGPSRow = {
  id: number;
  ts: number;
  lat: number;
  lon: number;
  altitude_m: number | null;
  h_acc_m: number | null;
  v_acc_m: number | null;
  speed_mps: number | null;
  speed_acc_mps: number | null;
  course_deg: number | null;
  course_acc_deg: number | null;
  tz_offset_s: number | null;
  provider: "unknown";
  is_simulated: 0;
};

export type SampleRow = {
  id: number;
  ts: number;
  lat: number;
  lon: number;
  altitude_m: number | null;
  speed_mps: number | null;
  speed_acc_mps: number | null;
  course_deg: number | null;
  course_acc_deg: number | null;
  h_acc_m: number | null;
  v_acc_m: number | null;
  estimator: "raw";
  source_kind: "raw";
  flags: string | null;
  step_delta: number | null;
  tz_offset_s: number | null;
};

export type RawMotionActivityRow = {
  id: number;
  ts: number;
  confidence: 0 | 1 | 2;
  is_stationary: 0 | 1;
  is_walking: 0 | 1;
  is_running: 0 | 1;
  is_automotive: 0 | 1;
  is_cycling: 0 | 1;
  is_on_foot: 0 | 1;
  is_unknown: 0 | 1;
  tz_offset_s: number | null;
};

export type RawPedometerRow = {
  id: number;
  ts: number;
  steps_delta: number | null;
  distance_m: number | null;
  cadence_spm: number | null;
  pace_s_per_m: number | null;
  floors_up: number | null;
  floors_down: number | null;
  tz_offset_s: number | null;
};

export type RawVisitRow = {
  id: number;
  arrival_ts: number;
  departure_ts: number | null;
  lat: number;
  lon: number;
  horizontal_acc_m: number | null;
  tz_offset_s: number | null;
};

export type StayPoiRow = {
  stay_id: number;
  poi_id: number;
  role: "primary";
  distance_m: number | null;
};

export type NoDataGapRow = {
  id: number;
  start_ts: number;
  end_ts: number | null;
  reason: "Unknown";
  uncertainty: number | null;
  notes: string | null;
};

export type AuraRows = {
  pois: PoiRow[];
  stays: StayRow[];
  stay_pois: StayPoiRow[];
  moves: MoveRow[];
  route_paths: RoutePathRow[];
  raw_gps: RawGPSRow[];
  samples: SampleRow[];
  raw_motion_activity: RawMotionActivityRow[];
  raw_pedometer: RawPedometerRow[];
  raw_visits: RawVisitRow[];
  no_data_gaps: NoDataGapRow[];
};

export type ImportReport = {
  sourceTypes: SourceType[];
  userVersion: number;
  fileCount: number;
  dateRange: { startTs: number; endTs: number } | null;
  counts: Record<keyof AuraRows, number>;
  diagnostics: string[];
};

export type ConversionResult = {
  rows: AuraRows;
  report: ImportReport;
};

export type ImportScan = {
  sourceTypes: SourceType[];
  fileCount: number;
  supportedFileCount: number;
  unknownFileCount: number;
};
