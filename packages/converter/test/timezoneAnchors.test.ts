import { describe, expect, test } from "vitest";
import { TimezoneAnchorCollector } from "../src/timezoneAnchors.js";

const hour = 3_600;

describe("TimezoneAnchors", () => {
  test("uses the run offset anywhere inside a densely observed run", () => {
    const collector = new TimezoneAnchorCollector();
    for (let index = 0; index <= 72; index += 1) {
      collector.addOrdered(index * hour, 28_800);
    }

    expect(collector.build().offsetAt(36.5 * hour)).toBe(28_800);
  });

  test("leaves a timestamp unresolved inside a long hole even when both sides agree", () => {
    const collector = new TimezoneAnchorCollector();
    collector.addOrdered(0, 3_600);
    collector.addOrdered(100 * 24 * hour, 3_600);

    expect(collector.build().offsetAt(50 * 24 * hour)).toBeNull();
  });

  test("uses the nearer anchor within six hours when neighbouring offsets disagree", () => {
    const collector = new TimezoneAnchorCollector();
    collector.addOrdered(0, 28_800);
    collector.addOrdered(20 * hour, 36_000);
    const anchors = collector.build();

    expect(anchors.offsetAt(2 * hour)).toBe(28_800);
    expect(anchors.offsetAt(17 * hour)).toBe(36_000);
    expect(anchors.offsetAt(10 * hour)).toBeNull();
  });
});
