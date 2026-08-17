import type { Bounds } from "./types.js";

export function calculateBounds(coords: Array<[number, number]>): Bounds | null {
  if (coords.length === 0) {
    return null;
  }

  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;

  for (const [lon, lat] of coords) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }

  return { minLat, minLon, maxLat, maxLon };
}

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calculatePathDistance(coords: Array<[number, number]>): number | null {
  if (coords.length < 2) {
    return null;
  }

  let total = 0;
  for (let index = 1; index < coords.length; index += 1) {
    const [prevLon, prevLat] = coords[index - 1]!;
    const [lon, lat] = coords[index]!;
    total += haversineDistance(prevLat, prevLon, lat, lon);
  }
  return total;
}

export function validLatLon(lat: unknown, lon: unknown): boolean {
  return typeof lat === "number" && typeof lon === "number" && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
