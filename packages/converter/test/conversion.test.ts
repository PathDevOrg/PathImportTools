import { describe, expect, test } from "vitest";
import { convertImportEntries, convertImportFileHandles, scanImportEntries, type ImportFileEntry, type ImportFileHandle, type ImportProgress } from "../src/index.js";

const text = (path: string, value: unknown): ImportFileEntry => ({
  path,
  data: new TextEncoder().encode(JSON.stringify(value))
});

describe("scanImportEntries", () => {
  test("detects Arc export, Arc backup, and Moves export sources", async () => {
    const scan = await scanImportEntries([
      text("Export/JSON/Daily/2024-05-01.json", { timelineItems: [] }),
      text("Previous Backups ABC/TimelineItem/A/item.json", {}),
      text("moves_export/json/daily/storyline/storyline_20140401.json", [])
    ]);

    expect(scan.sourceTypes).toEqual(["arc-export", "arc-backup", "moves-export"]);
    expect(scan.fileCount).toBe(3);
  });

  test("ignores Arc aggregate export files", async () => {
    const scan = await scanImportEntries([
      text("Export/JSON/Daily/2024-05-01.json", { timelineItems: [] }),
      text("Export/JSON/Monthly/2024-05.json.gz", { timelineItems: [] })
    ]);

    expect(scan.sourceTypes).toEqual(["arc-export"]);
    expect(scan.supportedFileCount).toBe(1);
    expect(scan.unknownFileCount).toBe(1);
  });
});

