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

export function encodeBQDCPath(coords: Array<[number, number]>, quantizationCentimeters = 100): Uint8Array {
  if (coords.length === 0) {
    throw new Error("Cannot encode empty coordinate list");
  }

  const [firstLon, firstLat] = coords[0]!;
  const originLon = quantize(firstLon, quantizationCentimeters);
  const originLat = quantize(firstLat, quantizationCentimeters);
  const payload: number[] = [];
  let previousLon = originLon;
  let previousLat = originLat;

  for (let index = 1; index < coords.length; index += 1) {
    const [lon, lat] = coords[index]!;
    const nextLon = quantize(lon, quantizationCentimeters);
    const nextLat = quantize(lat, quantizationCentimeters);
    payload.push(...encodeVarint(toInt32(nextLon - previousLon)));
    payload.push(...encodeVarint(toInt32(nextLat - previousLat)));
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
