import { gzipSync, zipSync, strToU8 } from "fflate";
import { describe, expect, test } from "vitest";
import { buildImportHandles } from "../../src/conversion/importSources";
import type { WorkerFilePayload } from "../../src/conversion/workerTypes";

const filePayload = (path: string, file: File): WorkerFilePayload => ({ path, file });

const readChunks = async (handle: { readChunks?: () => AsyncIterable<Uint8Array> }): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of handle.readChunks!()) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

describe("buildImportHandles", () => {
  test("indexes folder files without reading unsupported files", async () => {
    const supported = new File([JSON.stringify({ timelineItems: [] })], "2024.json", { type: "application/json" });
    const ignored = new File(["ignore me"], "notes.txt", { type: "text/plain" });
    const handles = await buildImportHandles([
      filePayload("Export/JSON/2024.json", supported),
      filePayload("notes.txt", ignored)
    ]);

    expect(handles.map((entry) => entry.path)).toEqual(["Export/JSON/2024.json", "notes.txt"]);
    expect(handles[0]?.size).toBe(supported.size);
    expect(new TextDecoder().decode(await handles[0]!.readData())).toContain("timelineItems");
    expect(new TextDecoder().decode(await readChunks(handles[0]!))).toContain("timelineItems");
  });

  test("indexes zip entries and reads one entry on demand", async () => {
    const archive = zipSync({
      "Arc/Export/JSON/2024.json": strToU8(JSON.stringify({ timelineItems: [] })),
      "Arc/notes.txt": strToU8("ignore")
    });
    const zipFile = new File([archive.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" });

    const handles = await buildImportHandles([filePayload("arc.zip", zipFile)]);
    const jsonHandle = handles.find((entry) => entry.path === "Arc/Export/JSON/2024.json");

    expect(handles.map((entry) => entry.path)).toEqual(["Arc/Export/JSON/2024.json", "Arc/notes.txt"]);
    expect(jsonHandle).toBeDefined();
    expect(new TextDecoder().decode(await jsonHandle!.readData())).toContain("timelineItems");
    expect(new TextDecoder().decode(await readChunks(jsonHandle!))).toContain("timelineItems");
  });

  test("uses the nested gzip footer when estimating a stored zip entry", async () => {
    const json = strToU8(JSON.stringify({ timelineItems: [], padding: "x".repeat(1_000_000) }));
    const archive = zipSync({ "Arc/Export/JSON/2024.json.gz": [gzipSync(json), { level: 0 }] });
    const handles = await buildImportHandles([
      filePayload("arc.zip", new File([archive.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" }))
    ]);

    expect(handles[0]?.size).toBeGreaterThanOrEqual(json.byteLength);
  });

  test("estimates a deflated nested gzip entry from its gzip size without inflating it", async () => {
    const gzip = gzipSync(strToU8(JSON.stringify({ timelineItems: [], padding: "x".repeat(1_000_000) })));
    const archive = zipSync({ "Arc/Export/JSON/2024.json.gz": [gzip, { level: 6 }] });
    const handles = await buildImportHandles([
      filePayload("arc.zip", new File([archive.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" }))
    ]);

    expect(handles[0]?.size).toBe(gzip.byteLength * 4);
  });

  test("reads every zip entry when the end record entry count has wrapped", async () => {
    const archive = zipSync({
      "Arc/a.json": strToU8("{}"),
      "Arc/b.json": strToU8("{}"),
      "Arc/c.json": strToU8("{}")
    });
    const patched = new Uint8Array(archive);
    const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
    const endOffset = patched.byteLength - 22;
    view.setUint16(endOffset + 8, 1, true);
    view.setUint16(endOffset + 10, 1, true);
    const handles = await buildImportHandles([
      filePayload("arc.zip", new File([patched.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" }))
    ]);

    expect(handles.map((entry) => entry.path)).toEqual(["Arc/a.json", "Arc/b.json", "Arc/c.json"]);
  });

  test("skips macOS AppleDouble metadata in archives and folders", async () => {
    const archive = zipSync({
      "Arc/2024.json": strToU8("{}"),
      "__MACOSX/Arc/._2024.json": strToU8("metadata"),
      "Arc/._2024.json": strToU8("metadata")
    });
    const handles = await buildImportHandles([
      filePayload("arc.zip", new File([archive.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" })),
      filePayload("Folder/._2023.json", new File(["metadata"], "._2023.json"))
    ]);

    expect(handles.map((entry) => entry.path)).toEqual(["Arc/2024.json"]);
  });

  test("rejects a zip entry whose content no longer matches its CRC", async () => {
    const content = strToU8('{"value":1}');
    const archive = zipSync({ "Arc/value.json": [content, { level: 0 }] });
    const corrupted = new Uint8Array(archive);
    const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
    const dataOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    corrupted[dataOffset + content.indexOf("1".charCodeAt(0))] = "2".charCodeAt(0);
    const handles = await buildImportHandles([
      filePayload("arc.zip", new File([corrupted.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" }))
    ]);

    await expect(handles[0]!.readData()).rejects.toThrow("CRC");
  });
});