describe("convertImportEntries", () => {
  test("reads only supported handles and reports parse progress", async () => {
    const reads: string[] = [];
    const supported = JSON.stringify({
      timelineItems: [
        {
          isVisit: false,
          startDate: "2024-05-01T10:00:00Z",
          endDate: "2024-05-01T10:20:00Z",
          activityType: "walk"
        }
      ]
    });
    const handles: ImportFileHandle[] = [
      {
        path: "README.txt",
        size: 20,
        readData: async () => {
          reads.push("README.txt");
          return new TextEncoder().encode("ignored");
        }
      },
      {
        path: "Export/JSON/Monthly/2024-05.json",
        size: 20,
        readData: async () => {
          reads.push("Export/JSON/Monthly/2024-05.json");
          throw new Error("aggregate file should not be read");
        }
      },
      {
        path: "Export/JSON/Daily/2024-05-01.json",
        size: supported.length,
        readData: async () => {
          reads.push("Export/JSON/Daily/2024-05-01.json");
          return new TextEncoder().encode(supported);
        }
      }
    ];
    const progress: ImportProgress[] = [];

    const result = await convertImportFileHandles(handles, {
      onProgress: (event) => progress.push(event)
    });

    expect(reads).toEqual(["Export/JSON/Daily/2024-05-01.json"]);
    expect(result.rows.moves).toHaveLength(1);
    expect(progress.some((event) => event.phase === "parse" && event.completed === 1 && event.total === 1)).toBe(true);
  });

  test("converts Arc export visits and moves into Aura rows", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2024-05-01.json", {
        timelineItems: [
          {
            itemId: "stay-1",
            isVisit: true,
            startDate: "2024-05-01T09:00:00Z",
            endDate: "2024-05-01T10:00:00Z",
            radius: { mean: 35 },
            place: {
              placeId: "arc-place-1",
              name: "Circular Quay",
              location: { latitude: -33.8688, longitude: 151.2093 }
            }
          },
          {
            itemId: "move-1",
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:20:00Z",
            activityType: "metro",
            samples: [
              {
                date: "2024-05-01T10:00:00Z",
                secondsFromGMT: 36000,
                latitude: -33.8688,
                longitude: 151.2093,
                horizontalAccuracy: 8
              },
              {
                date: "2024-05-01T10:20:00Z",
                secondsFromGMT: 36000,
                latitude: -33.873,
                longitude: 151.206,
                horizontalAccuracy: 9
              }
            ]
          }
        ]
      })
    ]);

    expect(result.rows.pois).toHaveLength(1);
    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.moves[0]?.mode).toBe("metro");
    expect(result.rows.route_paths).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(2);
    expect(result.rows.samples).toHaveLength(2);
    expect(result.report.sourceTypes).toEqual(["arc-export"]);
    expect(result.report.userVersion).toBe(9);
  });

  test("normalizes overlapping events and merges adjacent compatible events", async () => {
    const progress: ImportProgress[] = [];
    const result = await convertImportEntries([
      text("Export/JSON/Daily/overlap.json", {
        timelineItems: [
          {
            itemId: "stay-1",
            isVisit: true,
            startDate: "2024-05-01T09:00:00Z",
            endDate: "2024-05-01T10:10:00Z",
            place: {
              placeId: "arc-place-1",
              name: "Home",
              location: { latitude: -33.86, longitude: 151.2 }
            }
          },
          {
            itemId: "move-1",
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:20:00Z",
            activityType: "walk"
          },
          {
            itemId: "move-2",
            isVisit: false,
            startDate: "2024-05-01T10:20:00Z",
            endDate: "2024-05-01T10:30:00Z",
            activityType: "walk"
          },
          {
            itemId: "move-3",
            isVisit: false,
            startDate: "2024-05-01T10:30:00Z",
            endDate: "2024-05-01T10:40:00Z",
            activityType: "bus"
          },
          {
            itemId: "stay-2",
            isVisit: true,
            startDate: "2024-05-01T10:35:00Z",
            endDate: "2024-05-01T11:00:00Z",
            place: {
              placeId: "arc-place-2",
              name: "Office",
              location: { latitude: -33.87, longitude: 151.21 }
            }
          }
        ]
      })
    ], {
      onProgress: (event) => progress.push(event)
    });

    expect(result.rows.stays.map((stay) => [stay.start_ts, stay.end_ts])).toEqual([
      [Date.parse("2024-05-01T09:00:00Z") / 1000, Date.parse("2024-05-01T10:00:00Z") / 1000],
      [Date.parse("2024-05-01T10:35:00Z") / 1000, Date.parse("2024-05-01T11:00:00Z") / 1000]
    ]);
    expect(result.rows.moves.map((move) => [move.mode, move.start_ts, move.end_ts])).toEqual([
      ["walk", Date.parse("2024-05-01T10:00:00Z") / 1000, Date.parse("2024-05-01T10:30:00Z") / 1000],
      ["bus", Date.parse("2024-05-01T10:30:00Z") / 1000, Date.parse("2024-05-01T10:35:00Z") / 1000]
    ]);
    const timeline = [
      ...result.rows.stays.map((row) => ({ kind: "stay", start: row.start_ts, end: row.end_ts })),
      ...result.rows.moves.map((row) => ({ kind: "move", mode: row.mode, start: row.start_ts, end: row.end_ts })),
      ...result.rows.no_data_gaps.map((row) => ({ kind: "gap", start: row.start_ts, end: row.end_ts }))
    ].sort((lhs, rhs) => lhs.start - rhs.start);
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index]!.start).toBeGreaterThanOrEqual(timeline[index - 1]!.end ?? Number.POSITIVE_INFINITY);
    }
    expect(progress.some((event) => event.phase === "normalize" && event.message === "Resolving timeline overlaps" && event.total === 5)).toBe(true);
    expect(progress.some((event) => event.phase === "normalize" && event.message === "Merging adjacent timeline events")).toBe(true);
  });

  test("normalizes events that start at the same timestamp", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/same-start.json", {
        timelineItems: [
          {
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:20:00Z",
            activityType: "walk"
          },
          {
            isVisit: true,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T11:00:00Z",
            place: {
              placeId: "arc-place-1",
              name: "Office",
              location: { latitude: -33.87, longitude: 151.21 }
            }
          }
        ]
      })
    ]);

    expect(result.rows.moves.map((move) => [move.start_ts, move.end_ts])).toEqual([
      [Date.parse("2024-05-01T10:00:00Z") / 1000, Date.parse("2024-05-01T10:20:00Z") / 1000]
    ]);
    expect(result.rows.stays.map((stay) => [stay.start_ts, stay.end_ts])).toEqual([
      [Date.parse("2024-05-01T10:20:00Z") / 1000, Date.parse("2024-05-01T11:00:00Z") / 1000]
    ]);
  });

  test("builds large import reports without overflowing the call stack", async () => {
    const timelineItems = Array.from({ length: 70_000 }, (_, index) => {
      const start = new Date(Date.UTC(2024, 0, 1, 0, index * 2, 0)).toISOString();
      const end = new Date(Date.UTC(2024, 0, 1, 0, index * 2 + 1, 0)).toISOString();
      return {
        isVisit: false,
        startDate: start,
        endDate: end,
        activityType: "walk"
      };
    });

    const result = await convertImportEntries([
      text("Export/JSON/Daily/large.json", { timelineItems })
    ]);

    expect(result.rows.moves).toHaveLength(70_000);
    expect(result.report.dateRange).toEqual({
      startTs: Date.UTC(2024, 0, 1, 0, 0, 0) / 1000,
      endTs: Date.UTC(2024, 0, 1, 0, 139_999, 0) / 1000
    });
  }, 20_000);

  test("normalizes many adjacent same-mode moves without repeated array rebuilds", async () => {
    const count = 20_000;
    const timelineItems = Array.from({ length: count }, (_, index) => {
      const start = new Date(Date.UTC(2024, 0, 1, 0, index, 0)).toISOString();
      const end = new Date(Date.UTC(2024, 0, 1, 0, index + 1, 0)).toISOString();
      return {
        isVisit: false,
        startDate: start,
        endDate: end,
        activityType: "walk",
        distance: 1
      };
    });

    const startedAt = performance.now();
    const result = await convertImportEntries([
      text("Export/JSON/Daily/adjacent.json", { timelineItems })
    ]);
    const duration = performance.now() - startedAt;

    expect(result.rows.moves).toHaveLength(1);
    expect(result.report.diagnostics.length).toBeLessThan(10);
    expect(duration).toBeLessThan(5_000);
  }, 20_000);

  test("converts Moves place and activity segments", async () => {
    const result = await convertImportEntries([
      text("moves_export/json/daily/storyline/storyline_20140401.json", [
        {
          date: "20140401",
          segments: [
            {
              type: "place",
              startTime: "20140401T080000+0300",
              endTime: "20140401T090000+0300",
              place: {
                id: 42,
                name: "Home",
                location: { lat: 60.17, lon: 24.94 }
              }
            },
            {
              type: "move",
              startTime: "20140401T090000+0300",
              endTime: "20140401T093000+0300",
              activities: [
                {
                  activity: "tram",
                  startTime: "20140401T090000+0300",
                  endTime: "20140401T093000+0300",
                  distance: 1500,
                  trackPoints: [
                    { lat: 60.17, lon: 24.94 },
                    { lat: 60.18, lon: 24.95 }
                  ]
                }
              ]
            }
          ]
        }
      ])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.moves[0]?.mode).toBe("tram");
    expect(result.rows.route_paths).toHaveLength(1);
  });
});
