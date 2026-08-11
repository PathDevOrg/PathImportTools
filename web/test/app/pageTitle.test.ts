import { describe, expect, test } from "vitest";
import { makeImportFilename, makeUniqueImportFilename } from "../../src/conversion/outputFilename";
import { pageTitle } from "../../src/app/pageTitle";

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
    expect(makeImportFilename(new Date(2026, 4, 14, 9, 7, 6))).toBe("path-import-20260514-090706.db");
  });

  test("adds a suffix instead of overwriting an existing directory export", async () => {
    const existing = new Set(["path-import.db", "path-import-2.db"]);
    const directory = {
      getFileHandle: async (name: string) => {
        if (!existing.has(name)) {
          throw new DOMException("missing", "NotFoundError");
        }
        return { name };
      }
    } as FileSystemDirectoryHandle;

    await expect(makeUniqueImportFilename(directory, "path-import.db")).resolves.toBe("path-import-3.db");
  });
});
