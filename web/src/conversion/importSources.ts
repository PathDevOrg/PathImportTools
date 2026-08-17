import { type ImportFileHandle, initialCrc32, updateCrc32 } from "@aura-importer/converter";
import { Inflate } from "fflate";
import type { WorkerFilePayload } from "./workerTypes";

type ZipEntry = {
  path: string;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

type BuildProgress = {
  message: string;
  completed: number;
  total: number;
};

const textDecoder = new TextDecoder();
const zipLocalHeaderSignature = 0x04034b50;
const zipCentralHeaderSignature = 0x02014b50;
const zipEndSignature = 0x06054b50;
const zip64EndSignature = 0x06064b50;
const zip64LocatorSignature = 0x07064b50;
const uint32Max = 0xffffffff;
const uint16Max = 0xffff;
const readChunkSize = 256 * 1024;
const gzipFooterStreamByteLimit = 16 * 1024 * 1024;

export async function buildImportHandles(
  files: WorkerFilePayload[],
  onProgress?: (progress: BuildProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<ImportFileHandle[]> {
  const entries: ImportFileHandle[] = [];
  let completed = 0;
  for (const payload of files) {
    throwIfAborted(options.signal);
    onProgress?.({
      message: `Indexing ${payload.path}`,
      completed,
      total: files.length,
    });
    if (payload.path.toLowerCase().endsWith(".zip")) {
      entries.push(...(await indexZipFile(payload.file, options.signal)));
    } else {
      const size = await estimatedInputSize(payload.path, payload.file);
      entries.push({
        path: payload.path,
        size,
        readData: async () => new Uint8Array(await payload.file.arrayBuffer()),
        readChunks: () => readBlobChunks(payload.file),
      });
    }
    completed += 1;
    onProgress?.({
      message: `Indexed ${payload.path}`,
      completed,
      total: files.length,
    });
  }
  return entries;
}

async function estimatedInputSize(path: string, file: File): Promise<number> {
  if (!path.toLowerCase().endsWith(".json.gz") || file.size < 4) {
    return file.size;
  }
  const footer = new Uint8Array(await file.slice(file.size - 4).arrayBuffer());
  const declaredSize = readU32(footer, 0);
  return Math.max(declaredSize, file.size * 4);
}

async function indexZipFile(file: File, signal?: AbortSignal): Promise<ImportFileHandle[]> {
  const directory = await readCentralDirectory(file, signal);
  const handles: ImportFileHandle[] = [];
  for (const entry of directory) {
    throwIfAborted(signal);
    handles.push({
      path: entry.path,
      size: await estimatedZipEntrySize(file, entry),
      readData: async () => readZipEntry(file, entry),
      readChunks: () => readZipEntryChunks(file, entry),
    });
  }
  return handles;
}

async function estimatedZipEntrySize(file: File, entry: ZipEntry): Promise<number> {
  if (!entry.path.toLowerCase().endsWith(".json.gz") || entry.uncompressedSize < 4) {
    return entry.uncompressedSize;
  }
  const declaredSize = await gzipDeclaredSize(file, entry);
  return Math.max(declaredSize ?? 0, entry.uncompressedSize * 4);
}

async function gzipDeclaredSize(file: File, entry: ZipEntry): Promise<number | null> {
  if (entry.compression === 0) {
    const dataOffset = await zipEntryDataOffset(file, entry);
    const footer = new Uint8Array(
      await file.slice(dataOffset + entry.compressedSize - 4, dataOffset + entry.compressedSize).arrayBuffer(),
    );
    return readU32(footer, 0);
  }
  if (entry.compressedSize > gzipFooterStreamByteLimit) {
    return null;
  }
  let footer = new Uint8Array(0);
  for await (const chunk of readZipEntryChunks(file, entry)) {
    const combined = new Uint8Array(Math.min(4, footer.length + chunk.length));
    const tailStart = Math.max(0, chunk.length - combined.length);
    const retainedFromFooter = combined.length - (chunk.length - tailStart);
    if (retainedFromFooter > 0) {
      combined.set(footer.subarray(footer.length - retainedFromFooter), 0);
    }
    combined.set(chunk.subarray(tailStart), retainedFromFooter);
    footer = combined;
  }
  return readU32(footer, 0);
}

async function zipEntryDataOffset(file: File, entry: ZipEntry): Promise<number> {
  const localHeader = new Uint8Array(
    await file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer(),
  );
  if (readU32(localHeader, 0) !== zipLocalHeaderSignature) {
    throw new Error(`Invalid zip local header for ${entry.path}`);
  }
  return entry.localHeaderOffset + 30 + readU16(localHeader, 26) + readU16(localHeader, 28);
}

async function readCentralDirectory(file: File, signal?: AbortSignal): Promise<ZipEntry[]> {
  const end = await findEndOfCentralDirectory(file);
  throwIfAborted(signal);
  let totalEntries = readU16(end.bytes, end.offset + 10);
  let centralDirectorySize = readU32(end.bytes, end.offset + 12);
  let centralDirectoryOffset = readU32(end.bytes, end.offset + 16);

  if (totalEntries === uint16Max || centralDirectorySize === uint32Max || centralDirectoryOffset === uint32Max) {
    const zip64 = await readZip64CentralDirectoryInfo(file, end.absoluteOffset);
    totalEntries = zip64.totalEntries;
    centralDirectorySize = zip64.centralDirectorySize;
    centralDirectoryOffset = zip64.centralDirectoryOffset;
  }

  const centralDirectory = new Uint8Array(
    await file.slice(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize).arrayBuffer(),
  );
  throwIfAborted(signal);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < totalEntries && offset < centralDirectory.length; index += 1) {
    if (readU32(centralDirectory, offset) !== zipCentralHeaderSignature) {
      throw new Error("Invalid zip central directory");
    }
    const compression = readU16(centralDirectory, offset + 10);
    const crc32 = readU32(centralDirectory, offset + 16);
    const compressedSize32 = readU32(centralDirectory, offset + 20);
    const uncompressedSize32 = readU32(centralDirectory, offset + 24);
    const nameLength = readU16(centralDirectory, offset + 28);
    const extraLength = readU16(centralDirectory, offset + 30);
    const commentLength = readU16(centralDirectory, offset + 32);
    const localHeaderOffset32 = readU32(centralDirectory, offset + 42);
    const nameStart = offset + 46;
    const extraStart = nameStart + nameLength;
    const extraEnd = extraStart + extraLength;
    const path = normalizeZipPath(textDecoder.decode(centralDirectory.subarray(nameStart, extraStart)));
    const zip64Values = parseZip64Extra(
      centralDirectory.subarray(extraStart, extraEnd),
      uncompressedSize32 === uint32Max,
      compressedSize32 === uint32Max,
      localHeaderOffset32 === uint32Max,
    );
    const uncompressedSize = zip64Values.uncompressedSize ?? uncompressedSize32;
    const compressedSize = zip64Values.compressedSize ?? compressedSize32;
    const localHeaderOffset = zip64Values.localHeaderOffset ?? localHeaderOffset32;

    if (path.length > 0 && !path.endsWith("/")) {
      entries.push({ path, compression, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = extraEnd + commentLength;
  }
  return entries;
}

async function findEndOfCentralDirectory(
  file: File,
): Promise<{ bytes: Uint8Array; offset: number; absoluteOffset: number }> {
  const tailLength = Math.min(file.size, 66_000);
  const tailStart = file.size - tailLength;
  const bytes = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (readU32(bytes, offset) === zipEndSignature) {
      return { bytes, offset, absoluteOffset: tailStart + offset };
    }
  }
  throw new Error("Invalid zip file: central directory not found");
}

async function readZip64CentralDirectoryInfo(
  file: File,
  endOffset: number,
): Promise<{ totalEntries: number; centralDirectorySize: number; centralDirectoryOffset: number }> {
  const locatorOffset = endOffset - 20;
  if (locatorOffset < 0) {
    throw new Error("Invalid zip64 file: locator not found");
  }
  const locator = new Uint8Array(await file.slice(locatorOffset, locatorOffset + 20).arrayBuffer());
  if (readU32(locator, 0) !== zip64LocatorSignature) {
    throw new Error("Invalid zip64 file: locator signature not found");
  }
  const zip64EndOffset = readU64(locator, 8);
  const record = new Uint8Array(await file.slice(zip64EndOffset, zip64EndOffset + 56).arrayBuffer());
  if (readU32(record, 0) !== zip64EndSignature) {
    throw new Error("Invalid zip64 file: end record signature not found");
  }
  return {
    totalEntries: readU64(record, 32),
    centralDirectorySize: readU64(record, 40),
    centralDirectoryOffset: readU64(record, 48),
  };
}

function parseZip64Extra(
  extra: Uint8Array,
  needsUncompressedSize: boolean,
  needsCompressedSize: boolean,
  needsLocalHeaderOffset: boolean,
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  const values: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = readU16(extra, offset);
    const length = readU16(extra, offset + 2);
    offset += 4;
    if (id === 0x0001) {
      let fieldOffset = offset;
      if (needsUncompressedSize) {
        values.uncompressedSize = readU64(extra, fieldOffset);
        fieldOffset += 8;
      }
      if (needsCompressedSize) {
        values.compressedSize = readU64(extra, fieldOffset);
        fieldOffset += 8;
      }
      if (needsLocalHeaderOffset) {
        values.localHeaderOffset = readU64(extra, fieldOffset);
      }
      return values;
    }
    offset += length;
  }
  return values;
}

async function readZipEntry(file: File, entry: ZipEntry): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of readZipEntryChunks(file, entry)) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function* readZipEntryChunks(file: File, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const dataOffset = await zipEntryDataOffset(file, entry);
  if (entry.compression === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new Error(`Stored zip entry size does not match its directory record: ${entry.path}`);
    }
    let produced = 0;
    let crc = initialCrc32;
    for await (const chunk of readBlobChunks(file.slice(dataOffset, dataOffset + entry.compressedSize))) {
      produced += chunk.byteLength;
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
    if (produced !== entry.uncompressedSize) {
      throw new Error(`Zip entry size does not match its directory record: ${entry.path}`);
    }
    verifyCrc32(entry, crc);
    return;
  }
  if (entry.compression === 8) {
    const output: Uint8Array[] = [];
    const inflate = new Inflate((chunk) => {
      if (chunk.byteLength > 0) {
        output.push(chunk);
      }
    });
    let produced = 0;
    let crc = initialCrc32;
    for (let offset = 0; offset < entry.compressedSize; offset += readChunkSize) {
      const end = Math.min(entry.compressedSize, offset + readChunkSize);
      const chunk = new Uint8Array(await file.slice(dataOffset + offset, dataOffset + end).arrayBuffer());
      inflate.push(chunk, end === entry.compressedSize);
      while (output.length > 0) {
        const inflated = output.shift()!;
        produced += inflated.byteLength;
        if (produced > entry.uncompressedSize) {
          throw new Error(`Zip entry expands beyond its declared size: ${entry.path}`);
        }
        crc = updateCrc32(crc, inflated);
        yield inflated;
      }
    }
    if (produced !== entry.uncompressedSize) {
      throw new Error(`Zip entry size does not match its directory record: ${entry.path}`);
    }
    verifyCrc32(entry, crc);
    return;
  }
  throw new Error(`Unsupported zip compression method ${entry.compression} in ${entry.path}`);
}

function verifyCrc32(entry: ZipEntry, crc: number): void {
  const actual = (crc ^ initialCrc32) >>> 0;
  if (actual !== entry.crc32) {
    throw new Error(`Zip entry CRC does not match its directory record: ${entry.path}`);
  }
}

async function* readBlobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += readChunkSize) {
    yield new Uint8Array(await blob.slice(offset, offset + readChunkSize).arrayBuffer());
  }
}

function normalizeZipPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was cancelled", "AbortError");
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readU64(bytes: Uint8Array, offset: number): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Zip entry is too large for this browser runtime");
  }
  return Number(value);
}
