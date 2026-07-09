import { describe, expect, test } from "vitest";
import { pickDirectoryFiles } from "./directoryPicker";

type TestHandle = {
  kind: "file" | "directory";
  name: string;
  getFile?: () => Promise<File>;
  entries?: () => AsyncIterableIterator<[string, TestHandle]>;
};

function fileHandle(name: string, content: string): TestHandle {
  return {
    kind: "file",
    name,
    getFile: async () => new File([content], name, { type: "application/json" })
  };
}

function directoryHandle(name: string, children: TestHandle[]): TestHandle {
  return {
    kind: "directory",
    name,
    entries: async function* () {
      for (const child of children) {
        yield [child.name, child];
      }
    }
  };
}

describe("pickDirectoryFiles", () => {
  test("returns null when the File System Access API is unavailable", async () => {
    await expect(pickDirectoryFiles({})).resolves.toBeNull();
  });

  test("returns an empty selection when the user cancels directory access", async () => {
    await expect(pickDirectoryFiles({
      showDirectoryPicker: async () => {
        throw new DOMException("cancelled", "AbortError");
      }
    })).resolves.toEqual([]);
  });

  test("reads nested files from a picked directory", async () => {
    const root = directoryHandle("movesarc", [
      directoryHandle("Export", [
        directoryHandle("JSON", [
          directoryHandle("Daily", [
            fileHandle("2024-05-01.json", "{}")
          ])
        ])
      ])
    ]);

    const files = await pickDirectoryFiles({
      showDirectoryPicker: async () => root as FileSystemDirectoryHandle
    });

    expect(files?.map((file) => file.path)).toEqual(["movesarc/Export/JSON/Daily/2024-05-01.json"]);
    expect(files?.[0]?.file.name).toBe("2024-05-01.json");
  });
});
