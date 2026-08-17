import type { SourceType } from "./types.js";

export const diagnosticSampleLimit = 20;
export const movesLastServiceDayEndTs = Date.UTC(2018, 7, 2) / 1_000;
export const maximumSemanticRouteSpeedMps = 400;
export const minimumGeometryOnlyMoveSpeedMps = 0.5;
export const minimumPedometerMetersPerStep = 0.3;
export const maximumPedometerMetersPerStep = 2.5;
export const maximumReconstructedStayRadiusM = 200;
export const minimumReconstructedStayRadiusM = 10;
export const minimumReconstructedMoveDistanceM = 100;
export const maximumObservationGapS = 600;
export const maximumObservationExtensionS = 300;
export const maximumUnlinkedObservationWindowS = 21_600;
export const fragmentGroupSize = 20;
export const fragmentMedianDurationThresholdS = 30;
export const trustedFragmentDurationS = 60;
export const fragmentGapThresholdS = 600;
export const fragmentInvalidDurationRatio = 0.4;
export const stayMatchingBufferM = 50;
export const stayUncertaintyGapS = 60;
export const defaultStayRadiusM = 50;
export const routePointDuplicateTimestampDistanceM = 0.01;
export const duplicateTimestampToleranceS = 0.000001;
export const streamingRowBatchSize = 1_000;
export const rootObjectStreamingFallbackChars = 1_000_000;
export const rootObjectStreamingFallbackTokens = 20_000;
export const defaultBqdcQuantizationCm = 100;
export const progressReportInterval = 500;

export const sourceOrder: SourceType[] = ["arc-export", "arc-backup", "moves-export"];

export const provider = {
  arcImport: "arc_import",
  arcBackup: "arc_backup",
  arcReconstruction: "arc_reconstruction",
  movesExport: "moves_export",
} as const;

export const timelineNote = {
  arcLowConfidence: "arc_low_confidence",
  arcFragmentUnobserved: "arc_fragment_unobserved",
  arcFragmentLowEvidence: "arc_fragment_low_evidence",
  movesPlaceWithoutLocation: "moves_place_without_location",
  movesTrackingOff: "moves_tracking_off",
  generatedBetweenStays: "generated_between_stays",
} as const;

export const evidenceKey = {
  auraRevision: "__auraRevision",
  fragmentRepair: "__fragmentRepair",
  fragmentEvidence: "__fragmentEvidence",
} as const;
