import { getLatestSchemaVersion } from "@aura-importer/aura-schema";
import { encodeBQDCPath } from "./bqdc.js";
import {
  defaultBqdcQuantizationCm,
  defaultStayRadiusM,
  diagnosticSampleLimit,
  duplicateTimestampToleranceS,
  evidenceKey,
  fragmentGapThresholdS,
  fragmentGroupSize,
  fragmentInvalidDurationRatio,
  fragmentMedianDurationThresholdS,
  maximumObservationExtensionS,
  maximumObservationGapS,
  maximumPedometerMetersPerStep,
  maximumReconstructedStayRadiusM,
  maximumSemanticRouteSpeedMps,
  minimumGeometryOnlyMoveSpeedMps,
  minimumPedometerMetersPerStep,
  minimumReconstructedMoveDistanceM,
  minimumReconstructedStayRadiusM,
  movesLastServiceDayEndTs,
  progressReportInterval,
  provider as providers,
  routePointDuplicateTimestampDistanceM,
  sourceOrder,
  stayMatchingBufferM,
  stayUncertaintyGapS,
  timelineNote,
  trustedFragmentDurationS,
} from "./constants.js";
import { EvidenceLedger, type ObservationEvidence } from "./evidenceLedger.js";
import { calculateBounds, calculatePathDistance, haversineDistance, validLatLon } from "./geo.js";
import { type StreamedJsonShape, streamJsonValues } from "./jsonStream.js";
import { mapActivityType } from "./modes.js";
import { arcBackupFileKind, classifySourcePath } from "./sourceSelection.js";
import { extractTimezoneOffsetSeconds, parseImportTimestamp } from "./time.js";
import { verifyTimelineIntegrity } from "./timelineIntegrity.js";
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
  RawVisitRow,
  RoutePathRow,
  SampleRow,
  SourceType,
  StayPoiRow,
  StayRow,
  StreamableAuraRows,
  StreamableAuraTable,
  TimelineIntegritySummary,
} from "./types.js";

type JsonObject = Record<string, unknown>;

type MutableState = {
  rows: AuraRows;
  next: Record<keyof Omit<AuraRows, "stay_pois">, number>;
  poiCache: Map<string, number>;
  poiRevisions: Map<number, number>;
  arcPlaces: Map<
    string,
    { center: { lat: number; lon: number }; radius: number | null; timezoneOffset: number | null }
  >;
  itemMap: Map<string, { kind: "stay" | "move"; ids: number[] }>;
  moveIndex: Map<string, MoveRow[]>;
  movesPedometerKeys: Set<string>;
  pedometerClaims: PedometerClaim[];
  movesSummaryStepTotals: Map<string, number>;
  pendingMovesStays: Map<string, StayRow[]>;
  movesPoiIdentityRanks: Map<number, number>;
  movesPlaceAliases: Map<string, { id: string; rank: number }>;
  rawVisitKeys: Set<string>;
  semanticEvidence: Map<string, SemanticEvidence>;
  routeEvidence: Map<number, RouteEvidence>;
  diagnostics: string[];
  diagnosticCounts: Map<string, number>;
  streamedCounts: Record<StreamableAuraTable, number>;
  onRows?: <T extends StreamableAuraTable>(table: T, rows: StreamableAuraRows[T]) => void;
};

type TimedRoutePoint = {
  coord: [number, number];
  ts: number | null;
};

type PreparedRoute = {
  points: TimedRoutePoint[];
  pathQuality: "raw" | "filtered";
};

type RouteEvidence = {
  points: TimedRoutePoint[];
  provider: string;
  pathQuality: PreparedRoute["pathQuality"];
};

type SemanticRef = {
  kind: "stay" | "move" | "gap";
  row: StayRow | MoveRow | NoDataGapRow;
  quality: number;
  manual: boolean;
  revision: number;
  source: SemanticEvidence["source"];
};

type SemanticEvidence = {
  manual: boolean;
  revision: number;
  source: "arc" | "moves" | "generated" | "unknown";
};

type ReplacedStayEvidence = {
  poiId: number | null;
  radius: number;
  type: StayRow["type"];
  distance: number;
};

type PedometerClaim = {
  source: "arc" | "moves";
  kind: "stay" | "move" | "leaf" | "summary";
  dayKey: string | null;
  start: number | null;
  end: number;
  steps: number | null;
  distance: number | null;
  floorsUp: number | null;
  floorsDown: number | null;
  timezoneOffset: number | null;
  manual: boolean;
  sequence: number | null;
  mode: string | null;
};

type NormalizationContext = {
  removedStayIds: Set<number>;
  removedMoveIds: Set<number>;
  removedGapIds: Set<number>;
  invalidatedMoveIds: Set<number>;
  stayRedirects: Map<number, number>;
};

type ClassifyProbe = {
  kind: SourceType | null;
  usable: boolean;
};

type ClassifiedFile = {
  path: string;
  size: number;
  readData: () => Promise<Uint8Array>;
  readChunks?: () => AsyncIterable<Uint8Array>;
};

type ConversionOptions = {
  onProgress?: (progress: ImportProgress) => void;
  onRows?: <T extends StreamableAuraTable>(table: T, rows: StreamableAuraRows[T]) => void;
  signal?: AbortSignal;
};

type ReadTracker = {
  readValues: (
    file: ClassifiedFile,
    onValue: (value: unknown, shape: StreamedJsonShape) => boolean | undefined,
  ) => Promise<StreamedJsonShape>;
};

type ArcItemCandidate = {
  path: string;
  source: "export" | "backup";
  item: JsonObject;
  sampleCount: number;
};

type ArcItemScore = readonly [number, number, number, number, number, number, number];

const arcRevisionSemanticFields = new Set([
  "activityType",
  "activityTypeConfidenceScore",
  "confirmedType",
  "manualActivityType",
  "uncertainActivityType",
  "unknownActivityType",
]);

type MovesDayCandidate = {
  path: string;
  day: JsonObject;
  fingerprint: string;
};

type MovesSegmentCandidate = {
  value: JsonObject;
  revision: number;
};

type MovesActivityCandidate = {
  value: JsonObject;
  revision: number;
};

type HistoryEvidence = {
  arcItems: Map<string, ArcItemCandidate[]>;
  arcItemTombstones: Map<string, number>;
  arcPlaces: Map<string, JsonObject[]>;
  arcPlaceTombstones: Map<string, number>;
  arcCoverage: JsonObject[];
  detected: Set<SourceType>;
  validFileCount: number;
  firstError: Error | null;
};

class HistoryInputError extends Error {}

export async function scanImportEntries(
  entries: ImportFileHandle[],
  options: { signal?: AbortSignal; onProgress?: (progress: ImportProgress) => void } = {},
): Promise<ImportScan> {
  const detected = new Set<SourceType>();
  let supportedFileCount = 0;
  for (const [index, entry] of entries.entries()) {
    throwIfAborted(options.signal);
    options.onProgress?.({
      phase: "scan",
      message: `Scanning ${entry.path}`,
      completed: index,
      total: entries.length,
    });
    if (isJsonPath(entry.path)) {
      try {
        const probe = await classifyJsonEntry(entry, options.signal);
        if (probe.kind) {
          detected.add(probe.kind);
        }
        if (probe.usable) {
          supportedFileCount += 1;
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
      }
    }
    options.onProgress?.({
      phase: "scan",
      message: `Scanned ${entry.path}`,
      completed: index + 1,
      total: entries.length,
    });
  }
  return {
    sourceTypes: sourceOrder.filter((source) => detected.has(source)),
    fileCount: entries.length,
    supportedFileCount,
    unknownFileCount: entries.length - supportedFileCount,
  };
}

async function classifyJsonEntry(entry: ImportFileHandle, signal?: AbortSignal): Promise<ClassifyProbe> {
  const pathKind = classifySourcePath(entry.path);
  if (pathKind && arcBackupFileKind(entry.path) !== "range-summary") {
    return { kind: pathKind, usable: true };
  }
  let kind: SourceType | null = null;
  let usable = false;
  try {
    await streamJsonValues(
      entry.path,
      importFileChunks(entry),
      (value, shape) => {
        const candidateKind = shape === "timeline-items" ? "arc-export" : classifySource(value);
        if (!candidateKind) {
          return false;
        }
        kind = candidateKind;
        if (shape === "timeline-items" || !isArcRangeSummary(asObject(value) ?? {})) {
          usable = true;
          return true;
        }
        return false;
      },
      { signal },
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { kind: null, usable: false };
  }
  return { kind, usable };
}

export async function convertImportEntries(
  entries: ImportFileEntry[],
  options: ConversionOptions = {},
): Promise<ConversionResult> {
  return convertImportFileHandles(
    entries.map((entry) => ({
      path: entry.path,
      size: entry.size ?? entry.data.byteLength,
      readData: async () => entry.data,
    })),
    options,
  );
}

export async function convertImportFileHandles(
  entries: ImportFileHandle[],
  options: ConversionOptions = {},
): Promise<ConversionResult> {
  throwIfAborted(options.signal);
  const state = makeState(options.onRows);
  const files: ClassifiedFile[] = [...entries]
    .filter((entry) => isJsonPath(entry.path))
    .sort((lhs, rhs) => compareStableStrings(lhs.path, rhs.path))
    .map((entry) => ({
      path: entry.path,
      size: entry.size,
      readData: entry.readData,
      readChunks: entry.readChunks,
    }));
  const tracker = makeReadTracker(files, options.onProgress, options.signal);
  const ledger = await EvidenceLedger.create();
  let evidence: HistoryEvidence;
  try {
    evidence = await collectHistoryEvidence(files, state, tracker, ledger, options.signal);
    throwIfAborted(options.signal);
    if (evidence.validFileCount === 0) {
      if (evidence.arcCoverage.length > 0) {
        throw new Error("Arc TimelineRangeSummary metadata was found, but it contains no timeline records to convert");
      }
      throw evidence.firstError ?? new Error("No supported Arc or Moves history was found");
    }
    fuseMovesEvidence(ledger, options.signal);
    ledger.seal();
    materializeArcEvidence(evidence, ledger, state, options.signal);
    ledger.forEachFusedMovesDay((day) => {
      throwIfAborted(options.signal);
      materializeMovesEvidence([day], state);
    });
    materializePedometerClaims(state, options.signal);
    materializeArcObservations(ledger, state, options.signal);
  } finally {
    await ledger.close();
  }

  throwIfAborted(options.signal);
  normalizeTimeline(state, options.onProgress, options.signal);
  assertNonEmptyConversion(state);
  const timelineIntegrity = verifyTimelineIntegrity(state.rows);
  const report = makeReport(
    state,
    entries.length,
    sourceOrder.filter((source) => evidence.detected.has(source)),
    timelineIntegrity,
    options.onProgress,
    options.signal,
  );
  return { rows: state.rows, report };
}

function makeReadTracker(
  files: ClassifiedFile[],
  onProgress: ConversionOptions["onProgress"],
  signal?: AbortSignal,
): ReadTracker {
  const total = files.length;
  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  let bytesCompleted = 0;

  return {
    readValues: async (file, onValue) => {
      throwIfAborted(signal);
      onProgress?.({
        phase: "read",
        message: `Reading ${file.path}`,
        completed,
        total,
        bytesCompleted,
        bytesTotal,
      });
      const shape = await streamJsonValues(file.path, importFileChunks(file), onValue, { signal });
      throwIfAborted(signal);
      completed += 1;
      bytesCompleted += file.size;
      onProgress?.({
        phase: "parse",
        message: `Parsed ${file.path}`,
        completed,
        total,
        bytesCompleted,
        bytesTotal,
      });
      return shape;
    },
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
      no_data_gaps: [],
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
      no_data_gaps: 1,
    },
    poiCache: new Map(),
    poiRevisions: new Map(),
    arcPlaces: new Map(),
    itemMap: new Map(),
    moveIndex: new Map(),
    movesPedometerKeys: new Set(),
    pedometerClaims: [],
    movesSummaryStepTotals: new Map(),
    pendingMovesStays: new Map(),
    movesPoiIdentityRanks: new Map(),
    movesPlaceAliases: new Map(),
    rawVisitKeys: new Set(),
    semanticEvidence: new Map(),
    routeEvidence: new Map(),
    diagnostics: [],
    diagnosticCounts: new Map(),
    streamedCounts: {
      raw_gps: 0,
      samples: 0,
      raw_motion_activity: 0,
      raw_pedometer: 0,
    },
    onRows,
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
    if (stringValue(object.sampleId) !== null) {
      return "arc-backup";
    }
    if (stringValue(object.placeId) !== null) {
      return "arc-backup";
    }
    if (isArcRangeSummary(object)) {
      return "arc-backup";
    }
    if (movesDayLooksLikeExport(object)) {
      return "moves-export";
    }
    if (observationEvidence(object, null) !== null) {
      return "arc-backup";
    }
  }
  if (Array.isArray(json)) {
    const items = arrayValue(json);
    if (items.some(movesDayLooksLikeExport)) {
      return "moves-export";
    }
    if (items.some((item) => observationEvidence(item, null) !== null)) {
      return "arc-backup";
    }
  }
  return null;
}

function movesDayLooksLikeExport(day: JsonObject): boolean {
  if (stringValue(day.date) === null) {
    return false;
  }
  const segments = arrayValue(day.segments);
  return segments.some(isUsableMovesSegment) || arrayValue(day.summary).some(isUsableMovesSummary);
}

function isUsableMovesSegment(segment: JsonObject): boolean {
  if (stringValue(segment.startTime) === null || stringValue(segment.endTime) === null) {
    return false;
  }
  const type = stringValue(segment.type);
  if (type === "place") {
    const place = asObject(segment.place);
    return (
      locationFrom(place?.location) !== null ||
      placeIdentifier(place) !== null ||
      meaningfulName(place?.name) !== null ||
      stringValue(place?.type) === "home" ||
      stringValue(place?.type) === "work" ||
      arrayValue(segment.activities).length > 0
    );
  }
  return type === "move" || type === "off";
}

function isUsableMovesSummary(summary: JsonObject): boolean {
  return (
    stringValue(summary.activity) !== null &&
    [summary.steps, summary.distance, summary.duration].some((value) => nonNegative(numberValue(value)) !== null)
  );
}

function placeIdentifier(value: unknown): string | null {
  const object = asObject(value);
  if (!object) {
    return null;
  }
  return movesPlaceIdentity(object).id;
}

function identifierValue(value: unknown): string | null {
  return stringValue(value) ?? numberValue(value)?.toString() ?? null;
}

function movesPlaceIdentity(place: JsonObject): { id: string | null; rank: number; aliases: string[] } {
  const temporaryId = identifierValue(place.id);
  const facebookId = identifierValue(place.facebookPlaceId);
  const foursquareId = identifierValue(place.foursquareId);
  const id = facebookId ?? foursquareId ?? temporaryId;
  return {
    id,
    rank: facebookId ? 3 : foursquareId ? 2 : temporaryId ? 1 : 0,
    aliases: [...new Set([id, temporaryId].filter((value): value is string => value !== null))],
  };
}

function canonicalMovesPlaceIdentity(
  state: MutableState,
  identity: { id: string | null; rank: number; aliases: string[] },
): { id: string | null; rank: number; aliases: string[] } {
  let id = identity.id;
  let rank = identity.rank;
  const aliases = new Set(identity.aliases);
  for (const alias of identity.aliases) {
    const known = state.movesPlaceAliases.get(alias);
    if (known) {
      aliases.add(known.id);
      if (known.rank > rank) {
        id = known.id;
        rank = known.rank;
      }
    }
  }
  if (id) {
    aliases.add(id);
    for (const alias of aliases) {
      state.movesPlaceAliases.set(alias, { id, rank });
    }
  }
  return { id, rank, aliases: [...aliases] };
}

function isArcRangeSummary(value: JsonObject): boolean {
  const range = asObject(value.dateRange);
  return range !== null && stringValue(range.start) !== null && nonNegative(numberValue(range.duration)) !== null;
}

function isJsonPath(path: string): boolean {
  const lowercased = path.toLowerCase();
  return lowercased.endsWith(".json") || lowercased.endsWith(".json.gz");
}

async function* importFileChunks(file: Pick<ClassifiedFile, "readData" | "readChunks">): AsyncGenerator<Uint8Array> {
  if (file.readChunks) {
    yield* file.readChunks();
  } else {
    yield await file.readData();
  }
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

async function collectHistoryEvidence(
  files: ClassifiedFile[],
  state: MutableState,
  tracker: ReadTracker,
  ledger: EvidenceLedger,
  signal?: AbortSignal,
): Promise<HistoryEvidence> {
  const evidence = makeHistoryEvidence();

  for (const file of files) {
    throwIfAborted(signal);
    const fileEvidence = makeHistoryEvidence();
    let validRecordCount = 0;
    let fileError: Error | null = null;
    let infrastructureError: unknown = null;
    let parsedSuccessfully = false;
    ledger.beginFile();
    try {
      const shape = await tracker.readValues(file, (value, shape) => {
        throwIfAborted(signal);
        const kind =
          shape === "timeline-items" ? "arc-export" : (classifySource(value) ?? classifySourcePath(file.path));
        if (!kind) {
          return false;
        }
        try {
          const usable = ingestHistoryValue(kind, shape, value, file.path, fileEvidence, ledger);
          fileEvidence.detected.add(kind);
          if (usable) {
            validRecordCount += 1;
          }
        } catch (error) {
          if (!(error instanceof HistoryInputError)) {
            infrastructureError = error;
            throw error;
          }
          const wrapped = historyFileError(file.path, error);
          fileError ??= wrapped;
          recordDiagnostic(state, wrapped.message);
        }
        return false;
      });
      if (validRecordCount === 0 && (shape === "timeline-items" || classifySourcePath(file.path))) {
        fileError ??= historyFileError(file.path, new Error("History file contains no usable records"));
      }
      ledger.commitFile();
      parsedSuccessfully = true;
    } catch (error) {
      ledger.rollbackFile();
      if (isAbortError(error)) {
        throw error;
      }
      if (infrastructureError !== null) {
        throw infrastructureError;
      }
      const wrapped = historyFileError(file.path, error);
      fileError ??= wrapped;
      recordDiagnostic(state, wrapped.message);
    }
    if (parsedSuccessfully) {
      fileEvidence.validFileCount = validRecordCount > 0 ? 1 : 0;
      fileEvidence.firstError = validRecordCount > 0 ? null : fileError;
      mergeHistoryEvidence(evidence, fileEvidence);
    } else if (fileError) {
      evidence.firstError ??= fileError;
    }
  }

  return evidence;
}

function makeHistoryEvidence(): HistoryEvidence {
  return {
    arcItems: new Map(),
    arcItemTombstones: new Map(),
    arcPlaces: new Map(),
    arcPlaceTombstones: new Map(),
    arcCoverage: [],
    detected: new Set(),
    validFileCount: 0,
    firstError: null,
  };
}

function mergeHistoryEvidence(target: HistoryEvidence, source: HistoryEvidence): void {
  appendCandidateMaps(target.arcItems, source.arcItems);
  appendCandidateMaps(target.arcPlaces, source.arcPlaces);
  mergeTombstones(target.arcItemTombstones, source.arcItemTombstones);
  mergeTombstones(target.arcPlaceTombstones, source.arcPlaceTombstones);
  target.arcCoverage.push(...source.arcCoverage);
  for (const kind of source.detected) {
    target.detected.add(kind);
  }
  target.validFileCount += source.validFileCount;
  target.firstError ??= source.firstError;
}

function appendCandidateMaps<T>(target: Map<string, T[]>, source: Map<string, T[]>): void {
  for (const [key, candidates] of source) {
    const existing = target.get(key) ?? [];
    existing.push(...candidates);
    target.set(key, existing);
  }
}

function mergeTombstones(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, revision] of source) {
    target.set(key, Math.max(target.get(key) ?? Number.NEGATIVE_INFINITY, revision));
  }
}

