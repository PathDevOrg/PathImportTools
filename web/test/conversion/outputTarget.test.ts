import { describe, expect, test } from "vitest";
import { makeWorkerOutputTarget } from "../../src/conversion/outputTarget";

describe("makeWorkerOutputTarget", () => {
  test("uses File System Access save handles when available", async () => {
    const saveHandle = { name: "chosen.db" } as FileSystemFileHandle;
    const target = await makeWorkerOutputTarget({
      showSaveFilePicker: async () => saveHandle
    }, "path-import.db");

    expect(target).toEqual({ filename: "chosen.db", saveHandle });
  });

  test("falls back to worker download bytes when save picker is unavailable", async () => {
    await expect(makeWorkerOutputTarget({}, "path-import.db")).resolves.toEqual({ filename: "path-import.db" });
  });

  test("returns null when the save picker is cancelled", async () => {
    const error = new DOMException("cancelled", "AbortError");
    const target = await makeWorkerOutputTarget({
      showSaveFilePicker: async () => {
        throw error;
      }
    }, "path-import.db");

    expect(target).toBeNull();
  });

  test("falls back to automatic download when the browser blocks the save picker", async () => {
    const error = new DOMException("activation required", "SecurityError");
    const target = await makeWorkerOutputTarget({
      showSaveFilePicker: async () => {
        throw error;
      }
    }, "path-import.db");

    expect(target).toEqual({ filename: "path-import.db" });
  });
});
