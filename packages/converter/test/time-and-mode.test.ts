import { describe, expect, test } from "vitest";
import { mapActivityType, parseImportTimestamp } from "../src/index.js";

describe("parseImportTimestamp", () => {
  test("parses Arc ISO strings with Z suffix", () => {
    expect(parseImportTimestamp("2024-05-01T10:20:30Z")).toBe(1714558830);
    expect(parseImportTimestamp("2024-05-01T10:20:30.987+10:00")).toBe(1714522830);
  });

  test("parses Moves compact timestamps with numeric timezone", () => {
    expect(parseImportTimestamp("20140401T080000+0300")).toBe(1396328400);
  });

  test("parses Moves compact UTC timestamps", () => {
    expect(parseImportTimestamp("20140402T024827Z")).toBe(1396406907);
  });

  test("returns null for missing or invalid timestamps", () => {
    expect(parseImportTimestamp(null)).toBeNull();
    expect(parseImportTimestamp("bad-date")).toBeNull();
    expect(parseImportTimestamp("20240101T080000+9900")).toBeNull();
    expect(parseImportTimestamp("20240230T080000Z")).toBeNull();
    expect(parseImportTimestamp("20240230T080000+0000")).toBeNull();
    expect(parseImportTimestamp("20240230T080000")).toBeNull();
    expect(parseImportTimestamp("2024-02-30T12:00:00Z")).toBeNull();
    expect(parseImportTimestamp("2023-02-29T00:00:00Z")).toBeNull();
  });
});

describe("mapActivityType", () => {
  test("preserves current Aura transport mode granularity", () => {
    expect(mapActivityType("metro")).toBe("metro");
    expect(mapActivityType("subway")).toBe("metro");
    expect(mapActivityType("tram")).toBe("tram");
    expect(mapActivityType("electric_scooter")).toBe("eScooter");
    expect(mapActivityType("motorcycle")).toBe("motorcycle");
    expect(mapActivityType("flight")).toBe("airplane");
  });

  test("maps legacy human and vehicle activity names", () => {
    expect(mapActivityType("walking")).toBe("walk");
    expect(mapActivityType("running")).toBe("run");
    expect(mapActivityType("cycling")).toBe("bicycle");
    expect(mapActivityType("automotive")).toBe("car");
  });
});