function ingestHistoryValue(
  kind: SourceType,
  shape: StreamedJsonShape,
  value: unknown,
  path: string,
  evidence: HistoryEvidence,
  ledger: EvidenceLedger,
): boolean {
  if (kind === "arc-export") {
    if (shape === "timeline-items") {
      const item = asObject(value);
      if (!item) {
        throw new HistoryInputError("Arc export timelineItems must contain objects");
      }
      validateArcTimelineItem(item);
      addArcItemCandidate(item, path, "export", evidence, ledger);
    } else {
      ingestArcExport(value, path, evidence, ledger);
    }
    return true;
  } else if (kind === "arc-backup") {
    return ingestArcBackup(value, path, evidence, ledger);
  } else {
    ingestMovesExport(value, path, ledger);
    return true;
  }
}

function ingestArcExport(value: unknown, path: string, evidence: HistoryEvidence, ledger: EvidenceLedger): void {
  for (const item of arcExportItems(value)) {
    addArcItemCandidate(item, path, "export", evidence, ledger);
  }
}

function ingestArcBackup(value: unknown, path: string, evidence: HistoryEvidence, ledger: EvidenceLedger): boolean {
  const object = asObject(value);
  if (object && isArcRangeSummary(object)) {
    evidence.arcCoverage.push(object);
    return false;
  }
  if (object && stringValue(object.itemId)) {
    if (object.deleted === true) {
      recordTombstone(evidence.arcItemTombstones, `id:${stringValue(object.itemId)!}`, object);
    } else {
      addArcItemCandidate(object, path, "backup", evidence, ledger);
    }
    return true;
  }
  if (object && stringValue(object.placeId)) {
    const placeId = stringValue(object.placeId)!;
    if (object.deleted === true) {
      recordTombstone(evidence.arcPlaceTombstones, placeId, object);
      return true;
    }
    const candidates = evidence.arcPlaces.get(placeId) ?? [];
    candidates.push(object);
    evidence.arcPlaces.set(placeId, candidates);
    return true;
  }
  if (object?.deleted === true && stringValue(object.sampleId)) {
    ledger.addTombstone(stringValue(object.sampleId)!, tombstoneRevision(object));
    return true;
  }
  if (object?.deleted === true) {
    return true;
  }
  if (object && observationEvidence(object, null)) {
    if (object.deleted !== true) {
      addArcObservation(object, null, ledger);
    }
    return true;
  }
  if (Array.isArray(value)) {
    const samples = value.map(asObject);
    if (samples.some((sample) => sample === null)) {
      throw new HistoryInputError("Arc LocomotionSample array must contain objects");
    }
    for (const sample of samples as JsonObject[]) {
      const sampleId = stringValue(sample.sampleId);
      if (sample.deleted === true && sampleId) {
        ledger.addTombstone(sampleId, tombstoneRevision(sample));
      } else if (sample.deleted !== true) {
        addArcObservation(sample, null, ledger);
      }
    }
    return samples.length > 0;
  }
  throw new HistoryInputError("Unsupported Arc backup content");
}

function ingestMovesExport(value: unknown, path: string, ledger: EvidenceLedger): void {
  const days = Array.isArray(value)
    ? value.map(asObject).filter((item): item is JsonObject => item !== null)
    : [asObject(value)].filter((item): item is JsonObject => item !== null);
  if (days.length === 0 || (Array.isArray(value) && days.length !== value.length)) {
    throw new HistoryInputError("Moves export must contain day objects");
  }
  for (const day of days) {
    const normalized = normalizeMovesDay(day);
    const date = stringValue(normalized.date)!;
    const fingerprint = fingerprintJson(normalized);
    ledger.addMovesDayCandidate(date, path, fingerprint, canonicalJson(normalized));
  }
}

function addArcItemCandidate(
  item: JsonObject,
  path: string,
  source: ArcItemCandidate["source"],
  evidence: HistoryEvidence,
  ledger: EvidenceLedger,
): void {
  const key = arcItemKey(item);
  if (!key) {
    throw new HistoryInputError("Arc timeline item has no stable identity");
  }
  const samples = arrayValue(item.samples);
  const itemId = stringValue(item.itemId);
  for (const sample of samples) {
    addArcObservation(sample, itemId ?? key, ledger);
  }
  const semanticItem: JsonObject = { ...item, samples: [] };
  if (numberValue(semanticItem.secondsFromGMT) === null) {
    semanticItem.secondsFromGMT = numberValue(samples[0]?.secondsFromGMT);
  }
  const candidates = evidence.arcItems.get(key) ?? [];
  candidates.push({
    path,
    source,
    item: semanticItem,
    sampleCount: samples.length,
  });
  evidence.arcItems.set(key, candidates);
}

function addArcObservation(sample: JsonObject, parentItemId: string | null, ledger: EvidenceLedger): void {
  const observation = observationEvidence(sample, parentItemId);
  if (observation) {
    ledger.addObservation(observation);
  }
}

function observationEvidence(sample: JsonObject, parentItemId: string | null): ObservationEvidence | null {
  const location = asObject(sample.location) ?? sample;
  const point = locationFrom(location);
  const ts = parseImportTimestamp(stringValue(location.timestamp) ?? stringValue(sample.date));
  const sampleId = stringValue(sample.sampleId);
  const timelineItemId = stringValue(sample.timelineItemId) ?? parentItemId;
  const horizontalAccuracy = nonNegative(numberValue(location.horizontalAccuracy));
  const locationValues = [
    location.altitude,
    location.horizontalAccuracy,
    location.verticalAccuracy,
    location.speed,
    location.speedAccuracy,
    location.course,
    location.courseAccuracy,
  ].filter((value) => numberValue(value) !== null).length;
  const confirmed = stringValue(sample.confirmedType);
  const coreMotion = stringValue(sample.coreMotionActivityType);
  const movingState = stringValue(sample.movingState);
  const activity = confirmed ?? coreMotion ?? movingState;
  const activityRank = confirmed ? 3 : coreMotion ? 2 : movingState ? 1 : 0;
  if (ts === null || ts < 0 || (!point && !activity)) {
    return null;
  }
  const identity = sampleId
    ? `id:${sampleId}`
    : point
      ? `observation:${ts.toFixed(3)}:${point.lat.toFixed(7)}:${point.lon.toFixed(7)}`
      : `motion:${ts.toFixed(3)}:${timelineItemId ?? ""}:${activity ?? ""}`;
  const locationTie = [
    point?.lat,
    point?.lon,
    numberValue(location.altitude),
    horizontalAccuracy,
    numberValue(location.verticalAccuracy),
    numberValue(location.speed),
    numberValue(location.course),
  ]
    .map((value) => value ?? "")
    .join("|");

  return {
    identity,
    sampleId,
    timelineItemId,
    ts,
    lat: point?.lat ?? null,
    lon: point?.lon ?? null,
    altitude: numberValue(location.altitude),
    horizontalAccuracy,
    verticalAccuracy: nonNegative(numberValue(location.verticalAccuracy)),
    speed: nonNegative(numberValue(location.speed)),
    speedAccuracy: nonNegative(numberValue(location.speedAccuracy)),
    course: normalizeCourse(numberValue(location.course)),
    courseAccuracy: courseAccuracyValue(location.courseAccuracy),
    timezoneOffset: timezoneOffsetValue(sample.secondsFromGMT),
    locationQuality: point ? (horizontalAccuracy === null ? 0 : 1_000_000 - horizontalAccuracy) + locationValues : -1,
    locationTie,
    activity,
    activityRank,
    movingState,
    movingStateRank: movingState ? 1 : 0,
    revision: revisionValue(sample),
  };
}

function arcExportItems(value: unknown): JsonObject[] {
  const object = asObject(value);
  if (!object || !Array.isArray(object.timelineItems)) {
    throw new HistoryInputError("Arc export must contain a timelineItems array");
  }
  const items = object.timelineItems.map(asObject);
  if (items.some((item) => item === null)) {
    throw new HistoryInputError("Arc export timelineItems must contain objects");
  }
  for (const item of items) {
    validateArcTimelineItem(item!);
  }
  return items as JsonObject[];
}

function validateArcTimelineItem(item: JsonObject): void {
  if (typeof item.isVisit !== "boolean" || stringValue(item.startDate) === null || stringValue(item.endDate) === null) {
    throw new HistoryInputError("Arc timeline item is missing isVisit, startDate, or endDate");
  }
}

function arcItemKey(item: JsonObject): string | null {
  const itemId = stringValue(item.itemId);
  if (itemId) {
    return `id:${itemId}`;
  }
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  if (start === null || end === null) {
    return null;
  }
  return `time:${start}|${end}|${item.isVisit === true ? "stay" : "move"}`;
}

function arcItemScore(item: JsonObject, sampleCount = arrayValue(item.samples).length): ArcItemScore {
  const samples = arrayValue(item.samples);
  const sampleFields = samples.reduce(
    (count, sample) => count + Object.values(sample).filter((value) => value !== null && value !== undefined).length,
    0,
  );
  const place = asObject(item.place);
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  const positiveDuration = start !== null && end !== null && end > start ? 1 : 0;
  return [
    positiveDuration,
    item.manualActivityType === true || stringValue(item.confirmedType) || item.manualPlace === true ? 1 : 0,
    isLowConfidenceArcItem(item) ? 0 : 1,
    place && (locationFrom(place.center) || locationFrom(place.location)) ? 1 : 0,
    sampleCount,
    sampleFields,
    Object.values(item).filter((value) => value !== null && value !== undefined).length,
  ];
}

type FusedArcItem = {
  item: JsonObject;
  sampleCount: number;
  hasExport: boolean;
  observationLink: string;
};

type ArcFragmentWindow = {
  key: string;
  start: number;
  end: number;
  items: FusedArcItem[];
};

function materializeArcEvidence(
  evidence: HistoryEvidence,
  ledger: EvidenceLedger,
  state: MutableState,
  signal?: AbortSignal,
): void {
  for (const placeId of [...evidence.arcPlaces.keys()].sort()) {
    throwIfAborted(signal);
    const candidates = candidatesAfterTombstone(
      evidence.arcPlaces.get(placeId)!,
      evidence.arcPlaceTombstones.get(placeId),
    );
    if (candidates.length > 0) {
      const place = fuseObjectCandidates(candidates);
      if (!locationFrom(place.center) && !locationFrom(place.location)) {
        recordDiagnostic(state, `Skipped Arc Place ${placeId} because its fused revisions have no coordinates`);
      } else {
        importArcPlace(place, state);
      }
    }
  }

  const items = [...evidence.arcItems.entries()]
    .flatMap(([key, candidates]) => {
      const live = candidatesAfterTombstone(
        candidates,
        evidence.arcItemTombstones.get(key),
        (candidate) => candidate.item,
      );
      return live.length > 0 ? [fuseArcItemCandidates(live, key)] : [];
    })
    .sort(
      (lhs, rhs) =>
        arcItemStart(lhs.item) - arcItemStart(rhs.item) ||
        compareStableStrings(canonicalJson(lhs.item), canonicalJson(rhs.item)),
    );
  const fragmentWindows = findArcFragmentWindows(items);
  const fragmentedItems = new Set(fragmentWindows.flatMap((window) => window.items));

  collectArcPedometerClaims(items, ledger, state, signal);

  for (const fused of items) {
    throwIfAborted(signal);
    if (!fragmentedItems.has(fused)) {
      importFusedArcItem(fused, ledger, state);
    }
  }

  for (const window of fragmentWindows) {
    throwIfAborted(signal);
    reconstructArcFragmentWindow(window, ledger, state);
  }

  const knownTimelineItemIds = new Set(
    items.flatMap((item) => {
      const itemId = stringValue(item.item.itemId);
      return itemId ? [item.observationLink, itemId] : [item.observationLink];
    }),
  );
  for (const key of evidence.arcItemTombstones.keys()) {
    if (key.startsWith("id:")) {
      knownTimelineItemIds.add(key.slice(3));
    }
  }
  reconstructUnlinkedArcObservations(ledger, state, knownTimelineItemIds, signal);
}

function collectArcPedometerClaims(
  items: FusedArcItem[],
  ledger: EvidenceLedger,
  state: MutableState,
  signal?: AbortSignal,
): void {
  for (const [sequence, fused] of items.entries()) {
    throwIfAborted(signal);
    const itemId = stringValue(fused.item.itemId);
    const samples = ledger.observationsForTimelineItem(itemId ?? fused.observationLink) as JsonObject[];
    const item = samples.length > 0 ? { ...fused.item, samples } : fused.item;
    const placeId = stringValue(item.placeId);
    const timezoneOffset =
      timezoneOffsetValue(samples[0]?.secondsFromGMT) ??
      timezoneOffsetValue(item.secondsFromGMT) ??
      (placeId ? (state.arcPlaces.get(placeId)?.timezoneOffset ?? null) : null);
    importPedometerData(item, state, timezoneOffset, sequence);
  }
}

function materializeArcObservations(ledger: EvidenceLedger, state: MutableState, signal?: AbortSignal): void {
  ledger.forEachTimelineItem((timelineItemId, samples) => {
    throwIfAborted(signal);
    if (timelineItemId) {
      importArcBackupRoutes(samples as JsonObject[], state);
    }
  });
  ledger.forEachCanonicalObservation((samples) => {
    throwIfAborted(signal);
    importSamples(samples as JsonObject[], state);
  });
}

function fuseArcItemCandidates(candidates: ArcItemCandidate[], observationLink: string): FusedArcItem {
  const sorted = [...candidates].sort((lhs, rhs) => {
    const revisionDifference = revisionValue(lhs.item) - revisionValue(rhs.item);
    if (revisionDifference !== 0) {
      return revisionDifference;
    }
    const score = compareNumericTuples(
      arcItemScore(lhs.item, lhs.sampleCount),
      arcItemScore(rhs.item, rhs.sampleCount),
    );
    return score || compareStableStrings(canonicalJson(lhs.item), canonicalJson(rhs.item));
  });
  let item: JsonObject = {};
  for (const candidate of sorted) {
    item = mergeArcItemRevision(item, candidate.item);
  }
  item.samples = [];
  return {
    item,
    sampleCount: Math.max(...candidates.map((candidate) => candidate.sampleCount)),
    hasExport: candidates.some((candidate) => candidate.source === "export"),
    observationLink,
  };
}

function mergeArcItemRevision(lower: JsonObject, higher: JsonObject): JsonObject {
  const merged = mergeJsonObjects(lower, higher);
  for (const field of arcRevisionSemanticFields) {
    if (higher[field] === null) {
      merged[field] = null;
    }
  }
  return merged;
}

function recordTombstone(target: Map<string, number>, key: string, object: JsonObject): void {
  target.set(key, Math.max(target.get(key) ?? Number.NEGATIVE_INFINITY, tombstoneRevision(object)));
}

function candidatesAfterTombstone<T>(
  candidates: T[],
  tombstone: number | undefined,
  value: (candidate: T) => JsonObject = (candidate) => candidate as JsonObject,
): T[] {
  return tombstone === undefined
    ? candidates
    : candidates.filter((candidate) => revisionValue(value(candidate)) > tombstone);
}

function revisionValue(object: JsonObject): number {
  return parseImportTimestamp(stringValue(object.lastSaved)) ?? 0;
}

function tombstoneRevision(object: JsonObject): number {
  return parseImportTimestamp(stringValue(object.lastSaved)) ?? Number.MAX_VALUE;
}

function fuseObjectCandidates(candidates: JsonObject[]): JsonObject {
  const sorted = [...candidates].sort((lhs, rhs) => {
    const revisionDifference = revisionValue(lhs) - revisionValue(rhs);
    if (revisionDifference !== 0) {
      return revisionDifference;
    }
    const fieldDifference = populatedFieldCount(lhs) - populatedFieldCount(rhs);
    return fieldDifference || compareStableStrings(canonicalJson(lhs), canonicalJson(rhs));
  });
  return sorted.reduce<JsonObject>((merged, candidate) => mergeJsonObjects(merged, candidate), {});
}

function mergeJsonObjects(lower: JsonObject, higher: JsonObject): JsonObject {
  const merged: JsonObject = { ...lower };
  for (const [key, higherValue] of Object.entries(higher)) {
    if (higherValue === null || higherValue === undefined) {
      continue;
    }
    const lowerObject = asObject(merged[key]);
    const higherObject = asObject(higherValue);
    if (lowerObject && higherObject) {
      merged[key] = mergeJsonObjects(lowerObject, higherObject);
    } else if (Array.isArray(higherValue)) {
      if (higherValue.length > 0 || !Array.isArray(merged[key])) {
        merged[key] = higherValue;
      }
    } else {
      merged[key] = higherValue;
    }
  }
  return merged;
}

function populatedFieldCount(value: JsonObject): number {
  return Object.values(value).reduce<number>((count, field) => {
    if (field === null || field === undefined) {
      return count;
    }
    const object = asObject(field);
    return count + 1 + (object ? populatedFieldCount(object) : 0);
  }, 0);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = asObject(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprintJson(value: unknown): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let length = 0;
  const feed = (text: string): void => {
    length += text.length;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
  };
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      feed("[");
      for (const item of candidate) {
        visit(item);
        feed(",");
      }
      feed("]");
      return;
    }
    const object = asObject(candidate);
    if (object) {
      feed("{");
      for (const key of Object.keys(object).sort()) {
        feed(key);
        feed(":");
        visit(object[key]);
        feed(",");
      }
      feed("}");
      return;
    }
    feed(JSON.stringify(candidate) ?? "null");
  };
  visit(value);
  return `${first.toString(16)}:${second.toString(16)}:${length}`;
}

function importFusedArcItem(fused: FusedArcItem, ledger: EvidenceLedger, state: MutableState): void {
  const itemId = stringValue(fused.item.itemId);
  const samples = ledger.observationsForTimelineItem(itemId ?? fused.observationLink);
  const firstSample = samples[0] ?? null;
  const item: JsonObject = samples.length > 0 ? { ...fused.item, samples } : { ...fused.item };
  item.secondsFromGMT = timezoneOffsetValue(item.secondsFromGMT) ?? timezoneOffsetValue(firstSample?.secondsFromGMT);
  if (isLowConfidenceArcItem(item) && !arcItemSupportedBySamples(item, samples as JsonObject[])) {
    const start = arcItemStart(item);
    const end = arcItemEnd(item);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      insertImportGap(state, start, end, timelineNote.arcLowConfidence);
      recordDiagnostic(state, "Replaced unsupported low-confidence Arc activity with a gap");
    }
    return;
  }
  if (!fused.hasExport) {
    if (!locationFrom(item.center) && firstSample) {
      item.center = asObject(firstSample.location);
    }
    if (itemId) {
      importArcBackupTimelineItem(item, state);
    } else {
      importArcTimelineItem(item, state, providers.arcBackup, false);
    }
  } else {
    importArcTimelineItem(item, state, fused.hasExport ? providers.arcImport : providers.arcBackup, false);
  }
}

