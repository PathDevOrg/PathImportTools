import { describe, expect, test } from "vitest";
import { pickDirectoryFiles } from "../../src/conversion/directoryPicker";

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
    await expect(pickDirectoryFiles({}, "path-import.db")).resolves.toBeNull();
  });

  test("returns an empty selection when the user cancels directory access", async () => {
    await expect(pickDirectoryFiles({
      showDirectoryPicker: async () => {
        throw new DOMException("cancelled", "AbortError");
      }
    }, "path-import.db")).resolves.toEqual({ files: [], directory: null, filename: "path-import.db" });
  });

  test("reads nested files from a picked writable directory", async () => {
    const calls: Array<{ mode?: "read" | "readwrite" }> = [];
    const root = directoryHandle("movesarc", [
      directoryHandle("Export", [
        directoryHandle("JSON", [
          directoryHandle("Daily", [
            fileHandle("2024-05-01.json", "{}")
          ])
        ])
      ])
    ]);

    const selection = await pickDirectoryFiles({
      showDirectoryPicker: async (options) => {
        calls.push(options ?? {});
        return root as FileSystemDirectoryHandle;
      }
    }, "path-import.db");

    expect(calls).toEqual([{ mode: "readwrite" }]);
    expect(selection?.directory?.name).toBe("movesarc");
    expect(selection?.filename).toBe("path-import.db");
    expect(selection?.files.map((file) => file.path)).toEqual(["movesarc/Export/JSON/Daily/2024-05-01.json"]);
    expect(selection?.files[0]?.file.name).toBe("2024-05-01.json");
  });
});
