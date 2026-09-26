import { convertImportEntries } from "@aura-importer/converter";
import { describe, expect, test } from "vitest";
import { createAuraDatabaseWriter } from "../../src/conversion/database.js";

const encoder = new TextEncoder();

type FakeDirectory = {
  handle: FileSystemDirectoryHandle;
  files: Map<string, number>;
  removed: string[];
};

function fakeDirectory(failWrites = false): FakeDirectory {
  const files = new Map<string, number>();
  const removed: string[] = [];
  const handle = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) {
          throw new DOMException("missing", "NotFoundError");
        }
        files.set(name, 0);
      }
      return {
        name,
        createWritable: async () => ({
          write: async (data: Uint8Array) => {
            if (failWrites) {
              throw new DOMException("disk full", "QuotaExceededError");
            }
            files.set(name, (files.get(name) ?? 0) + data.byteLength);
          },
          close: async () => undefined,
          abort: async () => undefined,
        }),
      };
    },
    removeEntry: async (name: string) => {
      files.delete(name);
      removed.push(name);
    },
  } as unknown as FileSystemDirectoryHandle;
  return { handle, files, removed };
}

async function convertedMove() {
  return convertImportEntries([
    {
      path: "Export/JSON/Daily/2024-05-01.json",
      data: encoder.encode(
        JSON.stringify({
          timelineItems: [
            {
              itemId: "move-1",
              isVisit: false,
              startDate: "2024-05-01T10:00:00Z",
              endDate: "2024-05-01T10:20:00Z",
              activityType: "walk",
            },
          ],
        }),
      ),
    },
  ]);
}

describe("database save directory", () => {
  test("creates the output file in the selected folder only when the database is saved", async () => {
    const result = await convertedMove();
    const directory = fakeDirectory();
    const writer = await createAuraDatabaseWriter(() => undefined, {
      filename: "path-import.db",
      saveDirectory: directory.handle,
    });

    expect(directory.files.size).toBe(0);
    const output = await writer.finish(result);

    expect(output).toEqual(expect.objectContaining({ filename: "path-import.db", savedToDisk: true }));
    expect(directory.files.get("path-import.db")).toBeGreaterThan(0);
  });

  test("removes the created output file when saving to the selected folder fails", async () => {
    const result = await convertedMove();
    const directory = fakeDirectory(true);
    const writer = await createAuraDatabaseWriter(() => undefined, {
      filename: "path-import.db",
      saveDirectory: directory.handle,
    });

    await expect(writer.finish(result)).rejects.toThrow("disk full");
    expect(directory.files.size).toBe(0);
    expect(directory.removed).toEqual(["path-import.db"]);
  });
});
