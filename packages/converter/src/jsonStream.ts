import { Tokenizer, TokenParser, TokenType, type ParsedTokenInfo } from "@streamparser/json";
import { Gunzip } from "fflate";

export type StreamedJsonShape = "root-array" | "timeline-items" | "root-object";

export async function streamJsonValues(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  onValue: (value: unknown, shape: StreamedJsonShape) => void
): Promise<StreamedJsonShape> {
  const tokenizer = new Tokenizer({ stringBufferSize: 64 * 1024 });
  const bufferedTokens: ParsedTokenInfo[] = [];
  let parser: TokenParser | null = null;
  let shape: StreamedJsonShape | null = null;
  let rootIsObject = false;
  let depth = 0;
  let expectingRootKey = false;
  let sawToken = false;

  const beginParsing = (selectedShape: StreamedJsonShape): void => {
    shape = selectedShape;
    const paths = selectedShape === "root-array"
      ? ["$.*"]
      : selectedShape === "timeline-items"
        ? ["$.timelineItems.*"]
        : ["$"];
    parser = new TokenParser({ paths, keepStack: false });
    parser.onValue = ({ value }) => onValue(value, selectedShape);
    for (const token of bufferedTokens) {
      parser.write(token);
    }
    bufferedTokens.length = 0;
  };

  tokenizer.onToken = (token): void => {
    sawToken = true;
    if (parser) {
      parser.write(token);
      return;
    }
    bufferedTokens.push(token);
    if (bufferedTokens.length === 1) {
      if (token.token === TokenType.LEFT_BRACKET) {
        beginParsing("root-array");
      } else if (token.token === TokenType.LEFT_BRACE) {
        rootIsObject = true;
        depth = 1;
        expectingRootKey = true;
      } else {
        throw new Error("History JSON must contain an object or array");
      }
      return;
    }
    if (!rootIsObject) {
      return;
    }
    if (depth === 1 && expectingRootKey && token.token === TokenType.STRING) {
      expectingRootKey = false;
      if (token.value === "timelineItems") {
        beginParsing("timeline-items");
        return;
      }
      if (token.value === "itemId" || token.value === "placeId" || token.value === "sampleId" || token.value === "segments") {
        beginParsing("root-object");
        return;
      }
    }
    if (token.token === TokenType.LEFT_BRACE || token.token === TokenType.LEFT_BRACKET) {
      depth += 1;
    } else if (token.token === TokenType.RIGHT_BRACE || token.token === TokenType.RIGHT_BRACKET) {
      depth -= 1;
      if (depth === 0) {
        beginParsing("root-object");
      }
    } else if (token.token === TokenType.COMMA && depth === 1) {
      expectingRootKey = true;
    }
  };

  for await (const chunk of gunzipChunks(path, chunks)) {
    if (chunk.byteLength > 0) {
      tokenizer.write(chunk);
    }
  }
  if (!sawToken) {
    throw new Error("History JSON is empty");
  }
  if (!tokenizer.isEnded) {
    tokenizer.end();
  }
  const completedParser = parser as TokenParser | null;
  if (completedParser && !completedParser.isEnded) {
    completedParser.end();
  }
  if (!shape) {
    throw new Error("History JSON has no root value");
  }
  return shape;
}

async function* gunzipChunks(path: string, chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    while (pendingBytes < 2) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.byteLength > 0) {
        pending.push(next.value);
        pendingBytes += next.value.byteLength;
      }
    }
    const signature = firstBytes(pending, 2);
    const compressed = path.toLowerCase().endsWith(".gz")
      || signature[0] === 0x1f && signature[1] === 0x8b;
    if (!compressed) {
      yield* pending;
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    }

    const output: Uint8Array[] = [];
    let crc = initialCrc32;
    let outputBytes = 0;
    let compressedBytes = 0;
    let trailer: Uint8Array = new Uint8Array(0);
    let memberCount = 1;
    const gunzip = new Gunzip((chunk) => {
      if (chunk.byteLength > 0) {
        crc = updateCrc32(crc, chunk);
        outputBytes = (outputBytes + chunk.byteLength) >>> 0;
        output.push(chunk);
      }
    });
    gunzip.onmember = () => {
      memberCount += 1;
    };
    const nextChunk = async (): Promise<IteratorResult<Uint8Array>> => {
      const queued = pending.shift();
      return queued ? { value: queued, done: false } : iterator.next();
    };
    let current = await nextChunk();
    while (!current.done) {
      const next = await nextChunk();
      compressedBytes += current.value.byteLength;
      trailer = trailingBytes(trailer, current.value, 8);
      gunzip.push(current.value, next.done === true);
      while (output.length > 0) {
        yield output.shift()!;
      }
      current = next;
    }
    while (output.length > 0) {
      yield output.shift()!;
    }
    if (memberCount !== 1) {
      throw new Error("Concatenated gzip members are not supported");
    }
    if (compressedBytes < 18 || trailer.byteLength !== 8) {
      throw new Error("Invalid gzip trailer");
    }
    const expectedCrc = readU32LE(trailer, 0);
    const expectedSize = readU32LE(trailer, 4);
    const actualCrc = (crc ^ initialCrc32) >>> 0;
    if (actualCrc !== expectedCrc) {
      throw new Error("Gzip CRC does not match its trailer");
    }
    if (outputBytes !== expectedSize) {
      throw new Error("Gzip size does not match its trailer");
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

const initialCrc32 = 0xffffffff;
const crc32Table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return crc >>> 0;
});

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let current = crc;
  for (const byte of bytes) {
    current = crc32Table[(current ^ byte) & 0xff]! ^ current >>> 8;
  }
  return current >>> 0;
}

function trailingBytes(previous: Uint8Array, next: Uint8Array, count: number): Uint8Array {
  if (next.byteLength >= count) {
    return next.slice(next.byteLength - count);
  }
  const retained = previous.subarray(Math.max(0, previous.byteLength - (count - next.byteLength)));
  const result = new Uint8Array(retained.byteLength + next.byteLength);
  result.set(retained);
  result.set(next, retained.byteLength);
  return result;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function firstBytes(chunks: Uint8Array[], count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = count - offset;
    if (remaining <= 0) {
      break;
    }
    const slice = chunk.subarray(0, remaining);
    bytes.set(slice, offset);
    offset += slice.byteLength;
  }
  return bytes;
}
