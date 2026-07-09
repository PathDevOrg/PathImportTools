import { describe, expect, test } from "vitest";
import { makeImportFilename } from "./outputFilename";
import { pageTitle } from "./pageTitle";

describe("pageTitle", () => {
  test("shows active phase and percent while converting", () => {
    expect(pageTitle("converting", {
      phase: "normalize",
      message: "Resolving timeline overlaps",
      completed: 42,
      total: 100
    })).toBe("Normalizing 42% - Path Import");
  });

  test("shows terminal states without stale progress", () => {
    expect(pageTitle("error", {
      phase: "write",
      message: "Writing rows",
      completed: 80,
      total: 100
    })).toBe("Stopped - Path Import");
    expect(pageTitle("complete", null)).toBe("Done - Path Import");
  });
});

describe("makeImportFilename", () => {
  test("formats the timestamp used by save picker and worker output", () => {
    expect(makeImportFilename(new Date(2026, 4, 14, 9, 7))).toBe("path-import-20260514-0907.db");
  });
});
