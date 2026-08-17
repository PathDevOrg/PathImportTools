import type { AuraRows, TimelineIntegritySummary } from "./types.js";

type TimelineEvent = {
  kind: "stay" | "move" | "gap";
  start: number;
  end: number | null;
};

export function verifyTimelineIntegrity(rows: AuraRows): TimelineIntegritySummary {
  const events: TimelineEvent[] = [
    ...rows.stays.map((row) => ({ kind: "stay" as const, start: row.start_ts, end: row.end_ts })),
    ...rows.moves.map((row) => ({ kind: "move" as const, start: row.start_ts, end: row.end_ts })),
    ...rows.no_data_gaps.map((row) => ({ kind: "gap" as const, start: row.start_ts, end: row.end_ts })),
  ].sort((lhs, rhs) => lhs.start - rhs.start);

  let duplicateStartCount = 0;
  let overlapCount = 0;
  let adjacentSameKindCount = 0;
  let openEventCount = 0;
  let openEventNotLastCount = 0;
  let nonPositiveDurationCount = 0;
  let previousMaximumEnd = Number.NEGATIVE_INFINITY;

  for (const [index, event] of events.entries()) {
    if (
      index > 0 &&
      event.start === events[index - 1]!.start &&
      (index === 1 || event.start !== events[index - 2]!.start)
    ) {
      duplicateStartCount += 1;
    }
    if (event.start < previousMaximumEnd) {
      overlapCount += 1;
    }
    if (index > 0 && event.kind !== "move" && event.kind === events[index - 1]!.kind) {
      adjacentSameKindCount += 1;
    }
    if (event.end === null) {
      openEventCount += 1;
      if (index !== events.length - 1) {
        openEventNotLastCount += 1;
      }
      previousMaximumEnd = Number.POSITIVE_INFINITY;
    } else {
      if (event.end <= event.start) {
        nonPositiveDurationCount += 1;
      }
      previousMaximumEnd = Math.max(previousMaximumEnd, event.end);
    }
  }

  const summary: TimelineIntegritySummary = {
    eventCount: events.length,
    duplicateStartCount,
    overlapCount,
    adjacentSameKindCount,
    openEventCount,
    openEventNotLastCount,
    nonPositiveDurationCount,
  };
  if (
    duplicateStartCount > 0 ||
    overlapCount > 0 ||
    adjacentSameKindCount > 0 ||
    openEventCount > 1 ||
    openEventNotLastCount > 0 ||
    nonPositiveDurationCount > 0
  ) {
    throw new Error(`Converted timeline violates App invariants: ${JSON.stringify(summary)}`);
  }
  return summary;
}
