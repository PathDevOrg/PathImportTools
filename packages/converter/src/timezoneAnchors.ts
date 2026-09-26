import { maximumTimezoneBracketS, maximumTimezoneNearestS, timezoneAnchorSpacingS } from "./constants.js";

type TimezoneAnchor = {
  ts: number;
  offset: number;
};

export class TimezoneAnchorCollector {
  private readonly anchors: TimezoneAnchor[] = [];
  private last: TimezoneAnchor | null = null;
  private lastKept: TimezoneAnchor | null = null;

  addOrdered(ts: number, offset: number): void {
    const current = { ts, offset };
    const last = this.last;
    const lastKept = this.lastKept;
    if (!last || !lastKept) {
      this.keep(current);
    } else if (offset !== last.offset || ts - last.ts > timezoneAnchorSpacingS) {
      if (last !== lastKept) {
        this.keep(last);
      }
      this.keep(current);
    } else if (ts - lastKept.ts >= timezoneAnchorSpacingS) {
      this.keep(current);
    }
    this.last = current;
  }

  addUnordered(ts: number, offset: number): void {
    this.anchors.push({ ts, offset });
  }

  build(): TimezoneAnchors {
    if (this.last && this.last !== this.lastKept) {
      this.keep(this.last);
    }
    const sorted = [...this.anchors].sort((lhs, rhs) => lhs.ts - rhs.ts || lhs.offset - rhs.offset);
    return new TimezoneAnchors(
      Float64Array.from(sorted, (anchor) => anchor.ts),
      Int32Array.from(sorted, (anchor) => anchor.offset),
    );
  }

  private keep(anchor: TimezoneAnchor): void {
    this.anchors.push(anchor);
    this.lastKept = anchor;
  }
}

export class TimezoneAnchors {
  constructor(
    private readonly timestamps: Float64Array,
    private readonly offsets: Int32Array,
  ) {}

  offsetAt(ts: number): number | null {
    let lower = 0;
    let upper = this.timestamps.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (this.timestamps[middle]! <= ts) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    const previous = lower - 1;
    const next = lower < this.timestamps.length ? lower : -1;
    if (previous >= 0 && this.timestamps[previous] === ts) {
      return this.offsets[previous]!;
    }
    if (
      previous >= 0 &&
      next >= 0 &&
      this.offsets[previous] === this.offsets[next] &&
      this.timestamps[next]! - this.timestamps[previous]! <= maximumTimezoneBracketS
    ) {
      return this.offsets[previous]!;
    }
    const previousDistance = previous >= 0 ? ts - this.timestamps[previous]! : Number.POSITIVE_INFINITY;
    const nextDistance = next >= 0 ? this.timestamps[next]! - ts : Number.POSITIVE_INFINITY;
    const nearest = previousDistance <= nextDistance ? previous : next;
    return nearest >= 0 && Math.min(previousDistance, nextDistance) <= maximumTimezoneNearestS
      ? this.offsets[nearest]!
      : null;
  }
}
