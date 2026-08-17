import type { SourceType } from "./types.js";

export type ArcBackupFileKind = "place" | "timeline-item" | "samples" | "range-summary";

const movesStorylinePatterns = [
  /\/json\/daily\/storyline\//i,
  /\/json\/full\/storyline\.json(?:\.gz)?$/i,
  /\/json\/monthly\/storyline\//i,
  /\/json\/weekly\/storyline\//i,
  /\/json\/yearly\/storyline\//i,
];

export function classifySourcePath(path: string): SourceType | null {
  if (movesStorylinePatterns.some((pattern) => pattern.test(normalizedPath(path)))) {
    return "moves-export";
  }
  const normalized = normalizedPath(path).toLowerCase();
  if (
    normalized.includes("/export/json/daily/") ||
    normalized.includes("/export/json/monthly/") ||
    normalized.startsWith("/json/daily/") ||
    normalized.startsWith("/json/monthly/")
  ) {
    return "arc-export";
  }
  return arcBackupFileKind(path) ? "arc-backup" : null;
}

export function arcBackupFileKind(path: string): ArcBackupFileKind | null {
  const normalized = normalizedPath(path).toLowerCase();
  if (normalized.includes("/timelineitem/")) {
    return "timeline-item";
  }
  if (normalized.includes("/locomotionsample/")) {
    return "samples";
  }
  if (normalized.includes("/place/")) {
    return "place";
  }
  if (normalized.includes("/timelinerangesummary/")) {
    return "range-summary";
  }
  return null;
}

function normalizedPath(path: string): string {
  return `/${path.replaceAll("\\", "/")}`;
}