function findArcFragmentWindows(items: FusedArcItem[]): ArcFragmentWindow[] {
  const grouped = new Map<string, FusedArcItem[]>();
  for (const item of items) {
    const key = arcLocalDayKey(item.item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }

  const windows: ArcFragmentWindow[] = [];
  for (const [key, group] of grouped) {
    if (group.length < 2) {
      continue;
    }
    const sorted = [...group].sort((lhs, rhs) => arcItemStart(lhs.item) - arcItemStart(rhs.item));
    const nonPositiveCount = group.filter((entry) => arcItemDuration(entry.item) <= 0).length;
    const positiveDurations = group
      .map((entry) => arcItemDuration(entry.item))
      .filter((duration) => duration > 0)
      .sort((lhs, rhs) => lhs - rhs);
    const fragmentedByInvalidDurations = nonPositiveCount > 0 && nonPositiveCount / group.length >= 0.4;
    const fragmentedByShortDensity =
      group.length >= fragmentGroupSize && (median(positiveDurations) ?? 0) < fragmentMedianDurationThresholdS;
    if (!fragmentedByInvalidDurations && !fragmentedByShortDensity) {
      continue;
    }

    const anchors = sorted.filter(isTrustedArcAnchor);
    let pending: FusedArcItem[] = [];
    const flush = (): void => {
      if (pending.length === 0) {
        return;
      }
      const starts = pending.map((entry) => arcItemStart(entry.item)).filter(Number.isFinite);
      const ends = pending.map((entry) => arcItemEnd(entry.item)).filter(Number.isFinite);
      if (starts.length > 0 && ends.length > 0) {
        const nonPositiveStarts = pending
          .filter((entry) => arcItemDuration(entry.item) <= 0)
          .map((entry) => arcItemStart(entry.item))
          .filter(Number.isFinite);
        windows.push({
          key,
          start: Math.min(...starts),
          end: Math.max(
            Math.max(...ends),
            nonPositiveStarts.length > 0
              ? Math.max(...nonPositiveStarts) + trustedFragmentDurationS
              : Number.NEGATIVE_INFINITY,
          ),
          items: pending,
        });
      }
      pending = [];
    };

    for (const entry of sorted) {
      if (isTrustedArcAnchor(entry)) {
        flush();
        continue;
      }
      const start = arcItemStart(entry.item);
      const end = arcItemEnd(entry.item);
      const overlapsAnchor = anchors.some((anchor) => {
        const anchorStart = arcItemStart(anchor.item);
        const anchorEnd = arcItemEnd(anchor.item);
        return (
          (Number.isFinite(start) && Number.isFinite(end) && start < anchorEnd && end > anchorStart) ||
          (Number.isFinite(start) && start >= anchorStart && start < anchorEnd)
        );
      });
      if (overlapsAnchor) {
        flush();
        continue;
      }
      const previous = pending.at(-1);
      if (
        previous &&
        start - Math.max(arcItemStart(previous.item), arcItemEnd(previous.item)) > fragmentGapThresholdS
      ) {
        flush();
      }
      pending.push(entry);
    }
    flush();
  }
  return windows.sort((lhs, rhs) => lhs.start - rhs.start);
}

function arcLocalDayKey(item: JsonObject): string {
  const start = arcItemStart(item);
  const offset = timezoneOffsetValue(item.secondsFromGMT) ?? 0;
  return Number.isFinite(start) ? Math.floor((start + offset) / 86_400).toString() : canonicalJson(item);
}

function arcItemStart(item: JsonObject): number {
  return parseImportTimestamp(stringValue(item.startDate)) ?? Number.POSITIVE_INFINITY;
}

function arcItemEnd(item: JsonObject): number {
  return parseImportTimestamp(stringValue(item.endDate)) ?? Number.NEGATIVE_INFINITY;
}

function arcItemDuration(item: JsonObject): number {
  return arcItemEnd(item) - arcItemStart(item);
}

function isTrustedArcAnchor(item: FusedArcItem): boolean {
  const duration = arcItemDuration(item.item);
  if (!(duration > 0) || isLowConfidenceArcItem(item.item)) {
    return false;
  }
  return (
    item.item.manualActivityType === true ||
    item.item.manualPlace === true ||
    stringValue(item.item.confirmedType) !== null ||
    duration >= trustedFragmentDurationS ||
    item.sampleCount >= 2
  );
}

function isLowConfidenceArcItem(item: JsonObject): boolean {
  if (item.isVisit === true || item.manualActivityType === true || stringValue(item.confirmedType)) {
    return false;
  }
  const confidence = numberValue(item.activityTypeConfidenceScore);
  return (
    item.uncertainActivityType === true || item.unknownActivityType === true || (confidence !== null && confidence <= 0)
  );
}

function arcItemSupportedBySamples(item: JsonObject, samples: JsonObject[]): boolean {
  if (samples.length < 2) {
    return false;
  }
  const activities = samples.map(sampleActivity);
  const stationaryCount = activities.filter((activity) => activity === "stationary").length;
  const movingCount = activities.filter(
    (activity) => activity && activity !== "stationary" && activity !== "unknown" && activity !== "uncertain",
  ).length;
  const semanticSupport =
    item.isVisit === true ? stationaryCount / samples.length >= 0.5 : movingCount / samples.length >= 0.5;
  if (semanticSupport) {
    return true;
  }
  const routePoints = prepareRouteFromSamples(samples).points;
  const coords = routePoints.map((point) => point.coord);
  if (item.isVisit === true) {
    if (coords.length < 3) {
      return false;
    }
    const centerLat = median(coords.map((coordinate) => coordinate[1]));
    const centerLon = median(coords.map((coordinate) => coordinate[0]));
    return (
      centerLat !== null &&
      centerLon !== null &&
      coords.every(([lon, lat]) => haversineDistance(centerLat, centerLon, lat, lon) <= maximumReconstructedStayRadiusM)
    );
  }
  if (stationaryCount > movingCount) {
    return false;
  }
  return geometryOnlyMoveIsSupported(routePoints, samples, Math.max(1, arcItemDuration(item)));
}

function reconstructArcFragmentWindow(window: ArcFragmentWindow, ledger: EvidenceLedger, state: MutableState): void {
  reconstructArcInterval(window.start, window.end, ledger, state);
}

function reconstructUnlinkedArcObservations(
  ledger: EvidenceLedger,
  state: MutableState,
  knownTimelineItemIds: ReadonlySet<string>,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  const covered = [
    ...state.rows.stays.map((row) => ({ start: row.start_ts, end: row.end_ts })),
    ...state.rows.moves.map((row) => ({ start: row.start_ts, end: row.end_ts })),
    ...state.rows.no_data_gaps.map((row) => ({ start: row.start_ts, end: row.end_ts })),
  ]
    .filter(
      (interval): interval is { start: number; end: number } => interval.end !== null && interval.end > interval.start,
    )
    .sort((lhs, rhs) => lhs.start - rhs.start);

  for (const window of ledger.unlinkedObservationWindows(knownTimelineItemIds)) {
    throwIfAborted(signal);
    let cursor = window.start;
    for (const interval of covered) {
      if (interval.end <= cursor) {
        continue;
      }
      if (interval.start >= window.end) {
        break;
      }
      if (interval.start > cursor) {
        reconstructArcInterval(cursor, Math.min(interval.start, window.end), ledger, state, knownTimelineItemIds);
      }
      cursor = Math.max(cursor, interval.end);
      if (cursor >= window.end) {
        break;
      }
    }
    if (cursor < window.end) {
      reconstructArcInterval(cursor, window.end, ledger, state, knownTimelineItemIds);
    }
  }
}

function reconstructArcInterval(
  start: number,
  end: number,
  ledger: EvidenceLedger,
  state: MutableState,
  orphanTimelineItemIds: ReadonlySet<string> | null = null,
): void {
  if (!(end > start)) {
    return;
  }
  const samples = (
    orphanTimelineItemIds
      ? ledger.unlinkedObservationsBetween(start, end, orphanTimelineItemIds)
      : ledger.observationsBetween(start, end)
  ) as JsonObject[];
  const times = samples
    .map(sampleTimestamp)
    .filter((value): value is number => value !== null)
    .sort((lhs, rhs) => lhs - rhs);
  if (times.length < 2) {
    insertImportGap(state, start, end, timelineNote.arcFragmentLowEvidence);
    return;
  }
  const deltas = times
    .slice(1)
    .map((time, index) => time - times[index]!)
    .filter((delta) => delta > 0 && delta <= maximumObservationGapS);
  const extension = Math.max(1, Math.min(maximumObservationExtensionS, median(deltas) ?? trustedFragmentDurationS));
  const reconstructedStart = Math.max(start, times[0]!);
  const reconstructedEnd = Math.min(end, times.at(-1)! + extension);
  if (!(reconstructedEnd > reconstructedStart)) {
    insertImportGap(state, start, end, timelineNote.arcFragmentLowEvidence);
    return;
  }

  insertImportGap(state, start, reconstructedStart, timelineNote.arcFragmentUnobserved);
  insertImportGap(state, reconstructedEnd, end, timelineNote.arcFragmentUnobserved);

  const preparedRoute = prepareRouteFromSamples(samples);
  const routePoints = preparedRoute.points;
  const coords = routePoints.map((point) => point.coord);
  const centerLat = median(coords.map((coordinate) => coordinate[1]));
  const centerLon = median(coords.map((coordinate) => coordinate[0]));
  const distances =
    centerLat === null || centerLon === null
      ? []
      : coords.map(([lon, lat]) => haversineDistance(centerLat, centerLon, lat, lon)).sort((lhs, rhs) => lhs - rhs);
  const radius = percentile(distances, 0.9);
  const horizontalAccuracy = median(
    samples
      .map((sample) => nonNegative(numberValue(asObject(sample.location)?.horizontalAccuracy)))
      .filter((value): value is number => value !== null),
  );
  const effectiveRadius = radius === null ? null : Math.max(radius, horizontalAccuracy ?? 0);
  const stationaryRatio = samples.filter((sample) => sampleActivity(sample) === "stationary").length / samples.length;
  const movingRatio =
    samples.filter((sample) => {
      const activity = sampleActivity(sample);
      return activity !== null && activity !== "stationary" && activity !== "uncertain" && activity !== "unknown";
    }).length / samples.length;

  if (
    centerLat !== null &&
    centerLon !== null &&
    effectiveRadius !== null &&
    effectiveRadius <= maximumReconstructedStayRadiusM &&
    stationaryRatio >= 0.5
  ) {
    const placeId = matchingArcPlaceId(
      state,
      centerLat,
      centerLon,
      Math.max(minimumReconstructedStayRadiusM, effectiveRadius),
    );
    const stayRadius = Math.max(
      minimumReconstructedStayRadiusM,
      effectiveRadius,
      placeId ? (state.arcPlaces.get(placeId)?.radius ?? 0) : 0,
    );
    importArcTimelineItem(
      {
        itemId: `reconstructed-stay:${reconstructedStart}`,
        isVisit: true,
        startDate: new Date(reconstructedStart * 1000).toISOString(),
        endDate: new Date(reconstructedEnd * 1000).toISOString(),
        center: { latitude: centerLat, longitude: centerLon },
        radius: { mean: stayRadius },
        placeId,
        secondsFromGMT:
          timezoneOffsetValue(samples[0]?.secondsFromGMT) ??
          (placeId ? state.arcPlaces.get(placeId)?.timezoneOffset : null),
        samples: [samples[0]!],
      },
      state,
      providers.arcReconstruction,
      false,
    );
    recordDiagnostic(state, "Reconstructed fragmented Arc window from stationary samples");
    return;
  }

  const distance = calculatePathDistance(coords);
  const plausibleMovingGeometry =
    movingRatio >= 0.5
      ? routePoints.length >= 2
      : stationaryRatio <= movingRatio &&
        geometryOnlyMoveIsSupported(routePoints, samples, reconstructedEnd - reconstructedStart);
  if (
    coords.length >= 2 &&
    distance !== null &&
    distance >= minimumReconstructedMoveDistanceM &&
    plausibleMovingGeometry
  ) {
    const activity = samples.map(sampleActivity).find((value) => value && value !== "stationary") ?? null;
    const move = insertMove(state, {
      start: reconstructedStart,
      end: reconstructedEnd,
      mode: mapActivityType(activity),
      distance,
      tzOffset: timezoneOffsetValue(samples[0]?.secondsFromGMT),
      provider: providers.arcReconstruction,
    });
    insertRoutePath(
      state,
      move.id,
      coords,
      providers.arcReconstruction,
      routePoints.map((point) => point.ts),
      preparedRoute.pathQuality,
    );
    recordDiagnostic(state, "Reconstructed fragmented Arc window from moving samples");
    return;
  }

  insertImportGap(state, reconstructedStart, reconstructedEnd, timelineNote.arcFragmentLowEvidence);
  recordDiagnostic(state, "Replaced fragmented Arc window with a low-evidence gap");
}

function matchingArcPlaceId(
  state: MutableState,
  latitude: number,
  longitude: number,
  reconstructedRadius: number,
): string | null {
  const matches = [...state.arcPlaces.entries()]
    .map(([placeId, place]) => ({
      placeId,
      distance: haversineDistance(latitude, longitude, place.center.lat, place.center.lon),
      threshold: Math.max(stayMatchingBufferM, reconstructedRadius + (place.radius ?? defaultStayRadiusM)),
    }))
    .filter((candidate) => candidate.distance <= candidate.threshold && state.poiCache.has(`arc:${candidate.placeId}`))
    .sort((lhs, rhs) => lhs.distance - rhs.distance || compareStableStrings(lhs.placeId, rhs.placeId));
  if (matches.length === 0 || (matches.length > 1 && matches[1]!.distance - matches[0]!.distance < 25)) {
    return null;
  }
  return matches[0]!.placeId;
}

function geometryOnlyMoveIsSupported(points: TimedRoutePoint[], samples: JsonObject[], duration: number): boolean {
  if (points.length < 3 || !(duration > 0)) {
    return false;
  }
  const coords = points.map((point) => point.coord);
  const distance = calculatePathDistance(coords);
  if (
    distance === null ||
    distance < minimumReconstructedMoveDistanceM ||
    distance / duration < minimumGeometryOnlyMoveSpeedMps
  ) {
    return false;
  }
  const first = coords[0]!;
  const last = coords.at(-1)!;
  const displacement = haversineDistance(first[1], first[0], last[1], last[0]);
  const horizontalAccuracy = median(
    samples
      .map((sample) => nonNegative(numberValue(asObject(sample.location)?.horizontalAccuracy)))
      .filter((value): value is number => value !== null),
  );
  return displacement >= Math.max(minimumReconstructedMoveDistanceM, 2 * (horizontalAccuracy ?? 0));
}

function insertImportGap(state: MutableState, start: number, end: number, notes: string): void {
  if (end <= start) {
    return;
  }
  state.rows.no_data_gaps.push({
    id: state.next.no_data_gaps++,
    start_ts: start,
    end_ts: end,
    reason: "Unknown",
    uncertainty: null,
    notes,
  });
}

function sampleTimestamp(sample: JsonObject): number | null {
  const location = asObject(sample.location);
  return parseImportTimestamp(stringValue(location?.timestamp) ?? stringValue(sample.date));
}

function sampleActivity(sample: JsonObject): string | null {
  return (
    (stringValue(sample.confirmedType) ?? stringValue(sample.coreMotionActivityType) ?? stringValue(sample.movingState))
      ?.trim()
      .toLowerCase() ?? null
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((lhs, rhs) => lhs - rhs);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percentile(sortedValues: number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * percentileValue))]!;
}

function fuseMovesEvidence(ledger: EvidenceLedger, signal?: AbortSignal): void {
  for (const date of ledger.movesDayDates()) {
    throwIfAborted(signal);
    const day = fuseMovesDayCandidates(ledger.movesDayCandidates(date));
    addMovesTrackPointEvidence(day, ledger);
    ledger.storeFusedMovesDay(date, day);
  }
}

function materializeMovesEvidence(days: JsonObject[], state: MutableState): void {
  for (const day of days) {
    if (day[evidenceKey.fragmentRepair] === true) {
      recordDiagnostic(state, "Collapsed dense short-duration Moves fragments into unknown timeline ranges");
    }
    importMovesDay(day, state);
  }
}

function fuseMovesDayCandidates(candidates: MovesDayCandidate[]): JsonObject {
  const repairedCandidates = candidates.map((candidate) => ({
    ...candidate,
    day: repairFragmentedMovesDay(candidate.day),
  }));
  const sorted = [...repairedCandidates].sort((lhs, rhs) => {
    const score = compareNumericTuples(movesDayScore(lhs.day), movesDayScore(rhs.day));
    return score || compareStableStrings(canonicalJson(lhs.day), canonicalJson(rhs.day));
  });
  const winner = sorted.at(-1)!;
  let mergedDay = { ...winner.day };
  const selected: MovesSegmentCandidate[] = arrayValue(winner.day.segments).map((segment) => ({
    value: segment,
    revision: movesRevisionValue(segment, winner.day),
  }));
  for (const candidate of [...sorted].reverse().slice(1)) {
    mergedDay = mergeMissingJsonObjects(mergedDay, { ...candidate.day, segments: [] });
    for (const segment of arrayValue(candidate.day.segments)) {
      const supplement: MovesSegmentCandidate = {
        value: segment,
        revision: movesRevisionValue(segment, candidate.day),
      };
      const supplementIndex = selected.findIndex((current) => canSupplementMovesSegment(current.value, segment));
      if (supplementIndex >= 0) {
        selected[supplementIndex] = mergeMovesSegments(selected[supplementIndex]!, supplement);
      } else {
        const revisionConflictIndex = selected.findIndex((current) =>
          movesSegmentsShareRevisionIdentity(current.value, segment),
        );
        if (revisionConflictIndex >= 0) {
          const current = selected[revisionConflictIndex]!;
          selected[revisionConflictIndex] =
            stringValue(current.value.type) === stringValue(segment.type)
              ? mergeMovesSegments(current, supplement)
              : preferredMovesSegment(current, supplement);
        } else {
          selected.push(supplement);
        }
      }
    }
  }
  selected.sort(
    (lhs, rhs) =>
      segmentStart(lhs.value) - segmentStart(rhs.value) ||
      Number(movesSegmentHasManualEvidence(rhs.value)) - Number(movesSegmentHasManualEvidence(lhs.value)) ||
      compareStableStrings(canonicalJson(lhs.value), canonicalJson(rhs.value)),
  );
  return repairFragmentedMovesDay({
    ...mergedDay,
    segments: selected.map((candidate) => candidate.value),
    summary: fuseMovesSummaries(repairedCandidates),
  });
}

function repairFragmentedMovesDay(day: JsonObject): JsonObject {
  const segments = arrayValue(day.segments)
    .filter((segment) => Number.isFinite(segmentStart(segment)) && Number.isFinite(segmentEnd(segment)))
    .sort((lhs, rhs) => segmentStart(lhs) - segmentStart(rhs));
  const durations = segments
    .map((segment) => segmentEnd(segment) - segmentStart(segment))
    .filter((duration) => duration > 0);
  const nonPositiveCount = segments.filter((segment) => segmentEnd(segment) <= segmentStart(segment)).length;
  const fragmentedByInvalidDurations =
    nonPositiveCount > 0 && nonPositiveCount / segments.length >= fragmentInvalidDurationRatio;
  const fragmentedByShortDensity = (median(durations) ?? Number.POSITIVE_INFINITY) < fragmentMedianDurationThresholdS;
  if (segments.length < fragmentGroupSize || (!fragmentedByInvalidDurations && !fragmentedByShortDensity)) {
    return day;
  }

  const repaired: JsonObject[] = [];
  let fragments: JsonObject[] = [];
  const flush = (): void => {
    if (fragments.length === 0) {
      return;
    }
    const start = fragments[0]!;
    const end = fragments.reduce((latest, segment) => (segmentEnd(segment) > segmentEnd(latest) ? segment : latest));
    const repairedEnd =
      segmentEnd(end) > segmentStart(start)
        ? end.endTime
        : new Date((segmentStart(start) + trustedFragmentDurationS) * 1_000).toISOString();
    repaired.push({ type: "off", startTime: start.startTime, endTime: repairedEnd });
    fragments = [];
  };
  for (const segment of segments) {
    const trusted =
      movesSegmentHasManualEvidence(segment) || segmentEnd(segment) - segmentStart(segment) >= trustedFragmentDurationS;
    const previous = fragments.at(-1);
    if (trusted) {
      flush();
      repaired.push(segment);
    } else {
      if (previous && segmentStart(segment) - segmentEnd(previous) > fragmentGapThresholdS) {
        flush();
      }
      fragments.push(segment);
    }
  }
  flush();
  return { ...day, segments: repaired, [evidenceKey.fragmentRepair]: true, [evidenceKey.fragmentEvidence]: segments };
}

function movesRevisionValue(segment: JsonObject, day: JsonObject): number {
  return (
    nonNegative(numberValue(segment[evidenceKey.auraRevision])) ??
    parseImportTimestamp(stringValue(segment.lastUpdate) ?? stringValue(segment.lastSaved)) ??
    parseImportTimestamp(stringValue(day.lastUpdate) ?? stringValue(day.lastSaved)) ??
    0
  );
}

