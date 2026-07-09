import { describe, expect, test } from "vitest";
import { calculateBounds, encodeBQDCPath } from "../src/index.js";

describe("encodeBQDCPath", () => {
  test("writes the Aura bqdc-v1 header and point count", () => {
    const blob = encodeBQDCPath([
      [151.2093, -33.8688],
      [151.21, -33.869],
      [151.211, -33.8695]
    ]);

    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    expect(view.getUint32(0, true)).toBe(0x42514443);
    expect(view.getUint8(4)).toBe(1);
    expect(view.getUint8(5)).toBe(0);
    expect(view.getUint16(6, true)).toBe(100);
    expect(view.getUint32(8, true)).toBe(3);
  });

  test("rejects empty route paths", () => {
    expect(() => encodeBQDCPath([])).toThrow("Cannot encode empty coordinate list");
  });
});

describe("calculateBounds", () => {
  test("calculates coordinate bounds in Aura column order", () => {
    expect(calculateBounds([
      [151.2, -33.8],
      [151.4, -33.9],
      [151.1, -33.7]
    ])).toEqual({
      minLat: -33.9,
      minLon: 151.1,
      maxLat: -33.7,
      maxLon: 151.4
    });
  });
});
