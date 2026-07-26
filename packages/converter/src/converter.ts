import { getLatestSchemaVersion } from "@aura-importer/aura-schema";
import { gunzipSync } from "fflate";
import { encodeBQDCPath } from "./bqdc.js";
import { calculateBounds, calculatePathDistance, validLatLon } from "./geo.js";
import { mapActivityType } from "./modes.js";
import { extractTimezoneOffsetSeconds, parseImportTimestamp } from "./time.js";
import type {
  AuraRows,
  ConversionResult,
  ImportFileEntry,
  ImportFileHandle,
  ImportProgress,
  ImportReport,
  ImportScan,
  MoveMode,
  MoveRow,
  NoDataGapRow,
  PoiRow,
  RawGPSRow,
  RawMotionActivityRow,
  RawPedometerRow,
  RoutePathRow,
  SampleRow,
  SourceType,
  StayPoiRow,
  StayRow,
  StreamableAuraRows,
  StreamableAuraTable
} from "./types.js";

type JsonObject = Record<string, unknown>;

type MutableState = {
  rows: AuraRows;
  next: Record<keyof Omit<AuraRows, "stay_pois">, number>;
  poiCache: Map<string, number>;
  arcPlaces: Map<string, { center: { lat: number; lon: number }; radius: number | null }>;
  itemMap: Map<string, { kind: "stay" | "move"; id: number }>;
  pendingMovesStays: Map<string, StayRow[]>;
  diagnostics: string[];
  diagnosticCounts: Map<string, number>;
  streamedCounts: Record<StreamableAuraTable, number>;
  onRows?: <T extends StreamableAuraTable>(table: T, rows: StreamableAuraRows[T]) => void;
};

type SemanticRef = {
  kind: "stay" | "move" | "gap";
  row: StayRow | MoveRow | NoDataGapRow;
};

type NormalizationContext = {
  removedStayIds: Set<number>;
  removedMoveIds: Set<number>;
  removedGapIds: Set<number>;
  stayRedirects: Map<number, number>;
};

type ClassifyProbe = {
  kind: SourceType | null;
};

type ClassifiedFile = {
  path: string;
  size: number;
  readData: () => Promise<Uint8Array>;
};

type ConversionOptions = {
  onProgress?: (progress: ImportProgress) => void;
  onRows?: <T extends StreamableAuraTable>(table: T, rows: StreamableAuraRows[T]) => void;
};

type ReadTracker = {
  readJson: (file: ClassifiedFile) => Promise<unknown>;
};

type ArcItemSelection = {
  path: string;
  score: readonly [number, number, number, number];
};

const decoder = new TextDecoder();
const diagnosticSampleLimit = 20;

const sourceOrder: SourceType[] = ["arc-export", "arc-backup", "moves-export"];

export async function scanImportEntries(entries: ImportFileHandle[]): Promise<ImportScan> {
  const detected = new Set<SourceType>();
  let supportedFileCount = 0;
  for (const entry of entries) {
    if (!isJsonPath(entry.path)) {
      continue;
    }
    try {
      const probe = await classifyJsonEntry(entry);
      if (probe.kind) {
        detected.add(probe.kind);
        supportedFileCount += 1;
      }
    } catch {
      // ignore unreadable or unparseable files during scan
    }
  }
  return {
    sourceTypes: sourceOrder.filter((source) => detected.has(source)),
    fileCount: entries.length,
    supportedFileCount,
    unknownFileCount: entries.length - supportedFileCount
  };
}

async function classifyJsonEntry(entry: ImportFileHandle): Promise<ClassifyProbe> {
  try {
    const data = await entry.readData();
    const json = parseJsonBytes(entry.path, data);
    return { kind: classifySource(json) };
  } catch {
    return { kind: null };
  }
}

export async function convertImportEntries(entries: ImportFileEntry[], options: ConversionOptions = {}): Promise<ConversionResult> {
  return convertImportFileHandles(entries.map((entry) => ({
    path: entry.path,
    size: entry.size ?? entry.data.byteLength,
    readData: async () => entry.data
  })), options);
}

export async function convertImportFileHandles(entries: ImportFileHandle[], options: ConversionOptions = {}): Promise<ConversionResult> {
  const state = makeState(options.onRows);
  const sortedEntries = [...entries].sort((lhs, rhs) => lhs.path.localeCompare(rhs.path));
  const arcExportFiles: ClassifiedFile[] = [];
  const arcBackupFiles: ClassifiedFile[] = [];
  const movesFiles: ClassifiedFile[] = [];
  const detected = new Set<SourceType>();
  for (const entry of sortedEntries) {
    if (!isJsonPath(entry.path)) {
      continue;
    }
    const probe = await classifyJsonEntry(entry);
    if (!probe.kind) {
      continue;
    }
    detected.add(probe.kind);
    if (probe.kind === "arc-export") {
      arcExportFiles.push({ path: entry.path, size: entry.size, readData: entry.readData });
    } else if (probe.kind === "arc-backup") {
      arcBackupFiles.push({ path: entry.path, size: entry.size, readData: entry.readData });
    } else {
      movesFiles.push({ path: entry.path, size: entry.size, readData: entry.readData });
    }
  }

  const tracker = makeReadTracker([...arcExportFiles, ...arcBackupFiles, ...movesFiles], options.onProgress);

  await importArcExport(arcExportFiles, state, tracker);
  await importArcBackup(arcBackupFiles, state, tracker);
  await importMovesExport(movesFiles, state, tracker);

  normalizeTimeline(state, options.onProgress);
  const report = makeReport(state, entries.length, sourceOrder.filter((source) => detected.has(source)), options.onProgress);
  return { rows: state.rows, report };
}

function makeReadTracker(files: ClassifiedFile[], onProgress: ConversionOptions["onProgress"]): ReadTracker {
  const total = files.length;
  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  let bytesCompleted = 0;

  return {
    readJson: async (file) => {
      onProgress?.({
        phase: "read",
        message: `Reading ${file.path}`,
        completed,
        total,
        bytesCompleted,
        bytesTotal
      });
      onProgress?.({
        phase: "parse",
        message: `Parsed ${file.path}`,
        completed,
        total,
        bytesCompleted,
        bytesTotal
      });
      const data = await file.readData();
      const json = parseJsonBytes(file.path, data);
      completed += 1;
      bytesCompleted += file.size;
      return json;
    }
  };
}