function fuseMovesSummaries(candidates: MovesDayCandidate[]): JsonObject[] {
  const groups = new Map<string, Array<{ value: JsonObject; revision: number }>>();
  for (const candidate of candidates) {
    for (const summary of arrayValue(candidate.day.summary)) {
      const revision =
        parseImportTimestamp(stringValue(summary.lastUpdate) ?? stringValue(summary.lastSaved)) ??
        parseImportTimestamp(stringValue(candidate.day.lastUpdate) ?? stringValue(candidate.day.lastSaved)) ??
        0;
      const key = `${stringValue(summary.activity) ?? ""}|${stringValue(summary.group) ?? ""}`;
      const group = groups.get(key) ?? [];
      group.push({ value: summary, revision });
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort(
        (lhs, rhs) =>
          lhs.revision - rhs.revision ||
          populatedFieldCount(lhs.value) - populatedFieldCount(rhs.value) ||
          compareStableStrings(canonicalJson(lhs.value), canonicalJson(rhs.value)),
      );
      let fused = { ...sorted.at(-1)!.value };
      for (const supplement of sorted.slice(0, -1).reverse()) {
        fused = mergeMissingJsonObjects(fused, supplement.value);
      }
      fused[evidenceKey.auraRevision] = sorted.at(-1)!.revision;
      return fused;
    })
    .sort((lhs, rhs) => compareStableStrings(canonicalJson(lhs), canonicalJson(rhs)));
}

function canSupplementMovesSegment(primary: JsonObject, supplement: JsonObject): boolean {
  const type = stringValue(primary.type);
  if (type !== stringValue(supplement.type) || !segmentsOverlap(primary, supplement)) {
    return false;
  }
  if (type === "place") {
    const primaryId = placeIdentifier(primary.place);
    const supplementId = placeIdentifier(supplement.place);
    return (
      (primaryId !== null && primaryId === supplementId) ||
      (segmentStart(primary) === segmentStart(supplement) &&
        segmentEnd(primary) === segmentEnd(supplement) &&
        (primaryId === null || supplementId === null))
    );
  }
  return (
    type === "move" &&
    segmentStart(primary) === segmentStart(supplement) &&
    segmentEnd(primary) === segmentEnd(supplement)
  );
}

function sameMovesSegmentWindow(lhs: JsonObject, rhs: JsonObject): boolean {
  return segmentStart(lhs) === segmentStart(rhs) && segmentEnd(lhs) === segmentEnd(rhs);
}

function movesSegmentsShareRevisionIdentity(lhs: JsonObject, rhs: JsonObject): boolean {
  if (sameMovesSegmentWindow(lhs, rhs)) {
    return true;
  }
  const lhsStart = segmentStart(lhs);
  const lhsEnd = segmentEnd(lhs);
  const rhsStart = segmentStart(rhs);
  const rhsEnd = segmentEnd(rhs);
  const lhsDuration = lhsEnd - lhsStart;
  const rhsDuration = rhsEnd - rhsStart;
  const intersection = Math.min(lhsEnd, rhsEnd) - Math.max(lhsStart, rhsStart);
  if (
    !(lhsDuration > 0) ||
    !(rhsDuration > 0) ||
    intersection / Math.min(lhsDuration, rhsDuration) < 0.8 ||
    Math.max(lhsDuration, rhsDuration) / Math.min(lhsDuration, rhsDuration) > 1.5
  ) {
    return false;
  }
  const lhsPlaceId = placeIdentifier(lhs.place);
  const rhsPlaceId = placeIdentifier(rhs.place);
  return lhsPlaceId === null || rhsPlaceId === null || lhsPlaceId === rhsPlaceId;
}

function preferredMovesSegment(
  primary: MovesSegmentCandidate,
  supplement: MovesSegmentCandidate,
): MovesSegmentCandidate {
  const primaryManual = movesSegmentHasManualEvidence(primary.value);
  const supplementManual = movesSegmentHasManualEvidence(supplement.value);
  if (supplementManual !== primaryManual) {
    return supplementManual ? supplement : primary;
  }
  return supplement.revision > primary.revision ? supplement : primary;
}

