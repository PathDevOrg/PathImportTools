import { describe, expect, test } from "vitest";
import { gzipSync } from "fflate";
import { convertImportEntries, convertImportFileHandles, scanImportEntries, type ImportFileEntry, type ImportFileHandle, type ImportProgress } from "../src/index.js";

const text = (path: string, value: unknown): ImportFileEntry => ({
  path,
  data: new TextEncoder().encode(JSON.stringify(value))
});

const handle = (path: string, value: unknown): ImportFileHandle => {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bytes = path.endsWith(".gz") ? gzipSync(encoded) : encoded;
  return {
    path,
    size: bytes.byteLength,
    readData: async () => bytes
  };
};

describe("scanImportEntries", () => {
  test("detects Arc export, Arc backup, and Moves export sources", async () => {
    const scan = await scanImportEntries([
      handle("Export/JSON/Daily/2024-05-01.json", {
        timelineItems: [
          { itemId: "arc-item-1", isVisit: true, startDate: "2024-05-01T08:00:00Z", endDate: "2024-05-01T09:00:00Z" }
        ]
      }),
      handle("Previous Backups ABC/TimelineItem/A/item.json", {
        itemId: "backup-stay-1",
        isVisit: true,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z"
      }),
      handle("moves_export/json/daily/storyline/storyline_20140401.json", [
        {
          date: "20140401",
          segments: [
            {
              type: "place",
              startTime: "20140401T080000+0000",
              endTime: "20140401T090000+0000",
              place: { id: 42, name: "Moves", location: { lat: 60.1, lon: 24.1 } }
            }
          ]
        }
      ])
    ]);

    expect(scan.sourceTypes).toEqual(["arc-export", "arc-backup", "moves-export"]);
    expect(scan.fileCount).toBe(3);
  });

  test("accepts Arc daily and aggregate export files", async () => {
    const arcItem = { itemId: "arc-item-1", isVisit: true, startDate: "2024-05-01T08:00:00Z", endDate: "2024-05-01T09:00:00Z" };
    const scan = await scanImportEntries([
      handle("Export/JSON/Daily/2024-05-01.json", { timelineItems: [arcItem] }),
      handle("Export/JSON/Monthly/2024-05.json.gz", { timelineItems: [arcItem] })
    ]);

    expect(scan.sourceTypes).toEqual(["arc-export"]);
    expect(scan.supportedFileCount).toBe(2);
    expect(scan.unknownFileCount).toBe(0);
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
        size: supported.length,
        readData: async () => {
          reads.push("Export/JSON/Monthly/2024-05.json");
          return new TextEncoder().encode(supported);
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

    expect(reads).toContain("Export/JSON/Daily/2024-05-01.json");
    expect(reads).toContain("Export/JSON/Monthly/2024-05.json");
    expect(reads).not.toContain("README.txt");
    expect(result.rows.moves).toHaveLength(1);
    expect(progress.some((event) => event.phase === "parse")).toBe(true);
  });

  test("prefers detailed Arc daily events and keeps aggregate-only events", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2019-01-15.json", {
        timelineItems: [
          {
            itemId: "shared",
            isVisit: false,
            startDate: "2019-01-15T08:00:00Z",
            endDate: "2019-01-15T09:00:00Z",
            activityType: "walk",
            samples: [
              { date: "2019-01-15T08:00:00Z", latitude: 31, longitude: 121, coreMotionActivityType: "walking" },
              { date: "2019-01-15T08:30:00Z", latitude: 31.1, longitude: 121.1, coreMotionActivityType: "walking" }
            ]
          },
          {
            itemId: "daily-only",
            isVisit: false,
            startDate: "2019-01-15T09:00:00Z",
            endDate: "2019-01-15T10:00:00Z",
            activityType: "bus"
          }
        ]
      }),
      text("Export/JSON/Monthly/2019-01.json", {
        timelineItems: [
          {
            itemId: "shared",
            isVisit: false,
            startDate: "2019-01-15T08:00:00Z",
            endDate: "2019-01-15T09:00:00Z",
            activityType: "walk",
            samples: [
              { date: "2019-01-15T08:00:00Z", latitude: 31, longitude: 121 }
            ]
          },
          {
            itemId: "monthly-only",
            isVisit: false,
            startDate: "2019-01-15T10:00:00Z",
            endDate: "2019-01-15T11:00:00Z",
            activityType: "train"
          },
          {
            itemId: "missing-daily-date",
            isVisit: false,
            startDate: "2019-01-16T08:00:00Z",
            endDate: "2019-01-16T09:00:00Z",
            activityType: "car"
          }
        ]
      })
    ]);

    expect([...result.rows.moves].sort((lhs, rhs) => lhs.start_ts - rhs.start_ts).map((move) => move.mode)).toEqual(["walk", "bus", "train", "car"]);
    expect(result.rows.raw_gps).toHaveLength(2);
    expect(result.rows.raw_motion_activity).toHaveLength(2);
    expect(result.rows.route_paths).toHaveLength(1);
  });

  test("uses aggregate Arc events instead of generating a gap across missing daily files", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2019-01-14.json", {
        timelineItems: [
          {
            itemId: "first-stay",
            isVisit: true,
            startDate: "2019-01-14T08:00:00Z",
            endDate: "2019-01-14T09:00:00Z",
            place: { name: "First", location: { latitude: 31, longitude: 121 } }
          }
        ]
      }),
      text("Export/JSON/Monthly/2019-01.json", {
        timelineItems: [
          {
            itemId: "monthly-move",
            isVisit: false,
            startDate: "2019-01-15T08:00:00Z",
            endDate: "2019-01-15T09:00:00Z",
            activityType: "walk"
          }
        ]
      }),
      text("Export/JSON/Daily/2019-01-16.json", {
        timelineItems: [
          {
            itemId: "last-stay",
            isVisit: true,
            startDate: "2019-01-16T08:00:00Z",
            endDate: "2019-01-16T09:00:00Z",
            place: { name: "Last", location: { latitude: 31.1, longitude: 121.1 } }
          }
        ]
      })
    ]);

    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.no_data_gaps).toHaveLength(0);
  });

  test("lets Moves replace overlapping Arc semantics", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2017-04-03.json", {
        timelineItems: [
          {
            itemId: "arc-stay",
            isVisit: true,
            startDate: "2017-04-03T08:00:00Z",
            endDate: "2017-04-03T12:00:00Z",
            place: { name: "Arc", location: { latitude: 60, longitude: 24 } }
          }
        ]
      }),
      text("moves_export/json/daily/storyline/storyline_20170403.json", [
        {
          date: "20170403",
          segments: [
            {
              type: "place",
              startTime: "20170403T100000+0000",
              endTime: "20170403T110000+0000",
              place: { id: 42, name: "Moves", location: { lat: 60.1, lon: 24.1 } }
            }
          ]
        }
      ])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.stays[0]?.start_ts).toBe(Date.parse("2017-04-03T10:00:00Z") / 1000);
    expect(result.rows.pois.find((poi) => poi.name === "Moves")).toBeDefined();
  });

  test("keeps unnamed Arc backup stays without creating fake place names", async () => {
    const result = await convertImportEntries([
      text("Previous Backups ABC/Place/A/place.json", {
        placeId: "place-1",
        center: { latitude: 31, longitude: 121 },
        radius: { mean: 30 }
      }),
      text("Previous Backups ABC/TimelineItem/A/item.json", {
        itemId: "stay-1",
        isVisit: true,
        placeId: "place-1",
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z"
      })
    ]);

    expect(result.rows.pois).toHaveLength(0);
    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.stays[0]?.poi_id).toBeNull();
    expect(result.rows.stays[0]?.centroid_lat).toBe(31);
    expect(result.rows.stays[0]?.radius_m).toBe(30);
  });

  test("keeps unnamed Moves stays without creating fake place names", async () => {
    const result = await convertImportEntries([
      text("moves_export/json/daily/storyline/storyline_20140401.json", [
        {
          date: "20140401",
          segments: [
            {
              type: "place",
              startTime: "20140401T080000+0000",
              endTime: "20140401T090000+0000",
              place: { id: 42, location: { lat: 60.1, lon: 24.1 } }
            }
          ]
        }
      ]),
      text("moves_export/json/daily/storyline/storyline_20140402.json", [
        {
          date: "20140402",
          segments: [
            {
              type: "place",
              startTime: "20140402T080000+0000",
              endTime: "20140402T090000+0000",
              place: { id: 42, name: "Home", location: { lat: 60.1, lon: 24.1 } }
            },
            {
              type: "place",
              startTime: "20140402T100000+0000",
              endTime: "20140402T110000+0000",
              place: { id: 99, location: { lat: 60.2, lon: 24.2 } }
            }
          ]
        }
      ])
    ]);

    expect(result.rows.pois.map((poi) => poi.name)).toEqual(["Home"]);
    expect(result.rows.pois.some((poi) => poi.name === "Moves Place")).toBe(false);
    expect(result.rows.stays).toHaveLength(3);
    expect(result.rows.stays.filter((stay) => stay.poi_id === result.rows.pois[0]?.id)).toHaveLength(2);
    expect(result.rows.stays.filter((stay) => stay.poi_id === null)).toHaveLength(1);
  });

  test("streams large raw rows without keeping them in memory", async () => {
    const streamed: string[] = [];
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2024-05-01.json", {
        timelineItems: [
          {
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:20:00Z",
            activityType: "walk",
            samples: [
              {
                date: "2024-05-01T10:00:00Z",
                latitude: -33.8688,
                longitude: 151.2093,
                horizontalAccuracy: 8,
                coreMotionActivityType: "walking"
              }
            ],
            stepCount: 12
          }
        ]
      })
    ], {
      onRows: (table, rows) => {
        streamed.push(`${table}:${rows.length}`);
      }
    });

    expect(streamed).toEqual(["raw_gps:1", "samples:1", "raw_motion_activity:1", "raw_pedometer:1"]);
    expect(result.rows.raw_gps).toHaveLength(0);
    expect(result.rows.samples).toHaveLength(0);
    expect(result.rows.raw_motion_activity).toHaveLength(0);
    expect(result.rows.raw_pedometer).toHaveLength(0);
    expect(result.report.counts.raw_gps).toBe(1);
    expect(result.report.counts.samples).toBe(1);
    expect(result.report.counts.raw_motion_activity).toBe(1);
    expect(result.report.counts.raw_pedometer).toBe(1);
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
      ["walk", Date.parse("2024-05-01T10:00:00Z") / 1000, Date.parse("2024-05-01T10:20:00Z") / 1000],
      ["walk", Date.parse("2024-05-01T10:20:00Z") / 1000, Date.parse("2024-05-01T10:30:00Z") / 1000],
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

  test("preserves many adjacent same-mode moves without repeated array rebuilds", async () => {
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

    expect(result.rows.moves).toHaveLength(count);
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
