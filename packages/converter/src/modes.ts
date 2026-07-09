import type { MoveMode } from "./types.js";

const activityMap = new Map<string, MoveMode>([
  ["walking", "walk"],
  ["walk", "walk"],
  ["on_foot", "walk"],
  ["onfoot", "walk"],
  ["foot", "walk"],
  ["hiking", "walk"],
  ["hike", "walk"],
  ["running", "run"],
  ["run", "run"],
  ["jogging", "run"],
  ["jog", "run"],
  ["cycling", "bicycle"],
  ["bicycle", "bicycle"],
  ["bike", "bicycle"],
  ["biking", "bicycle"],
  ["car", "car"],
  ["automotive", "car"],
  ["auto", "car"],
  ["driving", "car"],
  ["drive", "car"],
  ["vehicle", "car"],
  ["bus", "bus"],
  ["train", "train"],
  ["rail", "train"],
  ["commuter", "train"],
  ["metro", "metro"],
  ["subway", "metro"],
  ["tram", "tram"],
  ["lrt", "tram"],
  ["light_rail", "tram"],
  ["streetcar", "tram"],
  ["transit", "transit"],
  ["public_transport", "transit"],
  ["transport", "transit"],
  ["e_scooter", "eScooter"],
  ["escooter", "eScooter"],
  ["electric_scooter", "eScooter"],
  ["kick_scooter", "eScooter"],
  ["motorcycle", "motorcycle"],
  ["motorbike", "motorcycle"],
  ["moto", "motorcycle"],
  ["scooter", "motorcycle"],
  ["boat", "boat"],
  ["ship", "boat"],
  ["ferry", "ferry"],
  ["flight", "airplane"],
  ["airplane", "airplane"],
  ["plane", "airplane"],
  ["aircraft", "airplane"]
]);

export function mapActivityType(value: string | null | undefined): MoveMode {
  if (!value) {
    return "other";
  }
  const key = value
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_")
    .replaceAll("/", "_");
  return activityMap.get(key) ?? "other";
}
