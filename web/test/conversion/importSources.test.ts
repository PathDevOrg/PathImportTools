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

  test("uses the nested gzip footer when estimating a zip entry", async () => {
    const json = strToU8(JSON.stringify({ timelineItems: [], padding: "x".repeat(1_000_000) }));
    const archive = zipSync({ "Arc/Export/JSON/2024.json.gz": gzipSync(json) });
    const handles = await buildImportHandles([
      filePayload("arc.zip", new File([archive.buffer as ArrayBuffer], "arc.zip", { type: "application/zip" }))
    ]);

    expect(handles[0]?.size).toBeGreaterThanOrEqual(json.byteLength);
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