function makeState(onRows?: ConversionOptions["onRows"]): MutableState {
  return {
    rows: {
      pois: [],
      stays: [],
      stay_pois: [],
      moves: [],
      route_paths: [],
      raw_gps: [],
      samples: [],
      raw_motion_activity: [],
      raw_pedometer: [],
      raw_visits: [],
      no_data_gaps: []
    },
    next: {
      pois: 1,
      stays: 1,
      moves: 1,
      route_paths: 1,
      raw_gps: 1,
      samples: 1,
      raw_motion_activity: 1,
      raw_pedometer: 1,
      raw_visits: 1,
      no_data_gaps: 1
    },
    poiCache: new Map(),
    arcPlaces: new Map(),
    itemMap: new Map(),
    pendingMovesStays: new Map(),
    diagnostics: [],
    diagnosticCounts: new Map(),
    streamedCounts: {
      raw_gps: 0,
      samples: 0,
      raw_motion_activity: 0,
      raw_pedometer: 0
    },
    onRows
  };
}

function classifySource(json: unknown): SourceType | null {
  const object = asObject(json);
  if (object) {
    if (Array.isArray(object.timelineItems) && object.timelineItems.length > 0) {
      for (const candidate of arrayValue(object.timelineItems)) {
        if (arcItemKey(candidate) !== null) {
          return "arc-export";
        }
      }
    }
    if (stringValue(object.itemId) !== null) {
      return "arc-backup";
    }
    if (stringValue(object.placeId) !== null && (numberValue(asObject(object.center)?.latitude) !== null || locationFrom(object.center) !== null || locationFrom(object.location) !== null)) {
      return "arc-backup";
    }
  }
  if (Array.isArray(json)) {
    const items = arrayValue(json);
    const first = items[0];
    if (first && movesDayLooksLikeStoryline(first)) {
      return "moves-export";
    }
    if (first && stringValue(first.sampleId) !== null && stringValue(first.timelineItemId) !== null) {
      return "arc-backup";
    }
  }
  return null;
}