function mergeMissingJsonObjects(primary: JsonObject, supplement: JsonObject): JsonObject {
  const merged: JsonObject = { ...primary };
  for (const [key, value] of Object.entries(supplement)) {
    const currentObject = asObject(merged[key]);
    const supplementObject = asObject(value);
    if (currentObject && supplementObject) {
      merged[key] = mergeMissingJsonObjects(currentObject, supplementObject);
    } else if (
      merged[key] === null ||
      merged[key] === undefined ||
      (Array.isArray(merged[key]) && (merged[key] as unknown[]).length === 0)
    ) {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeMovesSegments(primary: MovesSegmentCandidate, supplement: MovesSegmentCandidate): MovesSegmentCandidate {
  const primaryManual = movesSegmentHasManualEvidence(primary.value);
  const supplementManual = movesSegmentHasManualEvidence(supplement.value);
  const supplementWins =
    (supplementManual && !primaryManual) ||
    (supplementManual === primaryManual && supplement.revision > primary.revision);
  const preferred = supplementWins ? supplement : primary;
  const fallback = supplementWins ? primary : supplement;
  const merged = mergeMissingJsonObjects(preferred.value, fallback.value);
  merged.trackPoints = fuseMovesTrackPoints([
    { points: arrayValue(primary.value.trackPoints), revision: primary.revision },
    { points: arrayValue(supplement.value.trackPoints), revision: supplement.revision },
  ]);
  if (stringValue(preferred.value.type) === "move") {
    merged.activities = fuseMovesActivityCandidates([
      ...arrayValue(primary.value.activities).map((activity) => ({
        value: activity,
        revision: activityRevisionValue(activity, primary.revision),
      })),
      ...arrayValue(supplement.value.activities).map((activity) => ({
        value: activity,
        revision: activityRevisionValue(activity, supplement.revision),
      })),
    ]);
  }
  merged[evidenceKey.auraRevision] = preferred.revision;
  return { value: merged, revision: preferred.revision };
}

function fuseMovesActivities(activities: JsonObject[]): JsonObject[] {
  return fuseMovesActivityCandidates(
    activities.map((value) => ({
      value,
      revision: activityRevisionValue(value, 0),
    })),
  );
}

function activityRevisionValue(activity: JsonObject, parentRevision: number): number {
  return (
    nonNegative(numberValue(activity[evidenceKey.auraRevision])) ??
    parseImportTimestamp(stringValue(activity.lastUpdate) ?? stringValue(activity.lastSaved)) ??
    parentRevision
  );
}

function fuseMovesActivityCandidates(activities: MovesActivityCandidate[]): JsonObject[] {
  const groups: MovesActivityCandidate[][] = [];
  const ordered = [...activities].sort(
    (lhs, rhs) =>
      segmentStart(lhs.value) - segmentStart(rhs.value) ||
      segmentEnd(lhs.value) - segmentEnd(rhs.value) ||
      lhs.revision - rhs.revision ||
      compareStableStrings(canonicalJson(lhs.value), canonicalJson(rhs.value)),
  );
  for (const activity of ordered) {
    const matchingGroupIndexes = groups
      .map((group, index) =>
        group.some((candidate) => movesSegmentsShareRevisionIdentity(candidate.value, activity.value)) ? index : -1,
      )
      .filter((index) => index >= 0);
    if (matchingGroupIndexes.length === 0) {
      groups.push([activity]);
      continue;
    }
    const merged = [activity];
    for (const index of [...matchingGroupIndexes].reverse()) {
      merged.push(...groups[index]!);
      groups.splice(index, 1);
    }
    groups.push(merged);
  }
  return groups
    .map((group) => {
      const sorted = [...group].sort(
        (lhs, rhs) =>
          Number(lhs.value.manual === true) - Number(rhs.value.manual === true) ||
          lhs.revision - rhs.revision ||
          populatedFieldCount(lhs.value) - populatedFieldCount(rhs.value) ||
          compareStableStrings(canonicalJson(lhs.value), canonicalJson(rhs.value)),
      );
      let fused = { ...sorted.at(-1)!.value };
      for (const supplement of sorted.slice(0, -1).reverse()) {
        if (canSupplementMovesActivity(fused, supplement.value)) {
          fused = mergeMissingJsonObjects(fused, supplement.value);
        }
      }
      fused.trackPoints = fuseMovesTrackPoints(
        sorted.map((candidate) => ({
          points: arrayValue(candidate.value.trackPoints),
          revision: candidate.revision,
        })),
      );
      fused[evidenceKey.auraRevision] = sorted.at(-1)!.revision;
      return fused;
    })
    .sort(
      (lhs, rhs) =>
        segmentStart(lhs) - segmentStart(rhs) ||
        Number(rhs.manual === true) - Number(lhs.manual === true) ||
        compareStableStrings(canonicalJson(lhs), canonicalJson(rhs)),
    );
}

function fuseMovesTrackPoints(candidates: Array<{ points: JsonObject[]; revision: number }>): JsonObject[] {
  const timestamped = candidates
    .flatMap((candidate) =>
      candidate.points.map((point) => ({
        point,
        revision: candidate.revision,
        timestamp: parseImportTimestamp(stringValue(point.time) ?? stringValue(point.timestamp)),
      })),
    )
    .filter(
      (candidate): candidate is { point: JsonObject; revision: number; timestamp: number } =>
        candidate.timestamp !== null,
    );
  if (timestamped.length === 0) {
    return (
      [...candidates].sort((lhs, rhs) => lhs.revision - rhs.revision || lhs.points.length - rhs.points.length).at(-1)
        ?.points ?? []
    );
  }
  const selected = new Map<number, { point: JsonObject; revision: number }>();
  for (const candidate of timestamped.sort(
    (lhs, rhs) =>
      lhs.revision - rhs.revision || compareStableStrings(canonicalJson(lhs.point), canonicalJson(rhs.point)),
  )) {
    selected.set(candidate.timestamp, { point: candidate.point, revision: candidate.revision });
  }
  return [...selected.entries()].sort(([lhs], [rhs]) => lhs - rhs).map(([, candidate]) => candidate.point);
}

function canSupplementMovesActivity(primary: JsonObject, supplement: JsonObject): boolean {
  const primaryMode = stringValue(primary.activity);
  const supplementMode = stringValue(supplement.activity);
  return (
    primaryMode === null || supplementMode === null || mapActivityType(primaryMode) === mapActivityType(supplementMode)
  );
}

function movesSegmentHasManualEvidence(segment: JsonObject): boolean {
  return segment.manual === true || arrayValue(segment.activities).some((activity) => activity.manual === true);
}

function movesDayScore(day: JsonObject): readonly number[] {
  const segments = arrayValue(day.segments);
  const sorted = [...segments].sort((lhs, rhs) => segmentStart(lhs) - segmentStart(rhs));
  const overlapCount = sorted.slice(1).filter((segment, index) => segmentsOverlap(sorted[index]!, segment)).length;
  const durations = segments.map((segment) => segmentEnd(segment) - segmentStart(segment));
  const coverage = durations.reduce((sum, duration) => sum + Math.max(0, duration), 0);
  const medianDuration = median(durations.filter((duration) => duration > 0)) ?? 0;
  const isFragmented = segments.length >= fragmentGroupSize && medianDuration < fragmentMedianDurationThresholdS;
  return [
    durations.every((duration) => duration > 0) ? 1 : 0,
    overlapCount === 0 ? 1 : 0,
    isFragmented ? 0 : 1,
    segments.filter(movesSegmentHasManualEvidence).length,
    coverage,
    populatedFieldCount(day),
    segments.length,
  ];
}

function compareNumericTuples(lhs: readonly number[], rhs: readonly number[]): number {
  for (let index = 0; index < Math.max(lhs.length, rhs.length); index += 1) {
    const difference = (lhs[index] ?? 0) - (rhs[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function segmentStart(segment: JsonObject): number {
  return parseImportTimestamp(stringValue(segment.startTime)) ?? Number.POSITIVE_INFINITY;
}

function segmentEnd(segment: JsonObject): number {
  return parseImportTimestamp(stringValue(segment.endTime)) ?? Number.NEGATIVE_INFINITY;
}

function segmentsOverlap(lhs: JsonObject, rhs: JsonObject): boolean {
  return segmentStart(lhs) < segmentEnd(rhs) && segmentStart(rhs) < segmentEnd(lhs);
}

function normalizeMovesDay(day: JsonObject): JsonObject {
  const date = stringValue(day.date);
  if (movesDateTimestamp(date, 0) === null) {
    throw new HistoryInputError("Moves export day has an invalid date");
  }
  const segments = arrayValue(day.segments).filter(isUsableMovesSegment);
  const summary = arrayValue(day.summary).filter(isUsableMovesSummary);
  if (segments.length === 0 && summary.length === 0) {
    throw new HistoryInputError("Moves export day has no usable segments or summary");
  }
  return { ...day, segments, summary };
}

function addMovesTrackPointEvidence(day: JsonObject, ledger: EvidenceLedger): void {
  const date = stringValue(day.date) ?? "unknown";
  const segments = [...arrayValue(day.segments), ...arrayValue(day[evidenceKey.fragmentEvidence])];
  for (const [index, segment] of segments.entries()) {
    const parentItemId = `moves:${date}:${index}:${segmentStart(segment)}`;
    addMovesTrackPoints(arrayValue(segment.trackPoints), ledger, parentItemId);
    for (const activity of arrayValue(segment.activities)) {
      addMovesTrackPoints(arrayValue(activity.trackPoints), ledger, parentItemId);
    }
  }
}

function addMovesTrackPoints(points: JsonObject[], ledger: EvidenceLedger, parentItemId: string): void {
  for (const point of points) {
    const timestamp = stringValue(point.time) ?? stringValue(point.timestamp);
    const offset = extractTimezoneOffsetSeconds(timestamp);
    if (!timestamp) {
      continue;
    }
    addArcObservation(
      {
        date: timestamp,
        secondsFromGMT: offset,
        location: {
          timestamp,
          latitude: point.lat ?? point.latitude,
          longitude: point.lon ?? point.longitude,
        },
      },
      parentItemId,
      ledger,
    );
  }
}

function historyFileError(path: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to read history file ${path}: ${message}`);
}

function importArcTimelineItem(
  item: JsonObject,
  state: MutableState,
  provider: string,
  importRawEvidence = true,
): void {
  const samples = arrayValue(item.samples);
  const tzOffset = timezoneOffsetValue(samples[0]?.secondsFromGMT) ?? timezoneOffsetValue(item.secondsFromGMT);
  const itemId = stringValue(item.itemId);
  if (item.isVisit === true) {
    const stayId = importArcStay(item, state, tzOffset, provider !== providers.arcReconstruction);
    if (itemId && stayId !== null) {
      state.itemMap.set(itemId, { kind: "stay", ids: [stayId] });
    }
  } else {
    const moveId = importArcMove(item, state, tzOffset, provider);
    if (itemId && moveId !== null) {
      state.itemMap.set(itemId, { kind: "move", ids: [moveId] });
    }
  }
  if (importRawEvidence) {
    importSamples(samples, state);
  }
}

function importArcStay(
  item: JsonObject,
  state: MutableState,
  tzOffset: number | null,
  recordRawVisit: boolean,
): number | null {
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  if (start !== null && end !== null && end <= start) {
    recordDiagnostic(state, "Skipped non-positive-duration Arc stay");
    return null;
  }
  if (start === null || end === null || !validWindow(start, end)) {
    recordDiagnostic(state, "Skipped stay with invalid time window");
    return null;
  }

  const place = asObject(item.place);
  const placeId = stringValue(item.placeId) ?? stringValue(place?.placeId);
  const storedPlace = placeId ? state.arcPlaces.get(placeId) : null;
  const samples = arrayValue(item.samples);
  const center =
    locationFrom(item.center) ??
    locationFrom(place?.center) ??
    locationFrom(place?.location) ??
    storedPlace?.center ??
    locationFrom(samples[0]?.location) ??
    locationFrom(samples[0]);
  if (!center) {
    recordDiagnostic(state, "Skipped stay without coordinates");
    return null;
  }

  const radius = asObject(item.radius);
  const radiusMeters = positiveNumber(numberValue(radius?.mean)) ?? storedPlace?.radius ?? defaultStayRadiusM;
  const poiId = getOrCreateArcPoi(item, state, start);
  const type = asObject(item.place)?.isHome === true ? "anchor" : "venue";

  const row: StayRow = {
    id: state.next.stays++,
    start_ts: start,
    end_ts: end,
    centroid_lat: center.lat,
    centroid_lon: center.lon,
    radius_m: radiusMeters,
    type,
    poi_id: poiId,
    tz_offset_s: tzOffset,
  };
  state.rows.stays.push(row);
  recordSemanticEvidence(state, "stay", row.id, {
    manual: item.manualPlace === true || item.manualActivityType === true,
    revision: revisionValue(item),
    source: "arc",
  });

  if (poiId !== null) {
    state.rows.stay_pois.push({ stay_id: row.id, poi_id: poiId, role: "primary", distance_m: null });
  }

  if (recordRawVisit) {
    insertRawVisit(state, {
      arrival_ts: start,
      departure_ts: end,
      lat: center.lat,
      lon: center.lon,
      horizontal_acc_m: positiveNumber(numberValue(radius?.mean)),
      tz_offset_s: tzOffset,
    });
  }

  return row.id;
}

function importArcMove(
  item: JsonObject,
  state: MutableState,
  tzOffset: number | null,
  provider: string,
): number | null {
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  if (start !== null && end !== null && end <= start) {
    recordDiagnostic(state, "Skipped non-positive-duration Arc move");
    return null;
  }
  if (start === null || end === null || !validWindow(start, end)) {
    recordDiagnostic(state, "Skipped move with invalid time window");
    return null;
  }

  const samples = samplesWithinWindow(arrayValue(item.samples), start, end);
  const activity = isLowConfidenceArcItem(item)
    ? stringValue(item.confirmedType)
    : (stringValue(item.activityType) ?? stringValue(item.confirmedType));
  const mode = activity ? mapActivityType(activity) : dominantArcSampleMoveMode(samples);

  const preparedRoute = prepareRouteFromSamples(samples);
  const routePoints = preparedRoute.points;
  const coords = routePoints.map((point) => point.coord);
  const distance = calculatePathDistance(coords);
  const row = insertMove(state, {
    start,
    end,
    mode,
    distance,
    tzOffset,
    provider,
    manual: item.manualActivityType === true || stringValue(item.confirmedType) !== null,
    revision: revisionValue(item),
  });
  if (coords.length >= 2) {
    insertRoutePath(
      state,
      row.id,
      coords,
      provider,
      routePoints.map((point) => point.ts),
      preparedRoute.pathQuality,
    );
  }
  return row.id;
}

function dominantArcSampleMoveMode(samples: JsonObject[]): MoveMode {
  const evidence = samples.flatMap((sample) => {
    const confirmed = stringValue(sample.confirmedType);
    const coreMotion = stringValue(sample.coreMotionActivityType);
    const movingState = stringValue(sample.movingState);
    const activity = confirmed ?? coreMotion ?? movingState;
    if (!activity || activity === "stationary" || activity === "unknown" || activity === "uncertain") {
      return [];
    }
    return [{ mode: mapActivityType(activity), rank: confirmed ? 3 : coreMotion ? 2 : 1 }];
  });
  const strongestRank = evidence.reduce((rank, value) => Math.max(rank, value.rank), 0);
  const counts = new Map<MoveMode, number>();
  for (const value of evidence.filter((candidate) => candidate.rank === strongestRank)) {
    counts.set(value.mode, (counts.get(value.mode) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort((lhs, rhs) => rhs[1] - lhs[1] || compareStableStrings(lhs[0], rhs[0]))[0]?.[0] ?? "other"
  );
}

function importArcPlace(place: JsonObject, state: MutableState): number | null {
  const placeId = stringValue(place.placeId);
  const center = locationFrom(place.center) ?? locationFrom(place.location);
  if (!placeId || !center) {
    return null;
  }

  const radius = positiveNumber(numberValue(asObject(place.radius)?.mean));
  state.arcPlaces.set(placeId, {
    center,
    radius,
    timezoneOffset: timezoneOffsetValue(place.secondsFromGMT),
  });
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
    thoroughfare: stringValue(place.streetAddress),
    revision: revisionValue(place),
  });
}

function importArcBackupTimelineItem(item: JsonObject, state: MutableState): void {
  const itemId = stringValue(item.itemId);
  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  const placeId = stringValue(item.placeId);
  const tzOffset =
    timezoneOffsetValue(item.secondsFromGMT) ??
    (placeId ? (state.arcPlaces.get(placeId)?.timezoneOffset ?? null) : null);
  if (!itemId || start === null || end === null || !validWindow(start, end)) {
    recordDiagnostic(state, "Skipped backup timeline item with invalid time window");
    return;
  }

  if (state.itemMap.has(itemId)) {
    return;
  }

  if (item.isVisit === true) {
    const poiId = placeId ? (state.poiCache.get(`arc:${placeId}`) ?? null) : null;
    const poi = poiId ? (state.rows.pois.find((row) => row.id === poiId) ?? null) : null;
    const place = placeId ? state.arcPlaces.get(placeId) : null;
    const center = poi ? { lat: poi.lat, lon: poi.lon } : (place?.center ?? locationFrom(item.center));
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
      radius_m: poi?.radius_m ?? place?.radius ?? defaultStayRadiusM,
      type: "venue",
      poi_id: poiId,
      tz_offset_s: tzOffset,
    };
    state.rows.stays.push(stay);
    recordSemanticEvidence(state, "stay", stay.id, {
      manual: item.manualPlace === true || item.manualActivityType === true,
      revision: revisionValue(item),
      source: "arc",
    });
    if (poiId !== null) {
      state.rows.stay_pois.push({ stay_id: stay.id, poi_id: poiId, role: "primary", distance_m: null });
      if (poi) {
        recordPoiVisit(poi, start);
      }
    }
    insertRawVisit(state, {
      arrival_ts: start,
      departure_ts: end,
      lat: center.lat,
      lon: center.lon,
      horizontal_acc_m: poi?.radius_m ?? place?.radius ?? null,
      tz_offset_s: tzOffset,
    });
    state.itemMap.set(itemId, { kind: "stay", ids: [stay.id] });
  } else {
    const move = insertMove(state, {
      start,
      end,
      mode: mapActivityType(stringValue(item.activityType)),
      distance: null,
      tzOffset,
      provider: providers.arcBackup,
      manual: item.manualActivityType === true || stringValue(item.confirmedType) !== null,
      revision: revisionValue(item),
    });
    state.itemMap.set(itemId, { kind: "move", ids: [move.id] });
  }
}

function insertRawVisit(state: MutableState, input: Omit<RawVisitRow, "id">): void {
  const key = JSON.stringify([
    input.arrival_ts,
    input.departure_ts,
    input.lat,
    input.lon,
    input.horizontal_acc_m,
    input.tz_offset_s,
  ]);
  if (state.rawVisitKeys.has(key)) {
    return;
  }
  state.rawVisitKeys.add(key);
  state.rows.raw_visits.push({ id: state.next.raw_visits++, ...input });
}

function importArcBackupRoutes(samples: JsonObject[], state: MutableState): void {
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
    if (mapping?.kind === "move") {
      for (const moveId of mapping.ids) {
        const move = state.rows.moves.find((row) => row.id === moveId);
        const routeSamples = move
          ? group.filter((sample) => {
              const ts = sampleTimestamp(sample);
              return ts !== null && ts >= move.start_ts && (move.end_ts === null || ts <= move.end_ts);
            })
          : [];
        const preparedRoute = prepareRouteFromSamples(routeSamples);
        const routePoints = preparedRoute.points;
        const coords = routePoints.map((point) => point.coord);
        if (move && coords.length >= 2) {
          const routeDistance = calculatePathDistance(coords);
          if (semanticSource(move.provider) === "moves") {
            move.distance_m ??= routeDistance;
          } else {
            move.distance_m = routeDistance;
          }
          move.tz_offset_s = move.tz_offset_s ?? timezoneOffsetValue(routeSamples[0]?.secondsFromGMT);
          if (!state.rows.route_paths.some((path) => path.move_id === move.id)) {
            insertRoutePath(
              state,
              move.id,
              coords,
              providers.arcBackup,
              routePoints.map((point) => point.ts),
              preparedRoute.pathQuality,
            );
          }
        }
      }
    }
  }
}

function importMovesDay(day: JsonObject, state: MutableState): void {
  const movesDateKey = movesDateDayKey(stringValue(day.date));
  const summarySteps = arrayValue(day.summary)
    .map((summary) => positiveNumber(numberValue(summary.steps)))
    .filter((steps): steps is number => steps !== null)
    .reduce((sum, steps) => sum + Math.round(steps), 0);
  if (movesDateKey && summarySteps > 0) {
    state.movesSummaryStepTotals.set(movesDateKey, summarySteps);
  }
  const claimCountBefore = state.pedometerClaims.length;
  for (const segment of arrayValue(day[evidenceKey.fragmentEvidence])) {
    importMovesNestedPedometer(segment, state, movesDateKey);
  }
  const segments = arrayValue(day.segments);
  for (const segment of segments) {
    importMovesNestedPedometer(segment, state, movesDateKey);
    const start = parseImportTimestamp(stringValue(segment.startTime));
    const end = parseImportTimestamp(stringValue(segment.endTime));
    if (start === null || end === null || !validWindow(start, end)) {
      recordDiagnostic(state, "Skipped Moves segment with invalid time window");
      continue;
    }
    const type = stringValue(segment.type);
    if (type === "place" && locationFrom(asObject(segment.place)?.location) === null) {
      importMovesActivitiesOnlyPlace(segment, state, start, end);
      continue;
    }
    if (!canMaterializeMovesSegment(segment, type, start, end)) {
      recordDiagnostic(state, "Skipped Moves segment without usable evidence");
      continue;
    }
    const replacedStay = type === "place" ? matchingStayEvidence(segment, state, start, end) : null;
    if (type === "place") {
      importMovesPlace(segment, state, replacedStay);
    } else if (type === "move") {
      importMovesMove(segment, state);
    } else if (type === "off") {
      importMovesOff(segment, state);
    }
  }
  const dayClaims = state.pedometerClaims.slice(claimCountBefore).filter((claim) => claim.source === "moves");
  const leafSteps = dayClaims.reduce((sum, claim) => sum + (claim.steps ?? 0), 0);
  if (leafSteps === 0) {
    importMovesSummaryPedometer(day, state, movesDateKey);
  } else if (summarySteps > leafSteps) {
    const summaryDistance = arrayValue(day.summary)
      .filter((summary) => positiveNumber(numberValue(summary.steps)) !== null)
      .reduce((sum, summary) => sum + (nonNegative(numberValue(summary.distance)) ?? 0), 0);
    const leafDistance = dayClaims.reduce((sum, claim) => sum + (claim.distance ?? 0), 0);
    const timestamp = movesSummaryTimestamp(day);
    if (timestamp !== null) {
      const endTime = arrayValue(day.segments)
        .map((segment) => stringValue(segment.endTime))
        .find((value) => parseImportTimestamp(value) === timestamp);
      importMovesPedometer(
        {
          steps: summarySteps - leafSteps,
          distance: Math.max(0, summaryDistance - leafDistance),
          endTime,
        },
        timestamp,
        state,
        movesDateKey,
      );
    }
  }
}

function importMovesActivitiesOnlyPlace(segment: JsonObject, state: MutableState, start: number, end: number): void {
  if (!hasSemanticCoverage(state, start, end)) {
    insertImportGap(state, start, end, timelineNote.movesPlaceWithoutLocation);
  }
  for (const activity of fuseMovesActivities(arrayValue(segment.activities))) {
    const activityStart = parseImportTimestamp(stringValue(activity.startTime));
    const activityEnd = parseImportTimestamp(stringValue(activity.endTime));
    if (activityStart === null || activityEnd === null || !validWindow(activityStart, activityEnd)) {
      continue;
    }
    importMovesMove(
      {
        type: "move",
        startTime: activity.startTime,
        endTime: activity.endTime,
        activities: [activity],
      },
      state,
    );
  }
}

function hasSemanticCoverage(state: MutableState, start: number, end: number): boolean {
  return [...state.rows.stays, ...state.rows.moves, ...state.rows.no_data_gaps].some(
    (row) => row.start_ts < end && (row.end_ts ?? Number.POSITIVE_INFINITY) > start,
  );
}

function canMaterializeMovesSegment(segment: JsonObject, type: string | null, start: number, end: number): boolean {
  if (type === "place") {
    return locationFrom(asObject(segment.place)?.location) !== null;
  }
  if (type === "off") {
    return true;
  }
  if (type !== "move") {
    return false;
  }
  const activities = arrayValue(segment.activities);
  if (activities.length === 0) {
    return (
      stringValue(segment.activity) !== null ||
      positiveNumber(numberValue(segment.distance)) !== null ||
      coordinatesFromTrackPoints(arrayValue(segment.trackPoints), start, end).length >= 2 ||
      segment.manual === true
    );
  }
  return activities.some((activity) => {
    const activityStart = parseImportTimestamp(stringValue(activity.startTime));
    const activityEnd = parseImportTimestamp(stringValue(activity.endTime));
    return activityStart !== null && activityEnd !== null && activityEnd > start && activityStart < end;
  });
}

function matchingStayEvidence(
  segment: JsonObject,
  state: MutableState,
  start: number,
  end: number,
): ReplacedStayEvidence | null {
  const center = locationFrom(asObject(segment.place)?.location);
  if (!center) {
    return null;
  }
  let best: { evidence: ReplacedStayEvidence; overlap: number } | null = null;
  for (const stay of state.rows.stays) {
    const stayEnd = stay.end_ts ?? Number.POSITIVE_INFINITY;
    const overlap = Math.min(stayEnd, end) - Math.max(stay.start_ts, start);
    if (overlap <= 0 || overlap / (end - start) < 0.5) {
      continue;
    }
    const distance = haversineDistance(center.lat, center.lon, stay.centroid_lat, stay.centroid_lon);
    if (distance > Math.max(stayMatchingBufferM, stay.radius_m + stayMatchingBufferM)) {
      continue;
    }
    const evidence = {
      poiId: stay.poi_id,
      radius: stay.radius_m,
      type: stay.type,
      distance,
    };
    if (!best || overlap > best.overlap || (overlap === best.overlap && distance < best.evidence.distance)) {
      best = { evidence, overlap };
    }
  }
  return best?.evidence ?? null;
}

function importMovesOff(segment: JsonObject, state: MutableState): void {
  const start = parseImportTimestamp(stringValue(segment.startTime));
  const end = parseImportTimestamp(stringValue(segment.endTime));
  if (start === null || end === null || !validWindow(start, end)) {
    recordDiagnostic(state, "Skipped Moves tracking-off segment with invalid time window");
    return;
  }
  state.rows.no_data_gaps.push({
    id: state.next.no_data_gaps++,
    start_ts: start,
    end_ts: end,
    reason: "Unknown",
    uncertainty: null,
    notes: timelineNote.movesTrackingOff,
  });
}

function importMovesPlace(segment: JsonObject, state: MutableState, replacedStay: ReplacedStayEvidence | null): void {
  const place = asObject(segment.place);
  const start = parseImportTimestamp(stringValue(segment.startTime));
  const end = parseImportTimestamp(stringValue(segment.endTime));
  const center = locationFrom(place?.location);
  if (!place || !center || start === null || end === null || !validWindow(start, end)) {
    return;
  }

  const movesIdentity = canonicalMovesPlaceIdentity(state, movesPlaceIdentity(place));
  const movesPlaceId = movesIdentity.id;
  const name = meaningfulName(place.name);
  const placeType = stringValue(place.type)?.toLowerCase() ?? null;
  const category =
    placeType ?? (Array.isArray(place.foursquareCategoryIds) ? stringValue(place.foursquareCategoryIds[0]) : null);
  const movesPoiId = movesPlaceId
    ? resolveMovesPoi(
        state,
        movesPlaceId,
        movesIdentity.rank,
        movesIdentity.aliases,
        name,
        category,
        center,
        start,
        parseImportTimestamp(stringValue(segment.lastUpdate)) ?? start,
      )
    : null;
  const poiId = movesPoiId ?? replacedStay?.poiId ?? null;

  const stay: StayRow = {
    id: state.next.stays++,
    start_ts: start,
    end_ts: end,
    centroid_lat: center.lat,
    centroid_lon: center.lon,
    radius_m: replacedStay?.radius ?? defaultStayRadiusM,
    type:
      placeType === "home" || placeType === "work" || placeType === "school"
        ? "anchor"
        : (replacedStay?.type ?? "venue"),
    poi_id: poiId,
    tz_offset_s: extractTimezoneOffsetSeconds(stringValue(segment.startTime)),
  };
  state.rows.stays.push(stay);
  recordSemanticEvidence(state, "stay", stay.id, {
    manual: segment.manual === true,
    revision: movesRevisionValue(segment, segment),
    source: "moves",
  });
  if (poiId !== null) {
    state.rows.stay_pois.push({ stay_id: stay.id, poi_id: poiId, role: "primary", distance_m: null });
    if (
      movesPoiId !== null &&
      replacedStay?.poiId !== null &&
      replacedStay?.poiId !== undefined &&
      replacedStay.poiId !== movesPoiId
    ) {
      state.rows.stay_pois.push({
        stay_id: stay.id,
        poi_id: replacedStay.poiId,
        role: "secondary",
        distance_m: replacedStay.distance,
      });
    }
  } else {
    for (const alias of movesIdentity.aliases) {
      const pending = state.pendingMovesStays.get(alias) ?? [];
      pending.push(stay);
      state.pendingMovesStays.set(alias, pending);
    }
  }
}

function meaningfulName(value: unknown): string | null {
  const name = stringValue(value)?.trim();
  return name && name.length > 0 ? name : null;
}

function resolveMovesPoi(
  state: MutableState,
  placeId: string,
  identityRank: number,
  aliases: string[],
  name: string | null,
  category: string | null,
  center: { lat: number; lon: number },
  seenTs: number,
  revision: number,
): number | null {
  const cacheKey = `moves:${placeId}`;
  const existingId = aliases
    .map((alias) => state.poiCache.get(`moves:${alias}`))
    .find((value): value is number => value !== undefined);
  if (existingId !== undefined) {
    state.poiCache.set(cacheKey, existingId);
  }
  if (!name) {
    if (!existingId) {
      return null;
    }
    const existing = state.rows.pois.find((row) => row.id === existingId);
    if (existing) {
      existing.visitCount += 1;
      existing.first_seen_ts = existing.first_seen_ts === null ? seenTs : Math.min(existing.first_seen_ts, seenTs);
      existing.last_seen_ts = existing.last_seen_ts === null ? seenTs : Math.max(existing.last_seen_ts, seenTs);
    }
    for (const alias of aliases) {
      state.poiCache.set(`moves:${alias}`, existingId);
    }
    state.movesPoiIdentityRanks.set(
      existingId,
      Math.max(identityRank, state.movesPoiIdentityRanks.get(existingId) ?? 0),
    );
    return existingId;
  }

  const existing = existingId ? state.rows.pois.find((row) => row.id === existingId) : null;
  const existingIdentityRank = existingId ? (state.movesPoiIdentityRanks.get(existingId) ?? 0) : 0;
  const providerId = existing && existingIdentityRank > identityRank ? (existing.provider_poi_id ?? placeId) : placeId;
  const poiId = insertPoi(state, {
    provider: "moves",
    providerId,
    name,
    category,
    lat: center.lat,
    lon: center.lon,
    radius: null,
    seenTs,
    thoroughfare: null,
    revision,
  });
  for (const alias of aliases) {
    state.poiCache.set(`moves:${alias}`, poiId);
  }
  if (identityRank >= existingIdentityRank) {
    const poi = state.rows.pois.find((row) => row.id === poiId);
    if (poi) {
      poi.provider_poi_id = placeId;
    }
    state.movesPoiIdentityRanks.set(poiId, identityRank);
  }
  const pending = [
    ...new Map(
      aliases.flatMap((alias) => state.pendingMovesStays.get(alias) ?? []).map((stay) => [stay.id, stay]),
    ).values(),
  ];
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
    for (const alias of aliases) {
      state.pendingMovesStays.delete(alias);
    }
  }
  return poiId;
}

function importMovesMove(segment: JsonObject, state: MutableState): void {
  const start = parseImportTimestamp(stringValue(segment.startTime));
  const end = parseImportTimestamp(stringValue(segment.endTime));
  if (start === null || end === null || !validWindow(start, end)) {
    return;
  }

  const activities = fuseMovesActivities(arrayValue(segment.activities));
  if (activities.length === 0) {
    const preparedRoute = prepareRouteFromTrackPoints(arrayValue(segment.trackPoints), start, end);
    const routePoints = preparedRoute.points;
    const coords = routePoints.map((point) => point.coord);
    const move = insertMove(state, {
      start,
      end,
      mode: mapActivityType(stringValue(segment.activity)),
      distance: positiveNumber(numberValue(segment.distance)) ?? calculatePathDistance(coords),
      tzOffset: extractTimezoneOffsetSeconds(stringValue(segment.startTime)),
      provider: providers.movesExport,
      manual: segment.manual === true,
      revision: movesRevisionValue(segment, segment),
    });
    if (coords.length >= 2) {
      insertRoutePath(
        state,
        move.id,
        coords,
        providers.movesExport,
        routePoints.map((point) => point.ts),
        preparedRoute.pathQuality,
      );
    }
    importMovesPedometer(segment, end, state);
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
        end: Math.min(activityEnd, end),
      };
    })
    .filter(
      (activity): activity is { activity: JsonObject; start: number; end: number } =>
        activity !== null && activity.end > activity.start,
    )
    .sort((lhs, rhs) => lhs.start - rhs.start);

  const segmentRevision = movesRevisionValue(segment, segment);
  for (const normalizedActivity of normalized) {
    const activity = normalizedActivity.activity;
    const combinedTrackPoints = fuseMovesTrackPoints([
      { points: arrayValue(segment.trackPoints), revision: segmentRevision },
      { points: arrayValue(activity.trackPoints), revision: activityRevisionValue(activity, segmentRevision) },
    ]);
    const preparedRoute = prepareRouteFromTrackPoints(
      combinedTrackPoints,
      normalizedActivity.start,
      normalizedActivity.end,
    );
    const routePoints = preparedRoute.points;
    const effectiveCoords = routePoints.map((point) => point.coord);
    const move = insertMove(state, {
      start: normalizedActivity.start,
      end: normalizedActivity.end,
      mode: mapActivityType(stringValue(activity.activity)),
      distance: positiveNumber(numberValue(activity.distance)) ?? calculatePathDistance(effectiveCoords),
      tzOffset: extractTimezoneOffsetSeconds(stringValue(activity.startTime)),
      provider: providers.movesExport,
      manual: activity.manual === true || segment.manual === true,
      revision: Math.max(activityRevisionValue(activity, 0), movesRevisionValue(segment, segment)),
    });
    if (effectiveCoords.length >= 2) {
      insertRoutePath(
        state,
        move.id,
        effectiveCoords,
        providers.movesExport,
        routePoints.map((point) => point.ts),
        preparedRoute.pathQuality,
      );
    }
    importMovesPedometer(activity, normalizedActivity.end, state);
  }
}

function importMovesPedometer(
  value: JsonObject,
  end: number,
  state: MutableState,
  sourceDayKey: string | null = null,
): boolean {
  const rawSteps = positiveNumber(numberValue(value.steps));
  const steps = rawSteps === null ? null : Math.round(rawSteps);
  if (steps === null) {
    return false;
  }
  const start = parseImportTimestamp(stringValue(value.startTime));
  const key = `${start ?? ""}|${end}|${steps}|${nonNegative(numberValue(value.distance)) ?? ""}`;
  if (state.movesPedometerKeys.has(key)) {
    return false;
  }
  state.movesPedometerKeys.add(key);
  const timezoneOffset = extractTimezoneOffsetSeconds(stringValue(value.endTime) ?? stringValue(value.startTime));
  const activity = stringValue(value.activity);
  state.pedometerClaims.push({
    source: "moves",
    kind: stringValue(value.startTime) && stringValue(value.endTime) ? "leaf" : "summary",
    dayKey: sourceDayKey ?? pedometerDayKey(end, timezoneOffset),
    start,
    end,
    steps,
    distance: validatedPedometerDistance(steps, nonNegative(numberValue(value.distance)), activity),
    floorsUp: null,
    floorsDown: null,
    timezoneOffset,
    manual: value.manual === true,
    sequence: null,
    mode: activity,
  });
  return true;
}

function importMovesNestedPedometer(segment: JsonObject, state: MutableState, sourceDayKey: string | null): void {
  const activities = fuseMovesActivities(arrayValue(segment.activities));
  if (activities.length === 0) {
    const end = parseImportTimestamp(stringValue(segment.endTime));
    if (end !== null) {
      importMovesPedometer(segment, end, state, sourceDayKey);
    }
    return;
  }
  for (const activity of activities) {
    const end = parseImportTimestamp(stringValue(activity.endTime));
    if (end !== null) {
      importMovesPedometer(activity, end, state, sourceDayKey);
    }
  }
}

function importMovesSummaryPedometer(day: JsonObject, state: MutableState, sourceDayKey: string | null): void {
  const timestamp = movesSummaryTimestamp(day);
  if (timestamp === null) {
    return;
  }
  const timezoneTimestamp = arrayValue(day.segments)
    .flatMap((segment) => [stringValue(segment.endTime), stringValue(segment.startTime)])
    .find((value) => extractTimezoneOffsetSeconds(value) !== null);
  for (const summary of arrayValue(day.summary)) {
    importMovesPedometer({ ...summary, endTime: timezoneTimestamp ?? undefined }, timestamp, state, sourceDayKey);
  }
}

function movesSummaryTimestamp(day: JsonObject): number | null {
  const segmentEnds = arrayValue(day.segments).map(segmentEnd).filter(Number.isFinite);
  const date = stringValue(day.date);
  const dayEnd = movesDateTimestamp(date, 12);
  const timestamp = segmentEnds.length > 0 ? Math.max(...segmentEnds) : dayEnd;
  return timestamp !== null && timestamp >= 0 ? timestamp : null;
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
    revision?: number;
  },
): number {
  const cacheKey = input.providerId ? `${input.provider}:${input.providerId}` : null;
  if (cacheKey) {
    const existingId = state.poiCache.get(cacheKey);
    if (existingId) {
      const existing = state.rows.pois.find((row) => row.id === existingId);
      if (existing) {
        if (input.seenTs !== null) {
          recordPoiVisit(existing, input.seenTs);
        }
        const revision = input.revision ?? input.seenTs ?? 0;
        if (revision >= (state.poiRevisions.get(existingId) ?? 0)) {
          existing.provider = input.provider;
          existing.provider_poi_id = input.providerId;
          existing.name = input.name.trim();
          existing.category = input.category;
          existing.lat = input.lat;
          existing.lon = input.lon;
          existing.radius_m = input.radius ?? existing.radius_m;
          existing.thoroughfare = input.thoroughfare ?? existing.thoroughfare;
          state.poiRevisions.set(existingId, revision);
        }
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
    country: null,
  };
  state.rows.pois.push(row);
  state.poiRevisions.set(row.id, input.revision ?? input.seenTs ?? 0);
  if (cacheKey) {
    state.poiCache.set(cacheKey, row.id);
  }
  return row.id;
}

function recordPoiVisit(poi: PoiRow, seenTs: number): void {
  poi.visitCount += 1;
  poi.first_seen_ts = poi.first_seen_ts === null ? seenTs : Math.min(poi.first_seen_ts, seenTs);
  poi.last_seen_ts = poi.last_seen_ts === null ? seenTs : Math.max(poi.last_seen_ts, seenTs);
}

function getOrCreateArcPoi(item: JsonObject, state: MutableState, firstSeen: number): number | null {
  const place = asObject(item.place);
  if (!place) {
    const placeId = stringValue(item.placeId);
    const existingId = placeId ? state.poiCache.get(`arc:${placeId}`) : undefined;
    const existing = existingId ? state.rows.pois.find((poi) => poi.id === existingId) : null;
    if (existing) {
      recordPoiVisit(existing, firstSeen);
      return existing.id;
    }
    return null;
  }

  const mapboxId = stringValue(place.mapboxPlaceId);
  const placeId = stringValue(place.placeId);
  const provider = mapboxId ? "mapbox" : "arc";
  const providerId = mapboxId ?? placeId;
  const center = locationFrom(place.center) ?? locationFrom(place.location);
  const name = meaningfulName(place.name);
  if (!center || !name) {
    return null;
  }

  const radius = asObject(place.radius);
  const existingArcId = placeId ? state.poiCache.get(`arc:${placeId}`) : undefined;
  if (existingArcId) {
    state.poiCache.set(`${provider}:${providerId}`, existingArcId);
  }
  const poiId = insertPoi(state, {
    provider,
    providerId,
    name,
    category: stringValue(place.mapboxCategory),
    lat: center.lat,
    lon: center.lon,
    radius: positiveNumber(numberValue(radius?.mean)),
    seenTs: firstSeen,
    thoroughfare: stringValue(place.streetAddress),
    revision: Math.max(revisionValue(item), revisionValue(place)),
  });
  if (placeId) {
    state.poiCache.set(`arc:${placeId}`, poiId);
  }
  if (mapboxId) {
    state.poiCache.set(`mapbox:${mapboxId}`, poiId);
  }
  return poiId;
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
    manual?: boolean;
    revision?: number;
  },
): MoveRow {
  const duplicate = findDuplicateMove(state, input.start, input.end, input.mode);
  if (duplicate) {
    const preferMovesProvenance =
      duplicate.start_ts < movesLastServiceDayEndTs &&
      semanticSource(duplicate.provider) === "arc" &&
      semanticSource(input.provider) === "moves";
    if (preferMovesProvenance) {
      duplicate.provider = input.provider;
      duplicate.distance_m = input.distance ?? duplicate.distance_m;
      duplicate.tz_offset_s = input.tzOffset ?? duplicate.tz_offset_s;
      state.semanticEvidence.set(`move:${duplicate.id}`, {
        manual: input.manual === true,
        revision: input.revision ?? 0,
        source: "moves",
      });
    } else {
      recordSemanticEvidence(state, "move", duplicate.id, {
        manual: input.manual === true,
        revision: input.revision ?? 0,
        source: semanticSource(input.provider),
      });
    }
    return duplicate;
  }

  const row: MoveRow = {
    id: state.next.moves++,
    start_ts: input.start,
    end_ts: input.end,
    mode: input.mode,
    distance_m: input.distance,
    tz_offset_s: input.tzOffset,
    provider: input.provider,
  };
  state.rows.moves.push(row);
  const bucketKey = moveBucketKey(input.start, input.end, input.mode);
  const bucket = state.moveIndex.get(bucketKey) ?? [];
  bucket.push(row);
  state.moveIndex.set(bucketKey, bucket);
  recordSemanticEvidence(state, "move", row.id, {
    manual: input.manual === true,
    revision: input.revision ?? 0,
    source: semanticSource(input.provider),
  });
  return row;
}

function findDuplicateMove(state: MutableState, start: number, end: number, mode: MoveMode): MoveRow | undefined {
  const startBucket = Math.round(start * 1_000_000);
  const endBucket = Math.round(end * 1_000_000);
  for (let startOffset = -1; startOffset <= 1; startOffset += 1) {
    for (let endOffset = -1; endOffset <= 1; endOffset += 1) {
      const bucket = state.moveIndex.get(`${startBucket + startOffset}|${endBucket + endOffset}|${mode}`);
      if (bucket === undefined) {
        continue;
      }
      const duplicate = bucket.find(
        (move) =>
          Math.abs(move.start_ts - start) < duplicateTimestampToleranceS &&
          Math.abs((move.end_ts ?? 0) - end) < duplicateTimestampToleranceS,
      );
      if (duplicate !== undefined) {
        return duplicate;
      }
    }
  }
  return undefined;
}

function moveBucketKey(start: number, end: number, mode: MoveMode): string {
  return `${Math.round(start * 1_000_000)}|${Math.round(end * 1_000_000)}|${mode}`;
}

function semanticSource(provider: string | null): SemanticEvidence["source"] {
  if (provider?.startsWith("arc")) {
    return "arc";
  }
  if (provider?.startsWith("moves")) {
    return "moves";
  }
  return provider?.startsWith("generated") || provider?.includes("reconstruction") ? "generated" : "unknown";
}

function recordSemanticEvidence(
  state: MutableState,
  kind: SemanticRef["kind"],
  id: number,
  evidence: SemanticEvidence,
): void {
  const key = `${kind}:${id}`;
  const incoming: SemanticEvidence = {
    manual: evidence.manual,
    revision: evidence.revision,
    source: evidence.source,
  };
  const existing = state.semanticEvidence.get(key);
  if (!existing) {
    state.semanticEvidence.set(key, incoming);
    return;
  }
  state.semanticEvidence.set(key, {
    manual: existing.manual || incoming.manual,
    revision: Math.max(existing.revision, incoming.revision),
    source: incoming.manual && !existing.manual ? incoming.source : existing.source,
  });
}

function insertRoutePath(
  state: MutableState,
  moveId: number,
  coords: Array<[number, number]>,
  provider: string,
  timestamps: Array<number | null> = coords.map(() => null),
  pathQuality: PreparedRoute["pathQuality"] = "raw",
): RoutePathRow | null {
  const bounds = calculateBounds(coords);
  if (!bounds || coords.length < 2) {
    return null;
  }

  state.routeEvidence.set(moveId, {
    points: coords.map((coord, index) => ({ coord, ts: timestamps[index] ?? null })),
    provider,
    pathQuality,
  });

  const row: RoutePathRow = {
    id: state.next.route_paths++,
    move_id: moveId,
    is_primary: 1,
    codec: "bqdc-v1",
    compression: "none",
    quantization_cm: defaultBqdcQuantizationCm,
    path_blob: encodeBQDCPath(coords),
    sample_count: coords.length,
    path_quality: pathQuality,
    provider,
    bbox_min_lat: bounds.minLat,
    bbox_min_lon: bounds.minLon,
    bbox_max_lat: bounds.maxLat,
    bbox_max_lon: bounds.maxLon,
    lod_level: 0,
  };
  state.rows.route_paths.push(row);
  return row;
}

function importSamples(samples: JsonObject[], state: MutableState): number {
  const rawGPSRows: RawGPSRow[] = [];
  const sampleRows: SampleRow[] = [];
  const motionRows: RawMotionActivityRow[] = [];
  for (const sample of samples) {
    const location = asObject(sample.location) ?? sample;
    const point = locationFrom(location);
    const ts = parseImportTimestamp(stringValue(location?.timestamp) ?? stringValue(sample.date));
    if (ts === null || ts < 0) {
      continue;
    }
    const tzOffset = timezoneOffsetValue(sample.secondsFromGMT);
    if (point) {
      const altitude = numberValue(location?.altitude);
      const hAcc = nonNegative(numberValue(location?.horizontalAccuracy));
      const vAcc = nonNegative(numberValue(location?.verticalAccuracy));
      const speed = nonNegative(numberValue(location?.speed));
      const speedAccuracy = nonNegative(numberValue(location?.speedAccuracy));
      const course = normalizeCourse(numberValue(location?.course));
      const courseAccuracy = courseAccuracyValue(location?.courseAccuracy);

      const rawGPS: RawGPSRow = {
        id: state.next.raw_gps++,
        ts,
        lat: point.lat,
        lon: point.lon,
        altitude_m: altitude,
        h_acc_m: hAcc,
        v_acc_m: vAcc,
        speed_mps: speed,
        speed_acc_mps: speedAccuracy,
        course_deg: course,
        course_acc_deg: courseAccuracy,
        tz_offset_s: tzOffset,
        provider: "unknown",
        is_simulated: 0,
      };
      rawGPSRows.push(rawGPS);

      const sampleRow: SampleRow = {
        id: state.next.samples++,
        ts,
        lat: point.lat,
        lon: point.lon,
        altitude_m: altitude,
        speed_mps: speed,
        speed_acc_mps: speedAccuracy,
        course_deg: course,
        course_acc_deg: courseAccuracy,
        h_acc_m: hAcc,
        v_acc_m: vAcc,
        estimator: "raw",
        source_kind: "raw",
        flags: null,
        step_delta: null,
        tz_offset_s: tzOffset,
      };
      sampleRows.push(sampleRow);
    }

    const confirmedActivity = stringValue(sample.confirmedType);
    const coreMotionActivity = stringValue(sample.coreMotionActivityType);
    const movingState = stringValue(sample.movingState);
    const activity = confirmedActivity ?? coreMotionActivity ?? movingState;
    if (activity) {
      const confidence = confirmedActivity ? 2 : coreMotionActivity ? 1 : 0;
      motionRows.push(makeMotionActivityRow(state, ts, activity, confidence, tzOffset));
    }
  }
  emitRows(state, "raw_gps", rawGPSRows);
  emitRows(state, "samples", sampleRows);
  emitRows(state, "raw_motion_activity", motionRows);
  return rawGPSRows.length;
}

function makeMotionActivityRow(
  state: MutableState,
  ts: number,
  activity: string,
  confidence: 0 | 1 | 2,
  tzOffset: number | null,
): RawMotionActivityRow {
  const key = activity.trim().toLowerCase();
  return {
    id: state.next.raw_motion_activity++,
    ts,
    confidence,
    is_stationary: key === "stationary" ? 1 : 0,
    is_walking: key === "walking" || key === "walk" ? 1 : 0,
    is_running: key === "running" || key === "run" ? 1 : 0,
    is_automotive: key === "car" || key === "automotive" ? 1 : 0,
    is_cycling: key === "cycling" || key === "bicycle" ? 1 : 0,
    is_on_foot: key === "walking" || key === "walk" || key === "running" || key === "run" ? 1 : 0,
    is_unknown: key === "unknown" ? 1 : 0,
    tz_offset_s: tzOffset,
  };
}

function importPedometerData(
  item: JsonObject,
  state: MutableState,
  tzOffset: number | null,
  sequence: number,
): boolean {
  const steps = positiveNumber(numberValue(item.stepCount) ?? numberValue(item.hkStepCount));
  const floorsUp = positiveNumber(numberValue(item.floorsAscended));
  const floorsDown = positiveNumber(numberValue(item.floorsDescended));
  if (steps === null && floorsUp === null && floorsDown === null) {
    return false;
  }

  const start = parseImportTimestamp(stringValue(item.startDate));
  const end = parseImportTimestamp(stringValue(item.endDate));
  if (end === null) {
    return false;
  }

  const samples = arrayValue(item.samples);
  const activity = stringValue(item.activityType) ?? stringValue(item.confirmedType);
  const moveMode =
    item.isVisit === true ? null : activity ? mapActivityType(activity) : dominantArcSampleMoveMode(samples);
  const coords = coordinatesFromSamples(samples);
  const roundedSteps = steps === null ? null : Math.round(steps);
  state.pedometerClaims.push({
    source: "arc",
    kind: item.isVisit === true ? "stay" : "move",
    dayKey: pedometerDayKey(end, tzOffset),
    start,
    end,
    steps: roundedSteps,
    distance: validatedPedometerDistance(roundedSteps, calculatePathDistance(coords), moveMode),
    floorsUp,
    floorsDown,
    timezoneOffset: tzOffset,
    manual: item.manualActivityType === true,
    sequence,
    mode: activity,
  });
  return true;
}

function validatedPedometerDistance(
  steps: number | null,
  distance: number | null,
  activity: string | null,
): number | null {
  if (steps === null || steps <= 0 || distance === null || activity === null) {
    return null;
  }
  const mode = mapActivityType(activity);
  if (mode !== "walk" && mode !== "run") {
    return null;
  }
  const metersPerStep = distance / steps;
  return metersPerStep >= minimumPedometerMetersPerStep && metersPerStep <= maximumPedometerMetersPerStep
    ? distance
    : null;
}

function materializePedometerClaims(state: MutableState, signal?: AbortSignal): void {
  const grouped = new Map<string, PedometerClaim[]>();
  const canonicalClaims = [
    ...canonicalArcPedometerClaims(state.pedometerClaims.filter((claim) => claim.source === "arc")),
    ...state.pedometerClaims.filter((claim) => claim.source === "moves"),
  ];
  for (const claim of alignPedometerClaimDays(canonicalClaims)) {
    throwIfAborted(signal);
    const key = claim.dayKey ?? `timestamp:${claim.end}`;
    const group = grouped.get(key) ?? [];
    group.push(claim);
    grouped.set(key, group);
  }

  const selected: PedometerClaim[] = [];
  for (const [dayKey, claims] of grouped) {
    throwIfAborted(signal);
    const arc = claims.filter((claim) => claim.source === "arc");
    const moves = claims.filter((claim) => claim.source === "moves");
    if (arc.length === 0 || moves.length === 0) {
      selected.push(...(moves.length > 0 ? moves : arc));
      continue;
    }
    const movesTotal = moves.reduce((sum, claim) => sum + (claim.steps ?? 0), 0);
    const summaryTotal = state.movesSummaryStepTotals.get(dayKey);
    const movesValidated = summaryTotal !== undefined && movesTotal === summaryTotal;
    const components = pedometerClaimComponents(arc, moves);
    for (const component of components) {
      throwIfAborted(signal);
      const componentArc = component.filter((claim) => claim.source === "arc");
      const componentMoves = component.filter((claim) => claim.source === "moves");
      if (componentArc.length === 0 || componentMoves.length === 0) {
        selected.push(...component);
        continue;
      }
      const matchingPreShutdownMoves = componentMoves.some(
        (move) =>
          move.end < movesLastServiceDayEndTs &&
          move.steps !== null &&
          componentArc.some((arcClaim) => arcClaim.steps === move.steps),
      );
      const chooseMoves =
        matchingPreShutdownMoves || movesValidated || comparePedometerClaimGroups(componentMoves, componentArc) >= 0;
      selected.push(...(chooseMoves ? componentMoves : componentArc));
      if (chooseMoves) {
        selected.push(
          ...componentArc
            .filter((claim) => claim.floorsUp !== null || claim.floorsDown !== null)
            .map((claim) => ({ ...claim, steps: null, distance: null })),
        );
      }
    }
  }

  const seen = new Set<string>();
  const rows: RawPedometerRow[] = [];
  for (const claim of selected.sort(
    (lhs, rhs) => lhs.end - rhs.end || compareStableStrings(canonicalJson(lhs), canonicalJson(rhs)),
  )) {
    throwIfAborted(signal);
    if (claim.steps === null && claim.floorsUp === null && claim.floorsDown === null) {
      continue;
    }
    const identity = [
      claim.end,
      claim.steps,
      claim.distance,
      claim.floorsUp,
      claim.floorsDown,
      claim.timezoneOffset,
    ].join("|");
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    rows.push({
      id: state.next.raw_pedometer++,
      ts: claim.end,
      steps_delta: claim.steps,
      distance_m: claim.distance,
      cadence_spm: null,
      pace_s_per_m: null,
      floors_up: claim.floorsUp,
      floors_down: claim.floorsDown,
      tz_offset_s: claim.timezoneOffset,
    });
  }
  emitRows(state, "raw_pedometer", rows);
}

function pedometerClaimComponents(arc: PedometerClaim[], moves: PedometerClaim[]): PedometerClaim[][] {
  const claims = [...arc, ...moves];
  const remaining = new Set(claims.map((_, index) => index));
  const components: PedometerClaim[][] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as number;
    remaining.delete(first);
    const pending = [first];
    const component: PedometerClaim[] = [];
    while (pending.length > 0) {
      const index = pending.pop()!;
      const claim = claims[index]!;
      component.push(claim);
      for (const candidateIndex of [...remaining]) {
        const candidate = claims[candidateIndex]!;
        if (candidate.source !== claim.source && pedometerWindowsMatch(claim, candidate)) {
          remaining.delete(candidateIndex);
          pending.push(candidateIndex);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function alignPedometerClaimDays(claims: PedometerClaim[]): PedometerClaim[] {
  const moves = claims.filter((claim) => claim.source === "moves" && claim.dayKey !== null);
  return claims.map((claim) => {
    if (claim.source !== "arc") {
      return claim;
    }
    const match = moves
      .filter((candidate) => pedometerWindowsMatch(claim, candidate))
      .sort((lhs, rhs) => pedometerWindowOverlap(claim, rhs) - pedometerWindowOverlap(claim, lhs))[0];
    return match
      ? {
          ...claim,
          dayKey: match.dayKey,
          timezoneOffset: claim.timezoneOffset ?? match.timezoneOffset,
        }
      : claim;
  });
}

function pedometerWindowsMatch(lhs: PedometerClaim, rhs: PedometerClaim): boolean {
  if (lhs.start === null || rhs.start === null) {
    return Math.abs(lhs.end - rhs.end) <= 90;
  }
  const lhsDuration = Math.max(1, lhs.end - lhs.start);
  const rhsDuration = Math.max(1, rhs.end - rhs.start);
  const overlap = pedometerWindowOverlap(lhs, rhs);
  return (
    overlap / Math.min(lhsDuration, rhsDuration) >= 0.5 ||
    (Math.abs(lhs.start - rhs.start) <= 90 && Math.abs(lhs.end - rhs.end) <= 90)
  );
}

function pedometerWindowOverlap(lhs: PedometerClaim, rhs: PedometerClaim): number {
  if (lhs.start === null || rhs.start === null) {
    return 0;
  }
  return Math.max(0, Math.min(lhs.end, rhs.end) - Math.max(lhs.start, rhs.start));
}

function canonicalArcPedometerClaims(claims: PedometerClaim[]): PedometerClaim[] {
  const sorted = [...claims].sort((lhs, rhs) => {
    if (lhs.sequence !== null && rhs.sequence !== null) {
      return lhs.sequence - rhs.sequence;
    }
    if (lhs.sequence !== null || rhs.sequence !== null) {
      return lhs.sequence !== null ? -1 : 1;
    }
    return (lhs.start ?? lhs.end) - (rhs.start ?? rhs.end) || lhs.end - rhs.end;
  });
  const selected: PedometerClaim[] = [];
  let cluster: PedometerClaim[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  const flush = (): void => {
    if (cluster.length === 0) {
      return;
    }
    const shouldDeduplicate =
      cluster.length > 1 &&
      (new Set(cluster.map((claim) => claim.kind)).size > 1 ||
        cluster.some((claim) => !hasPositivePedometerDuration(claim)) ||
        clusterHasOverlappingWindows(cluster) ||
        new Set(cluster.filter((claim) => claim.kind === "move").map((claim) => claim.mode)).size > 1);
    if (!shouldDeduplicate) {
      selected.push(...cluster);
      cluster = [];
      clusterEnd = Number.NEGATIVE_INFINITY;
      return;
    }
    const winner = [...cluster]
      .sort(
        (lhs, rhs) =>
          arcPedometerClaimRank(lhs) - arcPedometerClaimRank(rhs) ||
          compareStableStrings(canonicalJson(lhs), canonicalJson(rhs)),
      )
      .at(-1)!;
    const floorsUp = cluster.map((claim) => claim.floorsUp).find((value) => value !== null) ?? null;
    const floorsDown = cluster.map((claim) => claim.floorsDown).find((value) => value !== null) ?? null;
    selected.push({ ...winner, floorsUp, floorsDown });
    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const claim of sorted) {
    const previous = cluster.at(-1);
    const start = claim.start ?? claim.end;
    const sameSignature =
      previous !== undefined &&
      cluster.every(
        (candidate) =>
          claim.steps === candidate.steps &&
          compatibleOptionalMetric(claim.floorsUp, candidate.floorsUp) &&
          compatibleOptionalMetric(claim.floorsDown, candidate.floorsDown),
      );
    const adjacentInTimeline =
      previous !== undefined &&
      previous.sequence !== null &&
      claim.sequence !== null &&
      claim.sequence === previous.sequence + 1;
    const overlapsCluster = start <= clusterEnd;
    if (!sameSignature || start > clusterEnd + 90 || (!adjacentInTimeline && !overlapsCluster)) {
      flush();
    }
    cluster.push(claim);
    clusterEnd = Math.max(clusterEnd, claim.end);
  }
  flush();
  return selected;
}

function clusterHasOverlappingWindows(cluster: PedometerClaim[]): boolean {
  let end = Number.NEGATIVE_INFINITY;
  for (const claim of cluster) {
    const start = claim.start ?? claim.end;
    if (start < end) {
      return true;
    }
    end = Math.max(end, claim.end);
  }
  return false;
}

function hasPositivePedometerDuration(claim: PedometerClaim): boolean {
  return claim.start !== null && claim.end > claim.start;
}

function compatibleOptionalMetric(lhs: number | null, rhs: number | null): boolean {
  return lhs === null || rhs === null || lhs === rhs;
}

function arcPedometerClaimRank(claim: PedometerClaim): number {
  const positiveDuration = claim.start !== null && claim.end > claim.start ? 1 : 0;
  return (claim.kind === "move" ? 2 : 0) + positiveDuration;
}

function comparePedometerClaimGroups(lhs: PedometerClaim[], rhs: PedometerClaim[]): number {
  const score = (claims: PedometerClaim[]): readonly number[] => [
    claims.filter((claim) => claim.manual).length,
    claims.reduce((sum, claim) => sum + Math.max(0, claim.end - (claim.start ?? claim.end)), 0),
    claims.filter((claim) => claim.steps !== null).length,
    claims.filter((claim) => claim.distance !== null).length,
  ];
  return compareNumericTuples(score(lhs), score(rhs));
}

function pedometerDayKey(timestamp: number, timezoneOffset: number | null): string {
  return Math.floor((timestamp + (timezoneOffset ?? 0)) / 86_400).toString();
}

function movesDateDayKey(date: string | null): string | null {
  const timestamp = movesDateTimestamp(date, 0);
  return timestamp === null ? null : Math.floor(timestamp / 86_400).toString();
}

function movesDateTimestamp(date: string | null, hour: number): number | null {
  if (!date || !/^\d{8}$/.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  return parseImportTimestamp(`${date}T${hour.toString().padStart(2, "0")}0000Z`);
}

function emitRows<T extends StreamableAuraTable>(state: MutableState, table: T, rows: StreamableAuraRows[T]): void {
  if (rows.length === 0) {
    return;
  }
  if (state.onRows) {
    state.onRows(table, rows);
    state.streamedCounts[table] += rows.length;
  } else if (table === "raw_gps") {
    state.rows.raw_gps.push(...(rows as RawGPSRow[]));
  } else if (table === "samples") {
    state.rows.samples.push(...(rows as SampleRow[]));
  } else if (table === "raw_motion_activity") {
    state.rows.raw_motion_activity.push(...(rows as RawMotionActivityRow[]));
  } else {
    state.rows.raw_pedometer.push(...(rows as RawPedometerRow[]));
  }
}

function assertNonEmptyConversion(state: MutableState): void {
  const rowCount =
    Object.values(state.rows).reduce((sum, rows) => sum + rows.length, 0) +
    Object.values(state.streamedCounts).reduce((sum, count) => sum + count, 0);
  if (rowCount === 0) {
    throw new Error(
      state.diagnostics.length > 0
        ? `No convertible history records remained: ${state.diagnostics[0]}`
        : "No convertible history records remained after validation",
    );
  }
}

function coordinatesFromSamples(samples: JsonObject[]): Array<[number, number]> {
  return prepareRouteFromSamples(samples).points.map((point) => point.coord);
}

function prepareRouteFromSamples(samples: JsonObject[]): PreparedRoute {
  const points: TimedRoutePoint[] = [];
  for (const sample of samples) {
    const point = locationFrom(sample.location) ?? locationFrom(sample);
    if (point) {
      points.push({ coord: [point.lon, point.lat], ts: sampleTimestamp(sample) });
    }
  }
  return prepareTimedRoute(points);
}

function samplesWithinWindow(samples: JsonObject[], start: number, end: number): JsonObject[] {
  return samples
    .map((sample) => ({ sample, ts: sampleTimestamp(sample) }))
    .filter(
      (candidate): candidate is { sample: JsonObject; ts: number } =>
        candidate.ts !== null && candidate.ts >= start && candidate.ts <= end,
    )
    .sort((lhs, rhs) => lhs.ts - rhs.ts)
    .map((candidate) => candidate.sample);
}

function coordinatesFromTrackPoints(
  points: JsonObject[],
  start = Number.NEGATIVE_INFINITY,
  end = Number.POSITIVE_INFINITY,
): Array<[number, number]> {
  return prepareRouteFromTrackPoints(points, start, end).points.map((point) => point.coord);
}

function prepareRouteFromTrackPoints(
  points: JsonObject[],
  start = Number.NEGATIVE_INFINITY,
  end = Number.POSITIVE_INFINITY,
): PreparedRoute {
  const candidates: TimedRoutePoint[] = [];
  for (const point of points) {
    const lat = numberValue(point.lat);
    const lon = numberValue(point.lon);
    const ts = parseImportTimestamp(stringValue(point.time));
    if (lat !== null && lon !== null && validLatLon(lat, lon)) {
      candidates.push({ coord: [lon, lat], ts });
    }
  }
  if (candidates.length > 0 && candidates.every((candidate) => candidate.ts === null)) {
    return { points: candidates, pathQuality: "raw" };
  }
  const withinWindow = candidates
    .filter(
      (candidate): candidate is TimedRoutePoint & { ts: number } =>
        candidate.ts !== null && candidate.ts >= start && candidate.ts <= end,
    )
    .sort((lhs, rhs) => lhs.ts - rhs.ts);
  const prepared = prepareTimedRoute(withinWindow);
  return {
    points: prepared.points,
    pathQuality: prepared.pathQuality === "filtered" || withinWindow.length !== candidates.length ? "filtered" : "raw",
  };
}

function prepareTimedRoute(points: TimedRoutePoint[]): PreparedRoute {
  if (points.length < 2 || points.every((point) => point.ts === null)) {
    return { points, pathQuality: "raw" };
  }
  const candidates = points
    .filter((point): point is TimedRoutePoint & { ts: number } => point.ts !== null)
    .sort((lhs, rhs) => lhs.ts - rhs.ts);
  let removedSpike = false;
  let changed = true;
  while (changed && candidates.length >= 3) {
    changed = false;
    for (let index = 1; index < candidates.length - 1; index += 1) {
      const previous = candidates[index - 1]!;
      const current = candidates[index]!;
      const next = candidates[index + 1]!;
      if (
        !routeEdgeIsPlausible(previous, current) &&
        !routeEdgeIsPlausible(current, next) &&
        routeEdgeIsPlausible(previous, next)
      ) {
        candidates.splice(index, 1);
        removedSpike = true;
        changed = true;
        break;
      }
    }
  }

  const components: Array<Array<TimedRoutePoint & { ts: number }>> = [];
  let component: Array<TimedRoutePoint & { ts: number }> = [];
  for (const point of candidates) {
    if (component.length > 0 && !routeEdgeIsPlausible(component.at(-1)!, point)) {
      components.push(component);
      component = [];
    }
    component.push(point);
  }
  if (component.length > 0) {
    components.push(component);
  }
  const selected =
    components.sort((lhs, rhs) => {
      const pointDifference = rhs.length - lhs.length;
      if (pointDifference !== 0) {
        return pointDifference;
      }
      const lhsDuration = lhs.length > 1 ? lhs.at(-1)!.ts - lhs[0]!.ts : 0;
      const rhsDuration = rhs.length > 1 ? rhs.at(-1)!.ts - rhs[0]!.ts : 0;
      return rhsDuration - lhsDuration || lhs[0]!.ts - rhs[0]!.ts;
    })[0] ?? [];
  return {
    points: selected,
    pathQuality: removedSpike || selected.length !== points.length ? "filtered" : "raw",
  };
}

function routeEdgeIsPlausible(lhs: TimedRoutePoint & { ts: number }, rhs: TimedRoutePoint & { ts: number }): boolean {
  const duration = rhs.ts - lhs.ts;
  const distance = haversineDistance(lhs.coord[1], lhs.coord[0], rhs.coord[1], rhs.coord[0]);
  return duration > 0
    ? distance / duration <= maximumSemanticRouteSpeedMps
    : duration === 0 && distance < routePointDuplicateTimestampDistanceM;
}

function normalizeTimeline(
  state: MutableState,
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  const refs = semanticRefs(state);
  const context = makeNormalizationContext();
  reportProgress(onProgress, "normalize", "Sorting timeline events", refs.length, refs.length, signal);

  const normalized: SemanticRef[] = [];
  reportProgress(onProgress, "normalize", "Resolving timeline overlaps", 0, refs.length, signal);
  for (let index = 0; index < refs.length; index += 1) {
    throwIfAborted(signal);
    const ref = refs[index]!;
    if (!hasPositiveDuration(ref)) {
      removeSemanticRow(context, ref);
      continue;
    }
    normalizeOneRef(state, context, normalized, ref, (suffix) => {
      insertPendingSemanticRef(refs, index + 1, suffix);
    });
    if ((index + 1) % progressReportInterval === 0 || index + 1 === refs.length) {
      reportProgress(onProgress, "normalize", "Resolving timeline overlaps", index + 1, refs.length, signal);
    }
  }

  reportProgress(onProgress, "normalize", "Merging adjacent timeline events", 0, normalized.length, signal);
  mergeAdjacentTimelineEvents(state, context, normalized, onProgress, signal);
  applyNormalizationContext(state, context);

  throwIfAborted(signal);
  const beforeCleanup = state.rows.stays.length + state.rows.moves.length + state.rows.no_data_gaps.length;
  reportProgress(onProgress, "normalize", "Removing invalid timeline fragments", 0, beforeCleanup, signal);
  removeInvalidRows(state);
  reportProgress(onProgress, "normalize", "Removing invalid timeline fragments", beforeCleanup, beforeCleanup, signal);

  separateAdjacentDistinctStays(state);
  const afterCleanup = state.rows.stays.length + state.rows.moves.length + state.rows.no_data_gaps.length;
  reportProgress(onProgress, "normalize", "Inserting timeline gaps", 0, afterCleanup, signal);
  insertGapsBetweenStays(state);
  reportProgress(onProgress, "normalize", "Inserting timeline gaps", afterCleanup, afterCleanup, signal);
}

function makeNormalizationContext(): NormalizationContext {
  return {
    removedStayIds: new Set(),
    removedMoveIds: new Set(),
    removedGapIds: new Set(),
    invalidatedMoveIds: new Set(),
    stayRedirects: new Map(),
  };
}

function normalizeOneRef(
  state: MutableState,
  context: NormalizationContext,
  normalized: SemanticRef[],
  ref: SemanticRef,
  enqueueSuffix: (suffix: SemanticRef) => void,
): void {
  const current: SemanticRef | null = ref;
  while (current) {
    const previous = normalized.at(-1);
    if (!previous) {
      normalized.push(current);
      return;
    }

    if (
      canMergeSemanticRows(previous, current) &&
      (previous.kind === "gap" || touchesOrOverlaps(previous, current) || canMergeAcrossShortStayGap(previous, current))
    ) {
      mergeSemanticRows(state, context, previous, current);
      return;
    }

    const previousEnd = semanticEnd(previous);
    if (current.row.start_ts < previousEnd) {
      const currentEnd = semanticEnd(current);
      const alignsCrossSourceMoveBoundary = isCrossSourceMovePair(previous, current);
      if (compareSemanticPreference(previous, current) >= 0) {
        if (currentEnd <= previousEnd) {
          preserveExactMoveGeometry(state, previous, current);
          removeSemanticRow(context, current);
          recordDiagnostic(state, "Discarded lower-quality overlapping timeline event");
          return;
        }
        if (alignsCrossSourceMoveBoundary && currentEnd - previousEnd <= 1) {
          previous.row.end_ts = currentEnd;
          preserveExactMoveGeometry(state, previous, current);
          removeSemanticRow(context, current);
          recordDiagnostic(state, "Absorbed one-second cross-source move boundary residual");
          return;
        }
        current.row.start_ts = previousEnd;
        invalidateMoveGeometry(context, current);
        recordDiagnostic(state, "Shifted lower-quality overlapping timeline event");
        continue;
      }

      const prefixResidual = current.row.start_ts - previous.row.start_ts;
      const suffixResidual = previousEnd - currentEnd;
      if (alignsCrossSourceMoveBoundary && prefixResidual <= 1) {
        if (suffixResidual > 1 && Number.isFinite(currentEnd)) {
          const suffix = cloneSemanticSuffix(state, context, previous, currentEnd);
          if (suffix) {
            enqueueSuffix(suffix);
          }
        } else if (suffixResidual > 0) {
          current.row.end_ts = previousEnd;
        }
        current.row.start_ts = previous.row.start_ts;
        normalized.pop();
        preserveExactMoveGeometry(state, current, previous);
        removeSemanticRow(context, previous);
        recordDiagnostic(state, "Absorbed one-second cross-source move boundary residual");
        continue;
      }

      if (alignsCrossSourceMoveBoundary && suffixResidual > 0 && suffixResidual <= 1) {
        current.row.end_ts = previousEnd;
      }

      if (current.row.start_ts <= previous.row.start_ts) {
        normalized.pop();
        preserveExactMoveGeometry(state, current, previous);
        removeSemanticRow(context, previous);
        recordDiagnostic(state, "Replaced lower-quality overlapping timeline event");
        continue;
      }

      if (semanticEnd(previous) > semanticEnd(current) && Number.isFinite(semanticEnd(current))) {
        const suffix = cloneSemanticSuffix(state, context, previous, semanticEnd(current));
        if (suffix) {
          enqueueSuffix(suffix);
        }
      }

      if (current.row.start_ts > previous.row.start_ts) {
        previous.row.end_ts = current.row.start_ts;
        invalidateMoveGeometry(context, previous);
        recordDiagnostic(state, "Clipped overlapping timeline event");
        if (!hasPositiveDuration(previous)) {
          normalized.pop();
          removeSemanticRow(context, previous);
          continue;
        }
        normalized.push(current);
        return;
      }

      normalized.pop();
      removeSemanticRow(context, previous);
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

function isCrossSourceMovePair(lhs: SemanticRef, rhs: SemanticRef): boolean {
  return (
    lhs.kind === "move" &&
    rhs.kind === "move" &&
    lhs.source !== rhs.source &&
    (lhs.source === "arc" || lhs.source === "moves") &&
    (rhs.source === "arc" || rhs.source === "moves")
  );
}

function preserveExactMoveGeometry(state: MutableState, target: SemanticRef, source: SemanticRef): void {
  if (
    target.kind !== "move" ||
    source.kind !== "move" ||
    target.row.start_ts !== source.row.start_ts ||
    target.row.end_ts !== source.row.end_ts
  ) {
    return;
  }
  const targetMove = target.row as MoveRow;
  const sourceMove = source.row as MoveRow;
  targetMove.distance_m ??= sourceMove.distance_m;
  targetMove.tz_offset_s ??= sourceMove.tz_offset_s;
  const targetHasRoute = state.rows.route_paths.some((route) => route.move_id === targetMove.id);
  if (!targetHasRoute) {
    for (const route of state.rows.route_paths.filter((candidate) => candidate.move_id === sourceMove.id)) {
      route.move_id = targetMove.id;
    }
    const sourceEvidence = state.routeEvidence.get(sourceMove.id);
    if (sourceEvidence) {
      state.routeEvidence.set(targetMove.id, sourceEvidence);
    }
  }
  target.quality = moveSemanticQuality(
    targetMove,
    targetHasRoute || state.rows.route_paths.some((route) => route.move_id === targetMove.id),
  );
}

function mergeAdjacentTimelineEvents(
  state: MutableState,
  context: NormalizationContext,
  refs: SemanticRef[],
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): void {
  const merged: SemanticRef[] = [];
  for (const [index, ref] of refs.entries()) {
    throwIfAborted(signal);
    if (isRemoved(context, ref) || !hasPositiveDuration(ref)) {
      removeSemanticRow(context, ref);
      continue;
    }
    const previous = merged.at(-1);
    if (
      previous &&
      canMergeSemanticRows(previous, ref) &&
      (ref.row.start_ts === semanticEnd(previous) || canMergeAcrossShortStayGap(previous, ref))
    ) {
      mergeSemanticRows(state, context, previous, ref);
    } else {
      merged.push(ref);
    }
    if ((index + 1) % progressReportInterval === 0 || index + 1 === refs.length) {
      reportProgress(onProgress, "normalize", "Merging adjacent timeline events", index + 1, refs.length, signal);
    }
  }
  if (refs.length === 0) {
    reportProgress(onProgress, "normalize", "Merging adjacent timeline events", 0, 0, signal);
  }
}

function semanticRefs(state: MutableState): SemanticRef[] {
  const refs: SemanticRef[] = [];
  const linkedStayIds = new Set(state.rows.stay_pois.map((link) => link.stay_id));
  const routedMoveIds = new Set(state.rows.route_paths.map((route) => route.move_id));
  for (const row of state.rows.stays) {
    refs.push(makeSemanticRef(state, "stay", row, staySemanticQuality(row, linkedStayIds.has(row.id))));
  }
  for (const row of state.rows.moves) {
    refs.push(makeSemanticRef(state, "move", row, moveSemanticQuality(row, routedMoveIds.has(row.id))));
  }
  for (const row of state.rows.no_data_gaps) {
    refs.push(makeSemanticRef(state, "gap", row, gapSemanticQuality(row)));
  }
  return refs.sort(compareSemanticRefs);
}

function makeSemanticRef(
  state: MutableState,
  kind: SemanticRef["kind"],
  row: StayRow | MoveRow | NoDataGapRow,
  quality: number,
): SemanticRef {
  const evidence = state.semanticEvidence.get(`${kind}:${row.id}`) ?? {
    manual: false,
    revision: 0,
    source: "unknown" as const,
  };
  return { kind, row, quality, ...evidence };
}

function compareSemanticRefs(lhs: SemanticRef, rhs: SemanticRef): number {
  if (lhs.row.start_ts !== rhs.row.start_ts) {
    return lhs.row.start_ts - rhs.row.start_ts;
  }
  if (lhs.manual !== rhs.manual) {
    return lhs.manual ? -1 : 1;
  }
  const qualityDifference = rhs.quality - lhs.quality;
  if (qualityDifference !== 0) {
    return qualityDifference;
  }
  const lhsDuration = semanticDuration(lhs);
  const rhsDuration = semanticDuration(rhs);
  if (lhsDuration !== rhsDuration) {
    return lhsDuration < rhsDuration ? -1 : 1;
  }
  const kindOrder = { stay: 0, move: 1, gap: 2 };
  return kindOrder[lhs.kind] - kindOrder[rhs.kind] || lhs.row.id - rhs.row.id;
}

function insertPendingSemanticRef(refs: SemanticRef[], startIndex: number, ref: SemanticRef): void {
  let lower = startIndex;
  let upper = refs.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (compareSemanticRefs(refs[middle]!, ref) <= 0) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  refs.splice(lower, 0, ref);
}

function compareSemanticPreference(lhs: SemanticRef, rhs: SemanticRef): number {
  const movesPreference = compareHistoricalMovesPreference(lhs, rhs);
  if (movesPreference !== 0) {
    return movesPreference;
  }
  if (lhs.manual !== rhs.manual) {
    return lhs.manual ? 1 : -1;
  }
  const qualityDifference = lhs.quality - rhs.quality;
  if (qualityDifference !== 0) {
    return qualityDifference;
  }
  const lhsDuration = semanticDuration(lhs);
  const rhsDuration = semanticDuration(rhs);
  if (lhsDuration !== rhsDuration) {
    return lhsDuration < rhsDuration ? 1 : -1;
  }
  if (lhs.source === rhs.source && lhs.revision !== rhs.revision) {
    return lhs.revision - rhs.revision;
  }
  const kindOrder = { stay: 2, move: 1, gap: 0 };
  return kindOrder[lhs.kind] - kindOrder[rhs.kind] || rhs.row.id - lhs.row.id;
}

function compareHistoricalMovesPreference(lhs: SemanticRef, rhs: SemanticRef): number {
  if (
    lhs.source === rhs.source ||
    (lhs.source !== "moves" && rhs.source !== "moves") ||
    (lhs.source !== "arc" && rhs.source !== "arc")
  ) {
    return 0;
  }
  const moves = lhs.source === "moves" ? lhs : rhs;
  if (moves.row.start_ts >= movesLastServiceDayEndTs) {
    return 0;
  }
  return lhs.source === "moves" ? 1 : -1;
}

function semanticDuration(ref: SemanticRef): number {
  return semanticEnd(ref) - ref.row.start_ts;
}

function staySemanticQuality(stay: StayRow, hasPoiLink: boolean): number {
  return 1 + (stay.poi_id === null ? 0 : 5) + (hasPoiLink ? 1 : 0) + (stay.type === "anchor" ? 3 : 0);
}

function moveSemanticQuality(move: MoveRow, hasRoute: boolean): number {
  return 1 + (hasRoute ? 6 : 0) + (move.distance_m === null ? 0 : 2) + (move.mode === "other" ? 0 : 2);
}

function gapSemanticQuality(gap: NoDataGapRow): number {
  return gap.notes === timelineNote.movesTrackingOff ? 2 : 0;
}

function cloneSemanticSuffix(
  state: MutableState,
  context: NormalizationContext,
  ref: SemanticRef,
  start: number,
): SemanticRef | null {
  if (start >= semanticEnd(ref)) {
    return null;
  }
  if (ref.kind === "stay") {
    const row = ref.row as StayRow;
    const suffix: StayRow = { ...row, id: state.next.stays++, start_ts: start };
    state.rows.stays.push(suffix);
    for (const link of state.rows.stay_pois.filter((candidate) => candidate.stay_id === row.id)) {
      state.rows.stay_pois.push({ ...link, stay_id: suffix.id });
    }
    recordSemanticEvidence(state, "stay", suffix.id, ref);
    return { ...ref, kind: "stay", row: suffix };
  }
  if (ref.kind === "move") {
    const row = ref.row as MoveRow;
    const suffix: MoveRow = { ...row, id: state.next.moves++, start_ts: start, distance_m: null };
    state.rows.moves.push(suffix);
    const routeEvidence = state.routeEvidence.get(row.id);
    if (routeEvidence) {
      state.routeEvidence.set(suffix.id, routeEvidence);
    }
    context.invalidatedMoveIds.add(row.id);
    context.invalidatedMoveIds.add(suffix.id);
    row.distance_m = null;
    ref.quality = moveSemanticQuality(row, false);
    recordSemanticEvidence(state, "move", suffix.id, ref);
    return { ...ref, kind: "move", row: suffix, quality: moveSemanticQuality(suffix, false) };
  }
  const row = ref.row as NoDataGapRow;
  const suffix: NoDataGapRow = { ...row, id: state.next.no_data_gaps++, start_ts: start };
  state.rows.no_data_gaps.push(suffix);
  recordSemanticEvidence(state, "gap", suffix.id, ref);
  return { ...ref, kind: "gap", row: suffix };
}

function invalidateMoveGeometry(context: NormalizationContext, ref: SemanticRef): void {
  if (ref.kind === "move") {
    context.invalidatedMoveIds.add(ref.row.id);
    (ref.row as MoveRow).distance_m = null;
    ref.quality = moveSemanticQuality(ref.row as MoveRow, false);
  }
}

function mergeSemanticRows(
  state: MutableState,
  context: NormalizationContext,
  target: SemanticRef,
  source: SemanticRef,
): void {
  target.row.end_ts =
    target.row.end_ts === null || source.row.end_ts === null ? null : Math.max(target.row.end_ts, source.row.end_ts);
  if (target.kind === "stay" && source.kind === "stay") {
    const targetStay = target.row as StayRow;
    const sourceStay = source.row as StayRow;
    if (source.quality > target.quality) {
      targetStay.centroid_lat = sourceStay.centroid_lat;
      targetStay.centroid_lon = sourceStay.centroid_lon;
      targetStay.radius_m = sourceStay.radius_m;
      targetStay.type = sourceStay.type;
      targetStay.poi_id = sourceStay.poi_id;
      targetStay.tz_offset_s = sourceStay.tz_offset_s;
      target.quality = source.quality;
    }
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
  if (lhs.kind === "gap") {
    return true;
  }
  return lhs.kind === "stay" && staysSpatiallyCompatible(lhs.row as StayRow, rhs.row as StayRow);
}

function canMergeAcrossShortStayGap(lhs: SemanticRef, rhs: SemanticRef): boolean {
  if (lhs.kind !== "stay" || rhs.kind !== "stay" || lhs.row.end_ts === null) {
    return false;
  }
  const gap = rhs.row.start_ts - lhs.row.end_ts;
  return gap > 0 && gap < stayUncertaintyGapS && staysSpatiallyCompatible(lhs.row as StayRow, rhs.row as StayRow);
}

function staysSpatiallyCompatible(lhs: StayRow, rhs: StayRow): boolean {
  const distance = haversineDistance(lhs.centroid_lat, lhs.centroid_lon, rhs.centroid_lat, rhs.centroid_lon);
  return distance <= Math.max(stayMatchingBufferM, lhs.radius_m + rhs.radius_m);
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
  state.rows.stays = state.rows.stays.filter(
    (row) => !context.removedStayIds.has(row.id) && (row.end_ts === null || row.end_ts > row.start_ts),
  );
  state.rows.moves = state.rows.moves.filter(
    (row) => !context.removedMoveIds.has(row.id) && (row.end_ts === null || row.end_ts > row.start_ts),
  );
  state.rows.no_data_gaps = state.rows.no_data_gaps.filter(
    (row) => !context.removedGapIds.has(row.id) && (row.end_ts === null || row.end_ts > row.start_ts),
  );

  const validStayIds = new Set(state.rows.stays.map((row) => row.id));
  const validMoveIds = new Set(state.rows.moves.map((row) => row.id));

  const staysById = new Map(state.rows.stays.map((stay) => [stay.id, stay]));
  const stayPoisByIdentity = new Map<string, StayPoiRow>();
  for (const row of state.rows.stay_pois) {
    const stayId = redirectedId(context.stayRedirects, row.stay_id);
    if (!validStayIds.has(stayId)) {
      continue;
    }
    row.stay_id = stayId;
    const stay = staysById.get(stayId)!;
    const role: StayPoiRow["role"] =
      stay.poi_id === row.poi_id ? "primary" : row.role === "primary" ? "secondary" : row.role;
    const candidate = { ...row, role };
    const key = `${stayId}:${row.poi_id}`;
    const existing = stayPoisByIdentity.get(key);
    if (!existing || stayPoiRoleRank(candidate.role) > stayPoiRoleRank(existing.role)) {
      stayPoisByIdentity.set(key, candidate);
    } else if (
      candidate.distance_m !== null &&
      (existing.distance_m === null || candidate.distance_m < existing.distance_m)
    ) {
      existing.distance_m = candidate.distance_m;
    }
  }
  state.rows.stay_pois = [...stayPoisByIdentity.values()];

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
  state.rows.route_paths = routePaths.filter((row) => !context.invalidatedMoveIds.has(row.move_id));
  for (const moveId of context.invalidatedMoveIds) {
    const move = state.rows.moves.find((candidate) => candidate.id === moveId);
    const evidence = state.routeEvidence.get(moveId);
    if (!move || move.end_ts === null || !evidence) {
      continue;
    }
    const points = evidence.points.filter(
      (point): point is TimedRoutePoint & { ts: number } =>
        point.ts !== null && point.ts >= move.start_ts && point.ts <= move.end_ts!,
    );
    if (points.length < 2) {
      continue;
    }
    const coords = points.map((point) => point.coord);
    move.distance_m = calculatePathDistance(coords);
    insertRoutePath(
      state,
      move.id,
      coords,
      evidence.provider,
      points.map((point) => point.ts),
      evidence.pathQuality,
    );
  }
}

function stayPoiRoleRank(role: StayPoiRow["role"]): number {
  if (role === "primary") {
    return 3;
  }
  if (role === "secondary") {
    return 2;
  }
  return role === "inferred" ? 1 : 0;
}

function redirectedId(redirects: Map<number, number>, id: number): number {
  let current = id;
  while (redirects.has(current)) {
    current = redirects.get(current)!;
  }
  return current;
}

function removeInvalidRows(state: MutableState): void {
  const validStayIds = new Set(
    state.rows.stays.filter((row) => row.end_ts === null || row.end_ts > row.start_ts).map((row) => row.id),
  );
  const validMoveIds = new Set(
    state.rows.moves.filter((row) => row.end_ts === null || row.end_ts > row.start_ts).map((row) => row.id),
  );
  const validGapIds = new Set(
    state.rows.no_data_gaps.filter((row) => row.end_ts === null || row.end_ts > row.start_ts).map((row) => row.id),
  );
  const removed =
    state.rows.stays.length -
    validStayIds.size +
    state.rows.moves.length -
    validMoveIds.size +
    state.rows.no_data_gaps.length -
    validGapIds.size;
  state.rows.stays = state.rows.stays.filter((row) => validStayIds.has(row.id));
  state.rows.moves = state.rows.moves.filter((row) => validMoveIds.has(row.id));
  state.rows.no_data_gaps = state.rows.no_data_gaps.filter((row) => validGapIds.has(row.id));
  state.rows.stay_pois = state.rows.stay_pois.filter((row) => validStayIds.has(row.stay_id));
  state.rows.route_paths = state.rows.route_paths.filter((row) => validMoveIds.has(row.move_id));
  if (removed > 0) {
    recordDiagnostic(state, `Removed ${removed} non-positive duration events`);
  }
}

function separateAdjacentDistinctStays(state: MutableState): void {
  const refs = semanticRefs(state);
  for (let index = 1; index < refs.length; index += 1) {
    const previousRef = refs[index - 1]!;
    const currentRef = refs[index]!;
    if (previousRef.kind !== "stay" || currentRef.kind !== "stay") {
      continue;
    }
    const previous = previousRef.row as StayRow;
    const current = currentRef.row as StayRow;
    if (previous.end_ts === null || staysSpatiallyCompatible(previous, current)) {
      continue;
    }
    const gap = current.start_ts - previous.end_ts;
    if (gap < 0 || gap >= stayUncertaintyGapS) {
      continue;
    }
    let needed = stayUncertaintyGapS - gap;
    const previousDuration = previous.end_ts - previous.start_ts;
    const currentDuration = (current.end_ts ?? current.start_ts) - current.start_ts;
    let previousCapacity = Math.max(0, previousDuration - Math.min(stayUncertaintyGapS, previousDuration));
    let currentCapacity = Math.max(0, currentDuration - Math.min(stayUncertaintyGapS, currentDuration));
    if (previousCapacity + currentCapacity < needed) {
      if (gap > 0) {
        continue;
      }
      previousCapacity = Math.max(0, previousDuration - 0.001);
      currentCapacity = Math.max(0, currentDuration - 0.001);
      needed = Math.min(1, previousCapacity + currentCapacity);
      if (needed <= 0) {
        continue;
      }
    }
    const trimPrevious = Math.min(previousCapacity, needed / 2);
    const trimCurrent = needed - trimPrevious;
    if (trimCurrent > currentCapacity) {
      previous.end_ts -= needed - currentCapacity;
      current.start_ts += currentCapacity;
    } else {
      previous.end_ts -= trimPrevious;
      current.start_ts += trimCurrent;
    }
    recordDiagnostic(state, "Reserved an uncertainty gap between distinct adjacent stays");
  }
}

function insertGapsBetweenStays(state: MutableState): void {
  const refs = semanticRefs(state);
  for (let index = 1; index < refs.length; index += 1) {
    const previous = refs[index - 1]!;
    const current = refs[index]!;
    if (
      previous.kind !== "stay" ||
      current.kind !== "stay" ||
      previous.row.end_ts === null ||
      current.row.start_ts < previous.row.end_ts
    ) {
      continue;
    }
    if (current.row.start_ts === previous.row.end_ts) {
      const previousDuration = previous.row.end_ts - previous.row.start_ts;
      const currentDuration = (current.row.end_ts ?? current.row.start_ts) - current.row.start_ts;
      const previousCapacity = Math.max(0, previousDuration - 0.001);
      const currentCapacity = Math.max(0, currentDuration - 0.001);
      const needed = Math.min(1, previousCapacity + currentCapacity);
      if (needed <= 0) {
        continue;
      }
      const trimPrevious = Math.min(previousCapacity, needed / 2);
      const trimCurrent = needed - trimPrevious;
      previous.row.end_ts -= trimPrevious;
      current.row.start_ts += trimCurrent;
      recordDiagnostic(state, "Reserved a minimal gap between distinct adjacent stays");
    }
    const row: NoDataGapRow = {
      id: state.next.no_data_gaps++,
      start_ts: previous.row.end_ts,
      end_ts: current.row.start_ts,
      reason: "Unknown",
      uncertainty: null,
      notes: timelineNote.generatedBetweenStays,
    };
    state.rows.no_data_gaps.push(row);
  }
}

function makeReport(
  state: MutableState,
  fileCount: number,
  sourceTypes: SourceType[],
  timelineIntegrity: TimelineIntegritySummary,
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): ImportReport {
  const counts = Object.fromEntries(
    Object.entries(state.rows).map(([key, rows]) => [
      key,
      rows.length + (key in state.streamedCounts ? state.streamedCounts[key as StreamableAuraTable] : 0),
    ]),
  ) as Record<keyof AuraRows, number>;
  const semanticCount = state.rows.stays.length + state.rows.moves.length + state.rows.no_data_gaps.length;
  reportProgress(onProgress, "report", "Summarizing timeline report", 0, semanticCount, signal);
  const dateRange = summarizeDateRange(state, onProgress, semanticCount, signal);
  reportProgress(onProgress, "report", "Import report ready", semanticCount, semanticCount, signal);

  return {
    sourceTypes,
    userVersion: getLatestSchemaVersion(),
    fileCount,
    dateRange,
    counts,
    diagnostics: reportDiagnostics(state),
    timelineIntegrity,
  };
}

function summarizeDateRange(
  state: MutableState,
  onProgress?: (progress: ImportProgress) => void,
  total = 0,
  signal?: AbortSignal,
): ImportReport["dateRange"] {
  throwIfAborted(signal);
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
    if (completed % progressReportInterval === 0 || completed === total) {
      reportProgress(onProgress, "report", "Summarizing timeline report", completed, total, signal);
    }
  }
  for (const row of state.rows.moves) {
    include(row.start_ts);
    include(row.end_ts);
    completed += 1;
    if (completed % progressReportInterval === 0 || completed === total) {
      reportProgress(onProgress, "report", "Summarizing timeline report", completed, total, signal);
    }
  }
  for (const row of state.rows.no_data_gaps) {
    include(row.start_ts);
    include(row.end_ts);
    completed += 1;
    if (completed % progressReportInterval === 0 || completed === total) {
      reportProgress(onProgress, "report", "Summarizing timeline report", completed, total, signal);
    }
  }

  return Number.isFinite(startTs) && Number.isFinite(endTs) ? { startTs, endTs } : null;
}

function reportProgress(
  onProgress: ((progress: ImportProgress) => void) | undefined,
  phase: ImportProgress["phase"],
  message: string,
  completed: number,
  total: number,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  onProgress?.({
    phase,
    message,
    completed,
    total: Math.max(total, completed, 1),
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
  return [...state.diagnosticCounts]
    .map(([message, count]) => (count > 1 ? `${message} (${count.toLocaleString()} times)` : message))
    .slice(0, diagnosticSampleLimit);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was cancelled", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

function courseAccuracyValue(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && number >= 0 && number < 360 ? number : null;
}

function timezoneOffsetValue(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) && number >= -50_400 && number <= 50_400 ? number : null;
}

function compareStableStrings(lhs: string, rhs: string): number {
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
