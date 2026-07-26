import { inflateSync } from "fflate";
import type { ImportFileHandle } from "@aura-importer/converter";
import type { WorkerFilePayload } from "./workerTypes";

type ZipEntry = {
  path: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

type BuildProgress = {
  message: string;
  completed: number;
  total: number;
  bytesCompleted: number;
  bytesTotal: number;
};

const textDecoder = new TextDecoder();
const zipLocalHeaderSignature = 0x04034b50;
const zipCentralHeaderSignature = 0x02014b50;
const zipEndSignature = 0x06054b50;
const zip64EndSignature = 0x06064b50;
const zip64LocatorSignature = 0x07064b50;
const uint32Max = 0xffffffff;
const uint16Max = 0xffff;

export async function buildImportHandles(files: WorkerFilePayload[], onProgress?: (progress: BuildProgress) => void): Promise<ImportFileHandle[]> {
  const entries: ImportFileHandle[] = [];
  const bytesTotal = files.reduce((sum, payload) => sum + payload.file.size, 0);
  let completed = 0;
  let bytesCompleted = 0;
  for (const payload of files) {
    onProgress?.({
      message: `Indexing ${payload.path}`,
      completed,
      total: files.length,
      bytesCompleted,
      bytesTotal
    });
    if (payload.path.toLowerCase().endsWith(".zip")) {
      entries.push(...await indexZipFile(payload.file));
    } else {
      entries.push({
        path: payload.path,
        size: payload.file.size,
        readData: async () => new Uint8Array(await payload.file.arrayBuffer())
      });
    }
    completed += 1;
    bytesCompleted += payload.file.size;
    onProgress?.({
      message: `Indexed ${payload.path}`,
      completed,
      total: files.length,
      bytesCompleted,
      bytesTotal
    });
  }
  return entries;
}

async function indexZipFile(file: File): Promise<ImportFileHandle[]> {
  const directory = await readCentralDirectory(file);
  return directory.map((entry) => ({
    path: entry.path,
    size: entry.uncompressedSize,
    readData: async () => readZipEntry(file, entry)
  }));
}

async function readCentralDirectory(file: File): Promise<ZipEntry[]> {
  const end = await findEndOfCentralDirectory(file);
  let totalEntries = readU16(end.bytes, end.offset + 10);
  let centralDirectorySize = readU32(end.bytes, end.offset + 12);
  let centralDirectoryOffset = readU32(end.bytes, end.offset + 16);

  if (totalEntries === uint16Max || centralDirectorySize === uint32Max || centralDirectoryOffset === uint32Max) {
    const zip64 = await readZip64CentralDirectoryInfo(file, end.absoluteOffset);
    totalEntries = zip64.totalEntries;
    centralDirectorySize = zip64.centralDirectorySize;
    centralDirectoryOffset = zip64.centralDirectoryOffset;
  }

  const centralDirectory = new Uint8Array(await file.slice(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize).arrayBuffer());
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < totalEntries && offset < centralDirectory.length; index += 1) {
    if (readU32(centralDirectory, offset) !== zipCentralHeaderSignature) {
      throw new Error("Invalid zip central directory");
    }
    const compression = readU16(centralDirectory, offset + 10);
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
      localHeaderOffset32 === uint32Max
    );
    const uncompressedSize = zip64Values.uncompressedSize ?? uncompressedSize32;
    const compressedSize = zip64Values.compressedSize ?? compressedSize32;
    const localHeaderOffset = zip64Values.localHeaderOffset ?? localHeaderOffset32;

    if (path.length > 0 && !path.endsWith("/")) {
      entries.push({ path, compression, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = extraEnd + commentLength;
  }
  return entries;
}

async function findEndOfCentralDirectory(file: File): Promise<{ bytes: Uint8Array; offset: number; absoluteOffset: number }> {
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
  endOffset: number
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
    centralDirectoryOffset: readU64(record, 48)
  };
}

function parseZip64Extra(
  extra: Uint8Array,
  needsUncompressedSize: boolean,
  needsCompressedSize: boolean,
  needsLocalHeaderOffset: boolean
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
  const localHeader = new Uint8Array(await file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
  if (readU32(localHeader, 0) !== zipLocalHeaderSignature) {
    throw new Error(`Invalid zip local header for ${entry.path}`);
  }
  const nameLength = readU16(localHeader, 26);
  const extraLength = readU16(localHeader, 28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = new Uint8Array(await file.slice(dataOffset, dataOffset + entry.compressedSize).arrayBuffer());
  if (entry.compression === 0) {
    return compressed;
  }
  if (entry.compression === 8) {
    return inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
  }
  throw new Error(`Unsupported zip compression method ${entry.compression} in ${entry.path}`);
}

function normalizeZipPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
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