function movesDayLooksLikeStoryline(day: JsonObject): boolean {
  if (stringValue(day.date) === null) {
    return false;
  }
  const segments = arrayValue(day.segments);
  if (segments.length === 0) {
    return false;
  }
  for (const segment of segments) {
    if (stringValue(segment.startTime) === null || stringValue(segment.endTime) === null) {
      return false;
    }
    const type = stringValue(segment.type);
    if (type === "place") {
      if (placeIdentifier(segment.place) === null) {
        return false;
      }
    } else if (type === "move") {
      if (arrayValue(segment.activities).length === 0) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function placeIdentifier(value: unknown): string | null {
  const object = asObject(value);
  if (!object) {
    return null;
  }
  return stringValue(object.id) ?? numberValue(object.id)?.toString() ?? null;
}

function isJsonPath(path: string): boolean {
  return path.endsWith(".json") || path.endsWith(".json.gz");
}

function parseJsonBytes(path: string, data: Uint8Array): unknown {
  const bytes = path.endsWith(".gz") ? gunzipSync(data) : data;
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

function asObject(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function arrayValue(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is JsonObject => item !== null) : [];
}

function locationFrom(value: unknown): { lat: number; lon: number } | null {
  const object = asObject(value);
  if (!object) {
    return null;
  }
  const lat = numberValue(object.latitude) ?? numberValue(object.lat);
  const lon = numberValue(object.longitude) ?? numberValue(object.lon);
  return lat !== null && lon !== null && validLatLon(lat, lon) ? { lat, lon } : null;
}

async function importArcExport(files: ClassifiedFile[], state: MutableState, tracker: ReadTracker): Promise<void> {
  const selected = new Map<string, ArcItemSelection>();

  for (const file of files) {
    try {
      const data = asObject(await tracker.readJson(file));
      for (const item of arrayValue(data?.timelineItems)) {
        const key = arcItemKey(item);
        if (!key) {
          continue;
        }
        const score = arcItemScore(item);
        const current = selected.get(key);
        if (!current || compareArcItemScores(score, current.score) > 0) {
          selected.set(key, { path: file.path, score });
        }
      }
    } catch (error) {
      recordDiagnostic(state, `Failed to index ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const imported = new Set<string>();
  for (const file of files) {
    try {
      const data = asObject(await tracker.readJson(file));
      const items = arrayValue(data?.timelineItems)
        .filter((item) => {
          const key = arcItemKey(item);
          return key !== null && !imported.has(key) && selected.get(key)?.path === file.path;
        })
        .sort((lhs, rhs) => (parseImportTimestamp(stringValue(lhs.startDate)) ?? 0) - (parseImportTimestamp(stringValue(rhs.startDate)) ?? 0));
      for (const item of items) {
        const key = arcItemKey(item);
        if (!key) {
          continue;
        }
        imported.add(key);
        importArcTimelineItem(item, state, "arc_import");
      }
    } catch (error) {
      recordDiagnostic(state, `Failed to read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function arcItemKey(item: JsonObject): string | null {
  const itemId = stringValue(item.itemId);
  if (itemId) {
    return `id:${itemId}`;
  }
  const start = stringValue(item.startDate);
  const end = stringValue(item.endDate);
  if (!start || !end) {
    return null;
  }
  return `time:${start}|${end}|${item.isVisit === true ? "stay" : "move"}`;
}

function arcItemScore(item: JsonObject): ArcItemSelection["score"] {
  const samples = arrayValue(item.samples);
  const sampleFields = samples.reduce((count, sample) => count + Object.values(sample).filter((value) => value !== null && value !== undefined).length, 0);
  const place = asObject(item.place);
  return [
    samples.length,
    sampleFields,
    Object.values(item).filter((value) => value !== null && value !== undefined).length,
    place ? Object.values(place).filter((value) => value !== null && value !== undefined).length : 0
  ];
}

function compareArcItemScores(lhs: ArcItemSelection["score"], rhs: ArcItemSelection["score"]): number {
  for (let index = 0; index < lhs.length; index += 1) {
    if (lhs[index] !== rhs[index]) {
      return lhs[index]! - rhs[index]!;
    }
  }
  return 0;
}

async function importArcBackup(files: ClassifiedFile[], state: MutableState, tracker: ReadTracker): Promise<void> {
  const placeFiles: ClassifiedFile[] = [];
  const itemFiles: ClassifiedFile[] = [];
  const sampleFiles: ClassifiedFile[] = [];

  for (const file of files) {
    try {
      const parsed = await tracker.readJson(file);
      const object = asObject(parsed);
      if (object && stringValue(object.itemId) !== null) {
        itemFiles.push(file);
      } else if (object && stringValue(object.placeId) !== null) {
        placeFiles.push(file);
      } else if (Array.isArray(parsed) && arrayValue(parsed).some((sample) => stringValue(sample.sampleId) !== null && stringValue(sample.timelineItemId) !== null)) {
        sampleFiles.push(file);
      }
    } catch (error) {
      recordDiagnostic(state, `Failed to classify ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of placeFiles) {
    try {
      const place = asObject(await tracker.readJson(file));
      if (place) {
        importArcPlace(place, state);
      }
    } catch (error) {
      recordDiagnostic(state, `Failed to read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of itemFiles) {
    try {
      const item = asObject(await tracker.readJson(file));
      if (item && item.deleted !== true) {
        importArcBackupTimelineItem(item, state);
      }
    } catch (error) {
      recordDiagnostic(state, `Failed to read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of sampleFiles) {
    try {
      const samples = arrayValue(await tracker.readJson(file));
      importArcBackupSamples(samples, state);
    } catch (error) {
      recordDiagnostic(state, `Failed to read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function importMovesExport(files: ClassifiedFile[], state: MutableState, tracker: ReadTracker): Promise<void> {
  for (const file of files) {
    try {
      const data = await tracker.readJson(file);
      const days = Array.isArray(data) ? data.map(asObject).filter((item): item is JsonObject => item !== null) : [asObject(data)].filter((item): item is JsonObject => item !== null);
      for (const day of days) {
        importMovesDay(day, state);
      }
    } catch (error) {
      recordDiagnostic(state, `Failed to read ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function importArcTimelineItem(item: JsonObject, state: MutableState, provider: string): void {
  const samples = arrayValue(item.samples);
  const tzOffset = numberValue(samples[0]?.secondsFromGMT);
  const itemId = stringValue(item.itemId);
  if (item.isVisit === true) {
    const stayId = importArcStay(item, state, tzOffset);
    if (itemId && stayId !== null) {
      state.itemMap.set(itemId, { kind: "stay", id: stayId });
    }
  } else {
    const moveId = importArcMove(item, state, tzOffset, provider);
    if (itemId && moveId !== null) {
      state.itemMap.set(itemId, { kind: "move", id: moveId });
    }
  }
  importSamples(samples, state);
  importPedometerData(item, state, tzOffset);
}

function importArcStay(item: JsonObject, state: MutableState, tzOffset: number | null): number | null {
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  if (start === null || end === null || !validWindow(start, end)) {
    recordDiagnostic(state, "Skipped stay with invalid time window");
    return null;
  }

  const place = asObject(item.place);
  const samples = arrayValue(item.samples);
  const center = locationFrom(item.center) ?? locationFrom(place?.center) ?? locationFrom(place?.location) ?? locationFrom(samples[0]?.location) ?? locationFrom(samples[0]);
  if (!center) {
    recordDiagnostic(state, "Skipped stay without coordinates");
    return null;
  }

  const radius = asObject(item.radius);
  const radiusMeters = positiveNumber(numberValue(radius?.mean)) ?? 50;
  const poiId = getOrCreateArcPoi(item, state, start);
  const type = asObject(item.place)?.isHome === true ? "anchor" : "venue";

  const duplicate = state.rows.stays.some((stay) => Math.abs(stay.start_ts - start) < 0.001 && Math.abs(stay.centroid_lat - center.lat) < 0.000001 && Math.abs(stay.centroid_lon - center.lon) < 0.000001);
  if (duplicate) {
    return null;
  }

  const row: StayRow = {
    id: state.next.stays++,
    start_ts: start,
    end_ts: end,
    centroid_lat: center.lat,
    centroid_lon: center.lon,
    radius_m: radiusMeters,
    type,
    poi_id: poiId,
    tz_offset_s: tzOffset
  };
  state.rows.stays.push(row);

  if (poiId !== null) {
    state.rows.stay_pois.push({ stay_id: row.id, poi_id: poiId, role: "primary", distance_m: null });
  }

  state.rows.raw_visits.push({
    id: state.next.raw_visits++,
    arrival_ts: start,
    departure_ts: end,
    lat: center.lat,
    lon: center.lon,
    horizontal_acc_m: positiveNumber(numberValue(radius?.mean)),
    tz_offset_s: tzOffset
  });

  return row.id;
}

function importArcMove(item: JsonObject, state: MutableState, tzOffset: number | null, provider: string): number | null {
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  if (start === null || end === null || !validWindow(start, end)) {
    recordDiagnostic(state, "Skipped move with invalid time window");
    return null;
  }

  const samples = arrayValue(item.samples);
  let activity = stringValue(item.activityType) ?? stringValue(item.confirmedType);
  if (!activity) {
    for (const sample of samples) {
      const candidate = stringValue(sample.confirmedType) ?? stringValue(sample.coreMotionActivityType);
      if (candidate && candidate !== "stationary") {
        activity = candidate;
        break;
      }
    }
  }

  const coords = coordinatesFromSamples(samples);
  const distance = calculatePathDistance(coords);
  const row = insertMove(state, {
    start,
    end,
    mode: mapActivityType(activity),
    distance,
    tzOffset,
    provider
  });
  if (coords.length >= 2) {
    insertRoutePath(state, row.id, coords, provider);
  }
  return row.id;
}

function importArcPlace(place: JsonObject, state: MutableState): number | null {
  const placeId = stringValue(place.placeId);
  const center = locationFrom(place.center) ?? locationFrom(place.location);
  if (!placeId || !center) {
    return null;
  }

  const radius = positiveNumber(numberValue(asObject(place.radius)?.mean));
  state.arcPlaces.set(placeId, { center, radius });
  const name = meaningfulName(place.name);
  if (!name) {
    return null;
  }
  return insertPoi(state, {
    provider: "arc",
    providerId: placeId,
    name,
    category: stringValue(place.mapboxCategory),
    lat: center.lat,
    lon: center.lon,
    radius,
    seenTs: null,
    thoroughfare: stringValue(place.streetAddress)
  });
}

function importArcBackupTimelineItem(item: JsonObject, state: MutableState): void {
  const itemId = stringValue(item.itemId);
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  const tzOffset = numberValue(item.secondsFromGMT);
  if (!itemId || start === null || end === null || !validWindow(start, end)) {
    return;
  }

  if (state.itemMap.has(itemId)) {
    importPedometerData(item, state, tzOffset);
    return;
  }

  if (item.isVisit === true) {
    const placeId = stringValue(item.placeId);
    const poiId = placeId ? state.poiCache.get(`arc:${placeId}`) ?? null : null;
    const poi = poiId ? state.rows.pois.find((row) => row.id === poiId) ?? null : null;
    const place = placeId ? state.arcPlaces.get(placeId) : null;
    const center = poi ? { lat: poi.lat, lon: poi.lon } : place?.center ?? locationFrom(item.center);
    if (!center) {
      recordDiagnostic(state, "Skipped backup stay without coordinates");
      return;
    }
    const stay: StayRow = {
      id: state.next.stays++,
      start_ts: start,
      end_ts: end,
      centroid_lat: center.lat,
      centroid_lon: center.lon,
      radius_m: poi?.radius_m ?? place?.radius ?? 50,
      type: "venue",
      poi_id: poiId,
      tz_offset_s: tzOffset
    };
    state.rows.stays.push(stay);
    if (poiId !== null) {
      state.rows.stay_pois.push({ stay_id: stay.id, poi_id: poiId, role: "primary", distance_m: null });
    }
    state.itemMap.set(itemId, { kind: "stay", id: stay.id });
  } else {
    const move = insertMove(state, {
      start,
      end,
      mode: mapActivityType(stringValue(item.activityType)),
      distance: null,
      tzOffset,
      provider: "arc_backup"
    });
    state.itemMap.set(itemId, { kind: "move", id: move.id });
  }

  importPedometerData(item, state, tzOffset);
}

function importArcBackupSamples(samples: JsonObject[], state: MutableState): void {
  const grouped = new Map<string, JsonObject[]>();
  for (const sample of samples) {
    const timelineItemId = stringValue(sample.timelineItemId);
    if (!timelineItemId) {
      continue;
    }
    const group = grouped.get(timelineItemId) ?? [];
    group.push(sample);
    grouped.set(timelineItemId, group);
  }

  for (const [timelineItemId, group] of grouped) {
    const mapping = state.itemMap.get(timelineItemId);
    if (!mapping) {
      continue;
    }
    importSamples(group, state);
    if (mapping.kind === "move") {
      const coords = coordinatesFromSamples(group);
      const move = state.rows.moves.find((row) => row.id === mapping.id);
      if (move && coords.length >= 2) {
        move.distance_m = calculatePathDistance(coords);
        move.tz_offset_s = move.tz_offset_s ?? numberValue(group[0]?.secondsFromGMT);
        if (!state.rows.route_paths.some((path) => path.move_id === move.id)) {
          insertRoutePath(state, move.id, coords, "arc_backup");
        }
      }
    }
  }
}

function importMovesDay(day: JsonObject, state: MutableState): void {
  const segments = arrayValue(day.segments);
  const starts = segments.map((segment) => parseImportTimestamp(stringValue(segment.startTime))).filter((value): value is number => value !== null);
  const ends = segments.map((segment) => parseImportTimestamp(stringValue(segment.endTime))).filter((value): value is number => value !== null);
  if (starts.length > 0 && ends.length > 0) {
    replaceSemanticEventsInRange(state, Math.min(...starts) - 1, Math.max(...ends) + 1);
  }
  for (const segment of segments) {
    const type = stringValue(segment.type);
    if (type === "place") {
      importMovesPlace(segment, state);
    } else if (type === "move") {
      importMovesMove(segment, state);
    }
  }
}

function replaceSemanticEventsInRange(state: MutableState, start: number, end: number): void {
  const removedStayIds = new Set(state.rows.stays.filter((row) => row.start_ts < end && (row.end_ts === null || row.end_ts > start)).map((row) => row.id));
  const removedMoveIds = new Set(state.rows.moves.filter((row) => row.start_ts < end && (row.end_ts === null || row.end_ts > start)).map((row) => row.id));
  state.rows.stays = state.rows.stays.filter((row) => !removedStayIds.has(row.id));
  state.rows.moves = state.rows.moves.filter((row) => !removedMoveIds.has(row.id));
  state.rows.no_data_gaps = state.rows.no_data_gaps.filter((row) => row.start_ts >= end || (row.end_ts !== null && row.end_ts <= start));
  state.rows.stay_pois = state.rows.stay_pois.filter((row) => !removedStayIds.has(row.stay_id));
  state.rows.route_paths = state.rows.route_paths.filter((row) => !removedMoveIds.has(row.move_id));
  for (const [placeId, pending] of state.pendingMovesStays) {
    const remaining = pending.filter((stay) => !removedStayIds.has(stay.id));
    if (remaining.length > 0) {
      state.pendingMovesStays.set(placeId, remaining);
    } else {
      state.pendingMovesStays.delete(placeId);
    }
  }
  for (const [itemId, mapping] of state.itemMap) {
    if ((mapping.kind === "stay" && removedStayIds.has(mapping.id)) || (mapping.kind === "move" && removedMoveIds.has(mapping.id))) {
      state.itemMap.delete(itemId);
    }
  }
}

function importMovesPlace(segment: JsonObject, state: MutableState): void {
  const place = asObject(segment.place);
  const start = parseImportTimestamp(stringValue(segment.startTime));
  const end = parseImportTimestamp(stringValue(segment.endTime));
  const center = locationFrom(place?.location);
  if (!place || !center || start === null || end === null || !validWindow(start, end)) {
    return;
  }

  const movesPlaceId = stringValue(place.id) ?? numberValue(place.id)?.toString() ?? null;
  const name = meaningfulName(place.name);
  const poiId = movesPlaceId ? resolveMovesPoi(state, movesPlaceId, name, center, start) : null;

  const stay: StayRow = {
    id: state.next.stays++,
    start_ts: start,
    end_ts: end,
    centroid_lat: center.lat,
    centroid_lon: center.lon,
    radius_m: 50,
    type: "venue",
    poi_id: poiId,
    tz_offset_s: extractTimezoneOffsetSeconds(stringValue(segment.startTime))
  };
  state.rows.stays.push(stay);
  if (poiId !== null) {
    state.rows.stay_pois.push({ stay_id: stay.id, poi_id: poiId, role: "primary", distance_m: null });
  } else if (movesPlaceId) {
    const pending = state.pendingMovesStays.get(movesPlaceId) ?? [];
    pending.push(stay);
    state.pendingMovesStays.set(movesPlaceId, pending);
  }
}

function meaningfulName(value: unknown): string | null {
  const name = stringValue(value)?.trim();
  return name && name.length > 0 ? name : null;
}

function resolveMovesPoi(state: MutableState, placeId: string, name: string | null, center: { lat: number; lon: number }, seenTs: number): number | null {
  const cacheKey = `moves:${placeId}`;
  const existingId = state.poiCache.get(cacheKey);
  if (!name) {
    if (!existingId) {
      return null;
    }
    const existing = state.rows.pois.find((row) => row.id === existingId);
    if (existing) {
      existing.visitCount += 1;
      existing.last_seen_ts = seenTs;
    }
    return existingId;
  }

  const poiId = insertPoi(state, {
    provider: "moves",
    providerId: placeId,
    name,
    category: null,
    lat: center.lat,
    lon: center.lon,
    radius: null,
    seenTs,
    thoroughfare: null
  });
  const pending = state.pendingMovesStays.get(placeId) ?? [];
  if (pending.length > 0) {
    const poi = state.rows.pois.find((row) => row.id === poiId);
    if (poi) {
      poi.visitCount += pending.length;
      poi.first_seen_ts = Math.min(poi.first_seen_ts ?? seenTs, ...pending.map((stay) => stay.start_ts));
    }
    for (const stay of pending) {
      stay.poi_id = poiId;
      state.rows.stay_pois.push({ stay_id: stay.id, poi_id: poiId, role: "primary", distance_m: null });
    }
    state.pendingMovesStays.delete(placeId);
  }
  return poiId;
}

function importMovesMove(segment: JsonObject, state: MutableState): void {
  const start = parseImportTimestamp(stringValue(segment.startTime));
  const end = parseImportTimestamp(stringValue(segment.endTime));
  if (start === null || end === null || !validWindow(start, end)) {
    return;
  }

  const activities = arrayValue(segment.activities);
  if (activities.length === 0) {
    const coords = coordinatesFromTrackPoints(arrayValue(segment.trackPoints));
    const move = insertMove(state, {
      start,
      end,
      mode: mapActivityType(stringValue(segment.activity)),
      distance: positiveNumber(numberValue(segment.distance)) ?? calculatePathDistance(coords),
      tzOffset: extractTimezoneOffsetSeconds(stringValue(segment.startTime)),
      provider: "moves_export"
    });
    if (coords.length >= 2) {
      insertRoutePath(state, move.id, coords, "moves_export");
    }
    return;
  }

  const normalized = activities
    .map((activity) => {
      const activityStart = parseImportTimestamp(stringValue(activity.startTime));
      const activityEnd = parseImportTimestamp(stringValue(activity.endTime));
      if (activityStart === null || activityEnd === null || !validWindow(activityStart, activityEnd)) {
        return null;
      }
      return {
        activity,
        start: Math.max(activityStart, start),
        end: Math.min(activityEnd, end)
      };
    })
    .filter((activity): activity is { activity: JsonObject; start: number; end: number } => activity !== null && activity.end > activity.start)
    .sort((lhs, rhs) => lhs.start - rhs.start);

  const segmentCoords = coordinatesFromTrackPoints(arrayValue(segment.trackPoints));
  for (const normalizedActivity of normalized) {
    const activity = normalizedActivity.activity;
    const coords = coordinatesFromTrackPoints(arrayValue(activity.trackPoints));
    const effectiveCoords = coords.length > 0 ? coords : normalized.length === 1 ? segmentCoords : [];
    const move = insertMove(state, {
      start: normalizedActivity.start,
      end: normalizedActivity.end,
      mode: mapActivityType(stringValue(activity.activity)),
      distance: positiveNumber(numberValue(activity.distance)) ?? calculatePathDistance(effectiveCoords),
      tzOffset: extractTimezoneOffsetSeconds(stringValue(activity.startTime)),
      provider: "moves_export"
    });
    if (effectiveCoords.length >= 2) {
      insertRoutePath(state, move.id, effectiveCoords, "moves_export");
    }
  }
}

function insertPoi(
  state: MutableState,
  input: {
    provider: string;
    providerId: string | null;
    name: string;
    category: string | null;
    lat: number;
    lon: number;
    radius: number | null;
    seenTs: number | null;
    thoroughfare: string | null;
  }
): number {
  const cacheKey = input.providerId ? `${input.provider}:${input.providerId}` : null;
  if (cacheKey) {
    const existingId = state.poiCache.get(cacheKey);
    if (existingId) {
      const existing = state.rows.pois.find((row) => row.id === existingId);
      if (existing) {
        existing.visitCount += 1;
        existing.last_seen_ts = input.seenTs ?? existing.last_seen_ts;
      }
      return existingId;
    }
  }

  const row: PoiRow = {
    id: state.next.pois++,
    provider: input.provider,
    provider_poi_id: input.providerId,
    name: input.name.trim(),
    category: input.category,
    subcategory: null,
    lat: input.lat,
    lon: input.lon,
    radius_m: input.radius,
    visitCount: input.seenTs === null ? 0 : 1,
    first_seen_ts: input.seenTs,
    last_seen_ts: input.seenTs,
    thoroughfare: input.thoroughfare,
    sub_thoroughfare: null,
    locality: null,
    sub_locality: null,
    administrative_area: null,
    postal_code: null,
    country: null
  };
  state.rows.pois.push(row);
  if (cacheKey) {
    state.poiCache.set(cacheKey, row.id);
  }
  return row.id;
}

function getOrCreateArcPoi(item: JsonObject, state: MutableState, firstSeen: number): number | null {
  const place = asObject(item.place);
  if (!place) {
    return null;
  }

  const mapboxId = stringValue(place.mapboxPlaceId);
  const placeId = stringValue(place.placeId);
  const provider = mapboxId ? "mapbox" : "arc";
  const providerId = mapboxId ?? placeId;
  const center = locationFrom(place.center) ?? locationFrom(place.location);
  const name = stringValue(place.name);
  if (!center || !name) {
    return null;
  }

  const radius = asObject(place.radius);
  return insertPoi(state, {
    provider,
    providerId,
    name,
    category: stringValue(place.mapboxCategory),
    lat: center.lat,
    lon: center.lon,
    radius: positiveNumber(numberValue(radius?.mean)),
    seenTs: firstSeen,
    thoroughfare: stringValue(place.streetAddress)
  });
}

function insertMove(
  state: MutableState,
  input: {
    start: number;
    end: number;
    mode: MoveMode;
    distance: number | null;
    tzOffset: number | null;
    provider: string;
  }
): MoveRow {
  const duplicate = state.rows.moves.find((move) => Math.abs(move.start_ts - input.start) < 0.000001 && Math.abs((move.end_ts ?? 0) - input.end) < 0.000001 && move.mode === input.mode);
  if (duplicate) {
    return duplicate;
  }

  const row: MoveRow = {
    id: state.next.moves++,
    start_ts: input.start,
    end_ts: input.end,
    mode: input.mode,
    distance_m: input.distance,
    tz_offset_s: input.tzOffset,
    provider: input.provider
  };
  state.rows.moves.push(row);
  return row;
}

function insertRoutePath(state: MutableState, moveId: number, coords: Array<[number, number]>, provider: string): RoutePathRow | null {
  const bounds = calculateBounds(coords);
  if (!bounds || coords.length < 2) {
    return null;
  }

  const row: RoutePathRow = {
    id: state.next.route_paths++,
    move_id: moveId,
    is_primary: 1,
    codec: "bqdc-v1",
    compression: "none",
    quantization_cm: 100,
    path_blob: encodeBQDCPath(coords),
    sample_count: coords.length,
    path_quality: "raw",
    provider,
    bbox_min_lat: bounds.minLat,
    bbox_min_lon: bounds.minLon,
    bbox_max_lat: bounds.maxLat,
    bbox_max_lon: bounds.maxLon,
    lod_level: 0
  };
  state.rows.route_paths.push(row);
  return row;
}

function importSamples(samples: JsonObject[], state: MutableState): void {
  const rawGPSRows: RawGPSRow[] = [];
  const sampleRows: SampleRow[] = [];
  const motionRows: RawMotionActivityRow[] = [];
  for (const sample of samples) {
    const location = asObject(sample.location) ?? sample;
    const point = locationFrom(location);
    const ts = parseImportTimestamp(stringValue(location?.timestamp) ?? stringValue(sample.date));
    if (!point || ts === null) {
      continue;
    }

    const altitude = numberValue(location?.altitude);
    const hAcc = nonNegative(numberValue(location?.horizontalAccuracy));
    const vAcc = nonNegative(numberValue(location?.verticalAccuracy));
    const speed = nonNegative(numberValue(location?.speed));
    const course = normalizeCourse(numberValue(location?.course));
    const tzOffset = numberValue(sample.secondsFromGMT);

    const rawGPS: RawGPSRow = {
      id: state.next.raw_gps++,
      ts,
      lat: point.lat,
      lon: point.lon,
      altitude_m: altitude,
      h_acc_m: hAcc,
      v_acc_m: vAcc,
      speed_mps: speed,
      speed_acc_mps: null,
      course_deg: course,
      course_acc_deg: null,
      tz_offset_s: tzOffset,
      provider: "unknown",
      is_simulated: 0
    };
    rawGPSRows.push(rawGPS);

    const sampleRow: SampleRow = {
      id: state.next.samples++,
      ts,
      lat: point.lat,
      lon: point.lon,
      altitude_m: altitude,
      speed_mps: speed,
      speed_acc_mps: null,
      course_deg: course,
      course_acc_deg: null,
      h_acc_m: hAcc,
      v_acc_m: vAcc,
      estimator: "raw",
      source_kind: "raw",
      flags: null,
      step_delta: null,
      tz_offset_s: tzOffset
    };
    sampleRows.push(sampleRow);

    const activity = stringValue(sample.coreMotionActivityType) ?? stringValue(sample.confirmedType);
    if (activity) {
      motionRows.push(makeMotionActivityRow(state, ts, activity, tzOffset));
    }
  }
  emitRows(state, "raw_gps", rawGPSRows);
  emitRows(state, "samples", sampleRows);
  emitRows(state, "raw_motion_activity", motionRows);
}

function makeMotionActivityRow(state: MutableState, ts: number, activity: string, tzOffset: number | null): RawMotionActivityRow {
  const key = activity.trim().toLowerCase();
  return {
    id: state.next.raw_motion_activity++,
    ts,
    confidence: 2,
    is_stationary: key === "stationary" ? 1 : 0,
    is_walking: key === "walking" || key === "walk" ? 1 : 0,
    is_running: key === "running" || key === "run" ? 1 : 0,
    is_automotive: key === "car" || key === "automotive" ? 1 : 0,
    is_cycling: key === "cycling" || key === "bicycle" ? 1 : 0,
    is_on_foot: key === "walking" || key === "walk" || key === "running" || key === "run" ? 1 : 0,
    is_unknown: key === "unknown" ? 1 : 0,
    tz_offset_s: tzOffset
  };
}

function importPedometerData(item: JsonObject, state: MutableState, tzOffset: number | null): void {
  const steps = nonNegative(numberValue(item.stepCount) ?? numberValue(item.hkStepCount));
  const floorsUp = nonNegative(numberValue(item.floorsAscended));
  const floorsDown = nonNegative(numberValue(item.floorsDescended));
  if (steps === null && floorsUp === null && floorsDown === null) {
    return;
  }

  const end = parseImportTimestamp(stringValue(item.endDate));
  if (end === null) {
    return;
  }

  const coords = coordinatesFromSamples(arrayValue(item.samples));
  const row: RawPedometerRow = {
    id: state.next.raw_pedometer++,
    ts: end,
    steps_delta: steps,
    distance_m: calculatePathDistance(coords),
    cadence_spm: null,
    pace_s_per_m: null,
    floors_up: floorsUp,
    floors_down: floorsDown,
    tz_offset_s: tzOffset
  };
  emitRows(state, "raw_pedometer", [row]);
}

function emitRows<T extends StreamableAuraTable>(state: MutableState, table: T, rows: StreamableAuraRows[T]): void {
  if (rows.length === 0) {
    return;
  }
  if (state.onRows) {
    state.onRows(table, rows);
    state.streamedCounts[table] += rows.length;
  } else if (table === "raw_gps") {
    state.rows.raw_gps.push(...rows as RawGPSRow[]);
  } else if (table === "samples") {
    state.rows.samples.push(...rows as SampleRow[]);
  } else if (table === "raw_motion_activity") {
    state.rows.raw_motion_activity.push(...rows as RawMotionActivityRow[]);
  } else {
    state.rows.raw_pedometer.push(...rows as RawPedometerRow[]);
  }
}

function coordinatesFromSamples(samples: JsonObject[]): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (const sample of samples) {
    const point = locationFrom(sample.location) ?? locationFrom(sample);
    if (point) {
      coords.push([point.lon, point.lat]);
    }
  }
  return coords;
}

function coordinatesFromTrackPoints(points: JsonObject[]): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (const point of points) {
    const lat = numberValue(point.lat);
    const lon = numberValue(point.lon);
    if (lat !== null && lon !== null && validLatLon(lat, lon)) {
      coords.push([lon, lat]);
    }
  }
  return coords;
}

function normalizeTimeline(state: MutableState, onProgress?: (progress: ImportProgress) => void): void {
  const refs = semanticRefs(state);
  const context = makeNormalizationContext();
  reportProgress(onProgress, "normalize", "Sorting timeline events", refs.length, refs.length);

  const normalized: SemanticRef[] = [];
  reportProgress(onProgress, "normalize", "Resolving timeline overlaps", 0, refs.length);
  for (const [index, ref] of refs.entries()) {
    if (!hasPositiveDuration(ref)) {
      removeSemanticRow(context, ref);
      continue;
    }
    normalizeOneRef(state, context, normalized, ref);
    if ((index + 1) % 500 === 0 || index + 1 === refs.length) {
      reportProgress(onProgress, "normalize", "Resolving timeline overlaps", index + 1, refs.length);
    }
  }

  reportProgress(onProgress, "normalize", "Merging adjacent timeline events", 0, normalized.length);
  mergeAdjacentTimelineEvents(state, context, normalized, onProgress);
  applyNormalizationContext(state, context);

  const beforeCleanup = state.rows.stays.length + state.rows.moves.length + state.rows.no_data_gaps.length;
  reportProgress(onProgress, "normalize", "Removing invalid timeline fragments", 0, beforeCleanup);
  removeInvalidRows(state);
  reportProgress(onProgress, "normalize", "Removing invalid timeline fragments", beforeCleanup, beforeCleanup);

  const afterCleanup = state.rows.stays.length + state.rows.moves.length + state.rows.no_data_gaps.length;
  reportProgress(onProgress, "normalize", "Inserting timeline gaps", 0, afterCleanup);
  insertGapsBetweenStays(state);
  reportProgress(onProgress, "normalize", "Inserting timeline gaps", afterCleanup, afterCleanup);
}

function makeNormalizationContext(): NormalizationContext {
  return {
    removedStayIds: new Set(),
    removedMoveIds: new Set(),
    removedGapIds: new Set(),
    stayRedirects: new Map()
  };
}

function normalizeOneRef(state: MutableState, context: NormalizationContext, normalized: SemanticRef[], ref: SemanticRef): void {
  let current: SemanticRef | null = ref;
  while (current) {
    const previous = normalized.at(-1);
    if (!previous) {
      normalized.push(current);
      return;
    }

    if (canMergeSemanticRows(previous, current) && touchesOrOverlaps(previous, current)) {
      mergeSemanticRows(state, context, previous, current);
      return;
    }

    const previousEnd = semanticEnd(previous);
    if (current.row.start_ts < previousEnd) {
      if (current.row.start_ts > previous.row.start_ts) {
        previous.row.end_ts = current.row.start_ts;
        recordDiagnostic(state, "Clipped overlapping timeline event");
        if (!hasPositiveDuration(previous)) {
          normalized.pop();
          removeSemanticRow(context, previous);
          continue;
        }
        normalized.push(current);
        return;
      }

      current.row.start_ts = previousEnd;
      recordDiagnostic(state, "Shifted overlapping timeline event");
      if (!hasPositiveDuration(current)) {
        removeSemanticRow(context, current);
        return;
      }
      continue;
    }

    if (canMergeSemanticRows(previous, current) && current.row.start_ts === previousEnd) {
      mergeSemanticRows(state, context, previous, current);
      return;
    }

    normalized.push(current);
    return;
  }
}

function mergeAdjacentTimelineEvents(
  state: MutableState,
  context: NormalizationContext,
  refs: SemanticRef[],
  onProgress?: (progress: ImportProgress) => void
): void {
  const merged: SemanticRef[] = [];
  for (const [index, ref] of refs.entries()) {
    if (isRemoved(context, ref) || !hasPositiveDuration(ref)) {
      removeSemanticRow(context, ref);
      continue;
    }
    const previous = merged.at(-1);
    if (previous && canMergeSemanticRows(previous, ref) && ref.row.start_ts === semanticEnd(previous)) {
      mergeSemanticRows(state, context, previous, ref);
    } else {
      merged.push(ref);
    }
    if ((index + 1) % 500 === 0 || index + 1 === refs.length) {
      reportProgress(onProgress, "normalize", "Merging adjacent timeline events", index + 1, refs.length);
    }
  }
  if (refs.length === 0) {
    reportProgress(onProgress, "normalize", "Merging adjacent timeline events", 0, 0);
  }
}

function semanticRefs(state: MutableState): SemanticRef[] {
  const refs: SemanticRef[] = [];
  for (const row of state.rows.stays) {
    refs.push({ kind: "stay", row });
  }
  for (const row of state.rows.moves) {
    refs.push({ kind: "move", row });
  }
  for (const row of state.rows.no_data_gaps) {
    refs.push({ kind: "gap", row });
  }
  return refs.sort((lhs, rhs) => {
    if (lhs.row.start_ts !== rhs.row.start_ts) {
      return lhs.row.start_ts - rhs.row.start_ts;
    }
    const order = { move: 0, gap: 1, stay: 2 };
    return order[lhs.kind] - order[rhs.kind];
  });
}

function mergeSemanticRows(state: MutableState, context: NormalizationContext, target: SemanticRef, source: SemanticRef): void {
  target.row.end_ts = target.row.end_ts === null || source.row.end_ts === null ? null : Math.max(target.row.end_ts, source.row.end_ts);
  if (target.kind === "stay" && source.kind === "stay") {
    context.removedStayIds.add(source.row.id);
    context.stayRedirects.set(source.row.id, target.row.id);
  } else if (target.kind === "gap" && source.kind === "gap") {
    context.removedGapIds.add(source.row.id);
  }
  recordDiagnostic(state, `Merged adjacent ${target.kind} events`);
}

function canMergeSemanticRows(lhs: SemanticRef, rhs: SemanticRef): boolean {
  if (lhs.kind !== rhs.kind) {
    return false;
  }
  return lhs.kind === "stay" || lhs.kind === "gap";
}

function touchesOrOverlaps(lhs: SemanticRef, rhs: SemanticRef): boolean {
  return rhs.row.start_ts <= semanticEnd(lhs);
}

function semanticEnd(ref: SemanticRef): number {
  return ref.row.end_ts ?? Number.POSITIVE_INFINITY;
}

function hasPositiveDuration(ref: SemanticRef): boolean {
  return ref.row.end_ts === null || ref.row.end_ts > ref.row.start_ts;
}

function removeSemanticRow(context: NormalizationContext, ref: SemanticRef): void {
  if (ref.kind === "stay") {
    context.removedStayIds.add(ref.row.id);
  } else if (ref.kind === "move") {
    context.removedMoveIds.add(ref.row.id);
  } else {
    context.removedGapIds.add(ref.row.id);
  }
}

function isRemoved(context: NormalizationContext, ref: SemanticRef): boolean {
  if (ref.kind === "stay") {
    return context.removedStayIds.has(ref.row.id);
  }
  if (ref.kind === "move") {
    return context.removedMoveIds.has(ref.row.id);
  }
  return context.removedGapIds.has(ref.row.id);
}

function applyNormalizationContext(state: MutableState, context: NormalizationContext): void {
  state.rows.stays = state.rows.stays.filter((row) => !context.removedStayIds.has(row.id) && (row.end_ts === null || row.end_ts > row.start_ts));
  state.rows.moves = state.rows.moves.filter((row) => !context.removedMoveIds.has(row.id) && (row.end_ts === null || row.end_ts > row.start_ts));
  state.rows.no_data_gaps = state.rows.no_data_gaps.filter((row) => !context.removedGapIds.has(row.id) && (row.end_ts === null || row.end_ts > row.start_ts));

  const validStayIds = new Set(state.rows.stays.map((row) => row.id));
  const validMoveIds = new Set(state.rows.moves.map((row) => row.id));

  const stayPoiKeys = new Set<string>();
  const stayPois: StayPoiRow[] = [];
  for (const row of state.rows.stay_pois) {
    const stayId = redirectedId(context.stayRedirects, row.stay_id);
    if (!validStayIds.has(stayId)) {
      continue;
    }
    row.stay_id = stayId;
    const key = `${row.stay_id}:${row.poi_id}:${row.role}`;
    if (!stayPoiKeys.has(key)) {
      stayPoiKeys.add(key);
      stayPois.push(row);
    }
  }
  state.rows.stay_pois = stayPois;

  const primaryMoveIds = new Set<number>();
  const routePaths: RoutePathRow[] = [];
  for (const row of state.rows.route_paths) {
    if (!validMoveIds.has(row.move_id)) {
      continue;
    }
    if (row.is_primary === 1) {
      if (primaryMoveIds.has(row.move_id)) {
        row.is_primary = 0;
      } else {
        primaryMoveIds.add(row.move_id);
      }
    }
    routePaths.push(row);
  }
  state.rows.route_paths = routePaths;
}

function redirectedId(redirects: Map<number, number>, id: number): number {
  let current = id;
  while (redirects.has(current)) {
    current = redirects.get(current)!;
  }
  return current;
}

function removeInvalidRows(state: MutableState): void {
  const validStayIds = new Set(state.rows.stays.filter((row) => row.end_ts === null || row.end_ts > row.start_ts).map((row) => row.id));
  const validMoveIds = new Set(state.rows.moves.filter((row) => row.end_ts === null || row.end_ts > row.start_ts).map((row) => row.id));
  const validGapIds = new Set(state.rows.no_data_gaps.filter((row) => row.end_ts === null || row.end_ts > row.start_ts).map((row) => row.id));
  const removed = state.rows.stays.length - validStayIds.size + state.rows.moves.length - validMoveIds.size + state.rows.no_data_gaps.length - validGapIds.size;
  state.rows.stays = state.rows.stays.filter((row) => validStayIds.has(row.id));
  state.rows.moves = state.rows.moves.filter((row) => validMoveIds.has(row.id));
  state.rows.no_data_gaps = state.rows.no_data_gaps.filter((row) => validGapIds.has(row.id));
  state.rows.stay_pois = state.rows.stay_pois.filter((row) => validStayIds.has(row.stay_id));
  state.rows.route_paths = state.rows.route_paths.filter((row) => validMoveIds.has(row.move_id));
  if (removed > 0) {
    recordDiagnostic(state, `Removed ${removed} non-positive duration events`);
  }
}

function insertGapsBetweenStays(state: MutableState): void {
  const refs = semanticRefs(state);
  for (let index = 1; index < refs.length; index += 1) {
    const previous = refs[index - 1]!;
    const current = refs[index]!;
    if (previous.kind !== "stay" || current.kind !== "stay" || previous.row.end_ts === null || current.row.start_ts <= previous.row.end_ts) {
      continue;
    }
    const row: NoDataGapRow = {
      id: state.next.no_data_gaps++,
      start_ts: previous.row.end_ts,
      end_ts: current.row.start_ts,
      reason: "Unknown",
      uncertainty: null,
      notes: "generated_between_stays"
    };
    state.rows.no_data_gaps.push(row);
  }
}

function makeReport(
  state: MutableState,
  fileCount: number,
  sourceTypes: SourceType[],
  onProgress?: (progress: ImportProgress) => void
): ImportReport {
  const counts = Object.fromEntries(
    Object.entries(state.rows).map(([key, rows]) => [key, rows.length + (key in state.streamedCounts ? state.streamedCounts[key as StreamableAuraTable] : 0)])
  ) as Record<keyof AuraRows, number>;
  const semanticCount = state.rows.stays.length + state.rows.moves.length + state.rows.no_data_gaps.length;
  reportProgress(onProgress, "report", "Summarizing timeline report", 0, semanticCount);
  const dateRange = summarizeDateRange(state, onProgress, semanticCount);
  reportProgress(onProgress, "report", "Import report ready", semanticCount, semanticCount);

  return {
    sourceTypes,
    userVersion: getLatestSchemaVersion(),
    fileCount,
    dateRange,
    counts,
    diagnostics: reportDiagnostics(state)
  };
}

function summarizeDateRange(
  state: MutableState,
  onProgress?: (progress: ImportProgress) => void,
  total = 0
): ImportReport["dateRange"] {
  let startTs = Number.POSITIVE_INFINITY;
  let endTs = Number.NEGATIVE_INFINITY;
  let completed = 0;
  const include = (value: number | null): void => {
    if (typeof value !== "number") {
      return;
    }
    if (value < startTs) {
      startTs = value;
    }
    if (value > endTs) {
      endTs = value;
    }
  };

  for (const row of state.rows.stays) {
    include(row.start_ts);
    include(row.end_ts);
    completed += 1;
    if (completed % 500 === 0 || completed === total) {
      reportProgress(onProgress, "report", "Summarizing timeline report", completed, total);
    }
  }
  for (const row of state.rows.moves) {
    include(row.start_ts);
    include(row.end_ts);
    completed += 1;
    if (completed % 500 === 0 || completed === total) {
      reportProgress(onProgress, "report", "Summarizing timeline report", completed, total);
    }
  }
  for (const row of state.rows.no_data_gaps) {
    include(row.start_ts);
    include(row.end_ts);
    completed += 1;
    if (completed % 500 === 0 || completed === total) {
      reportProgress(onProgress, "report", "Summarizing timeline report", completed, total);
    }
  }

  return Number.isFinite(startTs) && Number.isFinite(endTs) ? { startTs, endTs } : null;
}

function reportProgress(
  onProgress: ((progress: ImportProgress) => void) | undefined,
  phase: ImportProgress["phase"],
  message: string,
  completed: number,
  total: number
): void {
  onProgress?.({
    phase,
    message,
    completed,
    total: Math.max(total, completed, 1)
  });
}

function recordDiagnostic(state: MutableState, message: string): void {
  const count = state.diagnosticCounts.get(message) ?? 0;
  state.diagnosticCounts.set(message, count + 1);
  if (count === 0 && state.diagnostics.length < diagnosticSampleLimit) {
    state.diagnostics.push(message);
  }
}

function reportDiagnostics(state: MutableState): string[] {
  const summaries: string[] = [];
  for (const [message, count] of state.diagnosticCounts) {
    if (count > 1) {
      summaries.push(`${message} (${count.toLocaleString()} times)`);
    }
  }
  return [...state.diagnostics, ...summaries].slice(0, diagnosticSampleLimit);
}

function validWindow(start: number, end: number): boolean {
  return start > 0 && end > start;
}

function positiveNumber(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function nonNegative(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null;
}

function normalizeCourse(value: number | null): number | null {
  if (value === null || value < 0) {
    return null;
  }
  return value >= 360 ? value % 360 : value;
}
