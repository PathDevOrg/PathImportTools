import { defaultBqdcQuantizationCm } from "./constants.js";

const magicNumber = 0x42514443;

function quantize(value: number, quantizationCentimeters: number): number {
  const precisionMeters = quantizationCentimeters / 100;
  const factor = 1e7 / precisionMeters;
  return Math.round(value * factor);
}

function toInt32(value: number): number {
  const wrapped = value >>> 0;
  return wrapped >= 0x80000000 ? wrapped - 0x100000000 : wrapped;
}

function checkedInt32(value: number): number {
  const encoded = toInt32(value);
  if (encoded !== value) {
    throw new RangeError("BQDC delta exceeds the signed 32-bit range");
  }
  return encoded;
}

function zigzagEncode(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function encodeVarint(value: number): number[] {
  let current = zigzagEncode(value);
  const bytes: number[] = [];
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current & 0x7f);
  return bytes;
}

export function encodeBQDCPath(
  coords: Array<[number, number]>,
  quantizationCentimeters = defaultBqdcQuantizationCm,
): Uint8Array {
  if (coords.length === 0) {
    throw new Error("Cannot encode empty coordinate list");
  }
  if (!Number.isInteger(quantizationCentimeters) || quantizationCentimeters < 1 || quantizationCentimeters > 0xffff) {
    throw new RangeError("BQDC quantization must be an integer between 1 and 65535 centimeters");
  }
  for (const [lon, lat] of coords) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new RangeError("BQDC coordinates must be valid latitude and longitude values");
    }
  }

  const first = coords[0];
  if (first === undefined) {
    throw new Error("Cannot encode empty coordinate list");
  }
  const [firstLon, firstLat] = first;
  const originLon = quantize(firstLon, quantizationCentimeters);
  const originLat = quantize(firstLat, quantizationCentimeters);
  const payload: number[] = [];
  let previousLon = originLon;
  let previousLat = originLat;

  for (let index = 1; index < coords.length; index += 1) {
    const coordinate = coords[index];
    if (coordinate === undefined) {
      throw new Error("BQDC coordinate list ended unexpectedly");
    }
    const [lon, lat] = coordinate;
    const nextLon = quantize(lon, quantizationCentimeters);
    const nextLat = quantize(lat, quantizationCentimeters);
    payload.push(...encodeVarint(checkedInt32(nextLon - previousLon)));
    payload.push(...encodeVarint(checkedInt32(nextLat - previousLat)));
    previousLon = nextLon;
    previousLat = nextLat;
  }

  const output = new Uint8Array(28 + payload.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, magicNumber, true);
  view.setUint8(4, 1);
  view.setUint8(5, 0);
  view.setUint16(6, quantizationCentimeters, true);
  view.setUint32(8, coords.length, true);
  view.setBigInt64(12, BigInt(originLon), true);
  view.setBigInt64(20, BigInt(originLat), true);
  output.set(payload, 28);
  return output;
}
