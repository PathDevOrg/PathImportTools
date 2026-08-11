import { describe, expect, test } from "vitest";
import { gzipSync } from "fflate";
import { convertImportEntries, convertImportFileHandles, scanImportEntries, type ImportFileEntry, type ImportFileHandle, type ImportProgress } from "../src/index.js";

const text = (path: string, value: unknown): ImportFileEntry => ({
  path,
  data: new TextEncoder().encode(JSON.stringify(value))
});

describe("partial and mixed evidence conversion", () => {
  test("uses stable Moves venue identities while retaining temporary place aliases", async () => {
    const result = await convertImportEntries([text("moves.json", [{
      date: "20140402",
      segments: [{
        type: "place",
        startTime: "20140402T080000Z",
        endTime: "20140402T090000Z",
        place: {
          id: 101,
          facebookPlaceId: "facebook-home",
          foursquareId: "foursquare-home",
          name: "Home",
          location: { lat: 31.2, lon: 121.4 }
        }
      }, {
        type: "move",
        startTime: "20140402T090000Z",
        endTime: "20140402T100000Z",
        activity: "walking"
      }, {
        type: "place",
        startTime: "20140402T100000Z",
        endTime: "20140402T110000Z",
        place: {
          id: 202,
          facebookPlaceId: "facebook-home",
          foursquareId: "foursquare-home",
          name: "Home",
          location: { lat: 31.2, lon: 121.4 }
        }
      }]
    }])]);

    expect(result.rows.pois).toEqual([
      expect.objectContaining({ provider: "moves", provider_poi_id: "facebook-home", visitCount: 2 })
    ]);
    expect(result.rows.stay_pois).toHaveLength(2);
    expect(new Set(result.rows.stay_pois.map((relation) => relation.poi_id)).size).toBe(1);
  });

  test("resolves a later Moves place through its temporary id alias", async () => {
    const result = await convertImportEntries([text("moves.json", [{
      date: "20140402",
      segments: [{
        type: "place",
        startTime: "20140402T080000Z",
        endTime: "20140402T090000Z",
        place: {
          id: 101,
          foursquareId: "foursquare-home",
          location: { lat: 31.2, lon: 121.4 }
        }
      }, {
        type: "move",
        startTime: "20140402T090000Z",
        endTime: "20140402T100000Z",
        activity: "walking"
      }, {
        type: "place",
        startTime: "20140402T100000Z",
        endTime: "20140402T110000Z",
        place: {
          id: 101,
          name: "Home",
          location: { lat: 31.2, lon: 121.4 }
        }
      }]
    }])]);

    expect(result.rows.pois).toEqual([
      expect.objectContaining({ provider_poi_id: "foursquare-home", visitCount: 2 })
    ]);
    expect(new Set(result.rows.stay_pois.map((relation) => relation.poi_id)).size).toBe(1);
  });

  test("materializes an exact Arc visit projection only once", async () => {
    const visit = {
      isVisit: true,
      startDate: "2024-05-01T08:00:00Z",
      endDate: "2024-05-01T09:00:00Z",
      secondsFromGMT: 36_000,
      center: { latitude: -33.8688, longitude: 151.2093 },
      radius: { mean: 25 }
    };
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [
        { ...visit, itemId: "visit-a" },
        { ...visit, itemId: "visit-b" }
      ]
    })]);

    expect(result.rows.raw_visits).toEqual([expect.objectContaining({
      arrival_ts: Date.parse("2024-05-01T08:00:00Z") / 1000,
      departure_ts: Date.parse("2024-05-01T09:00:00Z") / 1000,
      lat: -33.8688,
      lon: 151.2093,
      horizontal_acc_m: 25,
      tz_offset_s: 36_000
    })]);
  });

  test("preserves overlapping Arc visits whose raw projections differ", async () => {
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [{
        itemId: "visit-a",
        isVisit: true,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z",
        center: { latitude: -33.8688, longitude: 151.2093 },
        radius: { mean: 25 }
      }, {
        itemId: "visit-b",
        isVisit: true,
        startDate: "2024-05-01T08:30:00Z",
        endDate: "2024-05-01T09:30:00Z",
        center: { latitude: -33.8687, longitude: 151.2094 },
        radius: { mean: 30 }
      }]
    })]);

    expect(result.rows.raw_visits).toHaveLength(2);
  });

  test("does not synthesize a raw visit for a reconstructed Arc stay", async () => {
    const samples = [0, 60, 120].map((seconds) => {
      const date = new Date(Date.parse("2021-03-15T08:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `stationary-${seconds}`,
        date,
        movingState: "stationary",
        location: {
          timestamp: date,
          latitude: -33.8688 + seconds / 10_000_000,
          longitude: 151.2093 + seconds / 10_000_000,
          horizontalAccuracy: 10
        }
      };
    });
    const result = await convertImportEntries([text("LocomotionSample/stationary.json", samples)]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.raw_visits).toHaveLength(0);
  });

  test("reconstructs orphan Arc samples even when another date has timeline items", async () => {
    const result = await convertImportEntries([
      text("timeline.json", {
        timelineItems: [{
          itemId: "known-stay",
          isVisit: true,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T09:00:00Z",
          center: { latitude: 1, longitude: 1 },
          radius: { mean: 20 }
        }]
      }),
      text("samples.json", [
        { sampleId: "s1", timelineItemId: "missing-item", date: "2021-03-15T08:00:00Z", movingState: "stationary", location: { latitude: 2, longitude: 2, timestamp: "2021-03-15T08:00:00Z" } },
        { sampleId: "s2", timelineItemId: "missing-item", date: "2021-03-15T08:01:00Z", movingState: "stationary", location: { latitude: 2.00001, longitude: 2.00001, timestamp: "2021-03-15T08:01:00Z" } },
        { sampleId: "s3", timelineItemId: "missing-item", date: "2021-03-15T08:02:00Z", movingState: "stationary", location: { latitude: 2.00002, longitude: 2.00002, timestamp: "2021-03-15T08:02:00Z" } }
      ])
    ]);

    expect(result.rows.stays).toHaveLength(2);
    expect(result.rows.stays.some((stay) => stay.start_ts === Date.parse("2021-03-15T08:00:00Z") / 1000)).toBe(true);
  });

  test("does not reconstruct samples linked to a tombstoned Arc timeline item", async () => {
    const samples = [0, 60, 120].map((seconds) => {
      const date = new Date(Date.parse("2021-03-15T08:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `deleted-${seconds}`,
        timelineItemId: "deleted-item",
        date,
        movingState: "stationary",
        location: { timestamp: date, latitude: 1, longitude: 1 }
      };
    });
    const result = await convertImportEntries([
      text("TimelineItem/old.json", {
        itemId: "deleted-item",
        isVisit: true,
        startDate: "2021-03-15T08:00:00Z",
        endDate: "2021-03-15T08:03:00Z",
        lastSaved: "2024-01-01T00:00:00Z"
      }),
      text("TimelineItem/deleted.json", {
        itemId: "deleted-item",
        deleted: true,
        lastSaved: "2024-01-02T00:00:00Z"
      }),
      text("LocomotionSample/samples.json", samples)
    ]);

    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.raw_gps).toHaveLength(3);
  });

  test("keeps unmatched Arc pedometer windows when Moves covers only part of the day", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [{
          itemId: "arc-early",
          isVisit: false,
          startDate: "2024-03-01T00:30:00Z",
          endDate: "2024-03-01T00:40:00Z",
          activityType: "walking",
          stepCount: 500
        }, {
          itemId: "arc-late",
          isVisit: false,
          startDate: "2024-03-01T06:00:00Z",
          endDate: "2024-03-01T06:20:00Z",
          activityType: "walking",
          stepCount: 600
        }]
      }),
      text("moves.json", [{
        date: "20240301",
        summary: [{ activity: "walking", steps: 500 }],
        segments: [{
          type: "move",
          startTime: "20240301T003000Z",
          endTime: "20240301T004000Z",
          activities: [{ activity: "walking", startTime: "20240301T003000Z", endTime: "20240301T004000Z", steps: 500 }]
        }]
      }])
    ]);

    expect(result.rows.raw_pedometer.reduce((sum, row) => sum + (row.steps_delta ?? 0), 0)).toBe(1100);
  });

  test("uses lastSaved when resolving Moves summary revisions", async () => {
    const old = [{ date: "20240301", lastSaved: "2024-03-01T10:00:00Z", summary: [{ activity: "walking", steps: 100, distance: 80 }] }];
    const middle = [{ date: "20240301", lastSaved: "2024-03-01T11:00:00Z", summary: [{ activity: "walking", distance: 120 }] }];
    const current = [{ date: "20240301", lastSaved: "2024-03-01T12:00:00Z", summary: [{ activity: "walking", steps: 200 }] }];
    const first = await convertImportEntries([text("a.json", old), text("b.json", middle), text("c.json", current)]);
    const second = await convertImportEntries([text("a.json", old), text("b.json", current), text("c.json", middle)]);

    expect(first.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 200, distance_m: 120 })]);
    expect(second.rows.raw_pedometer).toEqual(first.rows.raw_pedometer);
  });

  test("fuses chained Moves activity revisions independently of input order", async () => {
    const activityA = { activity: "walking", startTime: "20240301T100000Z", endTime: "20240301T114000Z", distance: 100, lastUpdate: "2024-03-01T10:00:00Z" };
    const activityB = { activity: "walking", startTime: "20240301T101500Z", endTime: "20240301T115500Z", distance: 200, lastUpdate: "2024-03-01T11:00:00Z" };
    const activityC = { activity: "walking", startTime: "20240301T103000Z", endTime: "20240301T121000Z", distance: 300, lastUpdate: "2024-03-01T12:00:00Z" };
    const convert = (activities: Array<Record<string, unknown>>) => convertImportEntries([text("moves.json", [{
      date: "20240301",
      segments: [{
        type: "move",
        startTime: "20240301T100000Z",
        endTime: "20240301T121000Z",
        activities
      }]
    }])]);

    const first = await convert([activityA, activityC, activityB]);
    const second = await convert([activityA, activityB, activityC]);
    const projection = (result: Awaited<ReturnType<typeof convert>>) => result.rows.moves.map((move) => ({
      start: move.start_ts,
      end: move.end_ts,
      mode: move.mode,
      distance: move.distance_m
    }));

    expect(projection(first)).toEqual(projection(second));
    expect(first.rows.moves).toHaveLength(1);
  });

  test("retains timestamped routes when one-second activity overlaps are normalized", async () => {
    const result = await convertImportEntries([text("moves.json", [{
      date: "20240301",
      segments: [{
        type: "move",
        startTime: "20240301T080000Z",
        endTime: "20240301T100000Z",
        activities: [{
          activity: "walking",
          startTime: "20240301T080000Z",
          endTime: "20240301T090001Z",
          trackPoints: [
            { time: "20240301T080000Z", lat: 1, lon: 1 },
            { time: "20240301T083000Z", lat: 1.01, lon: 1.01 },
            { time: "20240301T090000Z", lat: 1.02, lon: 1.02 }
          ]
        }, {
          activity: "transport",
          startTime: "20240301T090000Z",
          endTime: "20240301T100000Z",
          trackPoints: [
            { time: "20240301T090000Z", lat: 1.02, lon: 1.02 },
            { time: "20240301T093000Z", lat: 1.03, lon: 1.03 },
            { time: "20240301T100000Z", lat: 1.04, lon: 1.04 }
          ]
        }]
      }]
    }])]);

    expect(result.rows.moves).toHaveLength(2);
    expect(result.rows.route_paths).toHaveLength(2);
    expect(result.rows.route_paths.every((route) => route.sample_count >= 2)).toBe(true);
  });

  test("absorbs one-second cross-source boundary residuals into the preferred move", async () => {
    const moves = (start: string, end: string) => [{
      date: "20240301",
      segments: [{
        type: "move",
        startTime: start,
        endTime: end,
        activities: [{
          activity: "walking",
          startTime: start,
          endTime: end,
          trackPoints: [
            { time: start, lat: 1, lon: 1 },
            { time: end, lat: 1.01, lon: 1.01 }
          ]
        }]
      }]
    }];
    const arcMove = (start: string, end: string, mode = "walking") => ({
      itemId: `${start}-${end}`,
      isVisit: false,
      startDate: start,
      endDate: end,
      activityType: mode
    });

    const suffix = await convertImportEntries([
      text("arc.json", { timelineItems: [arcMove("2024-03-01T08:00:00Z", "2024-03-01T09:00:01Z")] }),
      text("moves.json", moves("20240301T080000Z", "20240301T090000Z"))
    ]);
    expect(suffix.rows.moves).toEqual([expect.objectContaining({
      start_ts: Date.parse("2024-03-01T08:00:00Z") / 1000,
      end_ts: Date.parse("2024-03-01T09:00:01Z") / 1000,
      provider: "moves_export"
    })]);

    const routedArc = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        ...arcMove("2024-03-01T08:00:00Z", "2024-03-01T09:00:00Z"),
        samples: [
          { date: "2024-03-01T08:00:00Z", location: { timestamp: "2024-03-01T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2024-03-01T09:00:00Z", location: { timestamp: "2024-03-01T09:00:00Z", latitude: 1.01, longitude: 1.01 } }
        ]
      }] }),
      text("moves.json", moves("20240301T080000Z", "20240301T090001Z"))
    ]);
    expect(routedArc.rows.moves).toEqual([expect.objectContaining({
      start_ts: Date.parse("2024-03-01T08:00:00Z") / 1000,
      end_ts: Date.parse("2024-03-01T09:00:01Z") / 1000,
      provider: "arc_import"
    })]);
    expect(routedArc.rows.route_paths).toHaveLength(1);

    const prefix = await convertImportEntries([
      text("arc.json", { timelineItems: [arcMove("2024-03-01T07:59:59Z", "2024-03-01T09:00:00Z")] }),
      text("moves.json", moves("20240301T080000Z", "20240301T090000Z"))
    ]);
    expect(prefix.rows.moves).toEqual([expect.objectContaining({
      start_ts: Date.parse("2024-03-01T07:59:59Z") / 1000,
      end_ts: Date.parse("2024-03-01T09:00:00Z") / 1000,
      provider: "moves_export"
    })]);

    const enclosed = await convertImportEntries([
      text("arc.json", { timelineItems: [arcMove("2024-03-01T08:00:00Z", "2024-03-01T09:00:01Z", "car")] }),
      text("moves.json", moves("20240301T081000Z", "20240301T090000Z"))
    ]);
    expect(enclosed.rows.moves.map((move) => [move.mode, move.start_ts, move.end_ts])).toEqual([
      ["car", Date.parse("2024-03-01T08:00:00Z") / 1000, Date.parse("2024-03-01T08:10:00Z") / 1000],
      ["walk", Date.parse("2024-03-01T08:10:00Z") / 1000, Date.parse("2024-03-01T09:00:01Z") / 1000]
    ]);
    expect(enclosed.rows.moves.every((move) => move.end_ts! - move.start_ts > 1)).toBe(true);
  });

  test("keeps an independent routed one-second Arc move", async () => {
    const start = Date.parse("2024-03-01T08:00:00Z") / 1000;
    const end = start + 1;
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [{
        itemId: "one-second-run",
        isVisit: false,
        startDate: "2024-03-01T08:00:00Z",
        endDate: "2024-03-01T08:00:01Z",
        activityType: "running",
        samples: [{
          sampleId: "one-second-start",
          timelineItemId: "one-second-run",
          date: "2024-03-01T08:00:00Z",
          location: { timestamp: "2024-03-01T08:00:00Z", latitude: 1, longitude: 1 }
        }, {
          sampleId: "one-second-end",
          timelineItemId: "one-second-run",
          date: "2024-03-01T08:00:01Z",
          location: { timestamp: "2024-03-01T08:00:01Z", latitude: 1.0001, longitude: 1.0001 }
        }]
      }]
    })]);

    expect(result.rows.moves).toEqual([expect.objectContaining({
      start_ts: start,
      end_ts: end,
      mode: "run",
      provider: "arc_import"
    })]);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({
      move_id: result.rows.moves[0]!.id,
      sample_count: 2
    })]);
    expect(result.rows.raw_gps.map((row) => row.ts).sort((lhs, rhs) => lhs - rhs)).toEqual([start, end]);
  });

  test("keeps two-second Arc and Moves boundary residuals", async () => {
    const moves = (start: string, end: string) => [{
      date: "20240301",
      segments: [{
        type: "move",
        startTime: start,
        endTime: end,
        activities: [{
          activity: "walking",
          startTime: start,
          endTime: end,
          trackPoints: [
            { time: start, lat: 1, lon: 1 },
            { time: end, lat: 1.01, lon: 1.01 }
          ]
        }]
      }]
    }];
    const arcMove = (startDate: string, endDate: string) => ({
      itemId: `${startDate}-${endDate}`,
      isVisit: false,
      startDate,
      endDate,
      activityType: "walking"
    });
    const project = (result: Awaited<ReturnType<typeof convertImportEntries>>) => [...result.rows.moves]
      .sort((lhs, rhs) => lhs.start_ts - rhs.start_ts)
      .map((move) => [move.provider, move.start_ts, move.end_ts]);
    const timestamp = (value: string) => Date.parse(value) / 1000;

    const suffix = await convertImportEntries([
      text("arc.json", { timelineItems: [arcMove("2024-03-01T08:00:00Z", "2024-03-01T09:00:02Z")] }),
      text("moves.json", moves("20240301T080000Z", "20240301T090000Z"))
    ]);
    expect(project(suffix)).toEqual([
      ["moves_export", timestamp("2024-03-01T08:00:00Z"), timestamp("2024-03-01T09:00:00Z")],
      ["arc_import", timestamp("2024-03-01T09:00:00Z"), timestamp("2024-03-01T09:00:02Z")]
    ]);

    const prefix = await convertImportEntries([
      text("arc.json", { timelineItems: [arcMove("2024-03-01T07:59:58Z", "2024-03-01T09:00:00Z")] }),
      text("moves.json", moves("20240301T080000Z", "20240301T090000Z"))
    ]);
    expect(project(prefix)).toEqual([
      ["arc_import", timestamp("2024-03-01T07:59:58Z"), timestamp("2024-03-01T08:00:00Z")],
      ["moves_export", timestamp("2024-03-01T08:00:00Z"), timestamp("2024-03-01T09:00:00Z")]
    ]);
  });

  test("absorbs a one-second cross-source residual with a different mode without dropping raw GPS", async () => {
    const residualEnd = Date.parse("2024-03-01T09:00:01Z") / 1000;
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "arc-car",
        isVisit: false,
        startDate: "2024-03-01T08:00:00Z",
        endDate: "2024-03-01T09:00:01Z",
        activityType: "car",
        samples: [{
          sampleId: "arc-car-start",
          timelineItemId: "arc-car",
          date: "2024-03-01T08:00:00Z",
          location: { timestamp: "2024-03-01T08:00:00Z", latitude: 1, longitude: 1 }
        }, {
          sampleId: "arc-car-end",
          timelineItemId: "arc-car",
          date: "2024-03-01T09:00:01Z",
          location: { timestamp: "2024-03-01T09:00:01Z", latitude: 1.01, longitude: 1.01 }
        }]
      }] }),
      text("moves.json", [{
        date: "20240301",
        segments: [{
          type: "move",
          startTime: "20240301T080000Z",
          endTime: "20240301T090000Z",
          activities: [{
            activity: "transport",
            startTime: "20240301T080000Z",
            endTime: "20240301T090000Z",
            trackPoints: [
              { time: "20240301T080000Z", lat: 1, lon: 1 },
              { time: "20240301T090000Z", lat: 1.01, lon: 1.01 }
            ]
          }]
        }]
      }])
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({
      end_ts: residualEnd,
      mode: "transit",
      provider: "moves_export"
    })]);
    expect(result.rows.raw_gps.map((row) => row.ts)).toContain(residualEnd);
  });

  test("preserves the non-overlapping tail of a supplemental Moves segment", async () => {
    const result = await convertImportEntries([
      text("full/storyline.json", [{
        date: "20240301",
        lastUpdate: "20240301T120000Z",
        segments: [{
          type: "move",
          startTime: "20240301T100000Z",
          endTime: "20240301T120000Z",
          activities: [{
            activity: "walking",
            startTime: "20240301T100000Z",
            endTime: "20240301T120000Z"
          }]
        }]
      }]),
      text("daily/storyline.json", [{
        date: "20240301",
        lastUpdate: "20240301T130000Z",
        segments: [{
          type: "place",
          startTime: "20240301T115000Z",
          endTime: "20240301T130000Z",
          place: {
            id: 1,
            name: "Home",
            type: "home",
            location: { lat: 1, lon: 1 }
          }
        }]
      }])
    ]);

    expect(result.rows.stays).toContainEqual(expect.objectContaining({
      end_ts: Date.parse("2024-03-01T13:00:00Z") / 1000
    }));
  });

  test("imports a Moves summary-only file without inventing timeline events", async () => {
    const result = await convertImportEntries([text("opaque/metrics.json", [{
      date: "20140402",
      summary: [{ activity: "walking", duration: 2990, distance: 3590, steps: 4164 }]
    }])]);

    expect(result.rows.raw_pedometer).toEqual([
      expect.objectContaining({ steps_delta: 4164, distance_m: 3590 })
    ]);
    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.moves).toHaveLength(0);
  });

  test("does not add a Moves daily summary on top of a cross-midnight activity", async () => {
    const result = await convertImportEntries([text("moves.json", [{
      date: "20140402",
      summary: [{ activity: "walking", steps: 100, distance: 80 }],
      segments: [{
        type: "move",
        startTime: "20140402T235000+0800",
        endTime: "20140403T001000+0800",
        activities: [{
          activity: "walking",
          startTime: "20140402T235000+0800",
          endTime: "20140403T001000+0800",
          steps: 100,
          distance: 80
        }]
      }]
    }])]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({
      steps_delta: 100,
      tz_offset_s: 28_800
    })]);
  });

  test("rejects a Moves summary whose calendar date does not exist", async () => {
    await expect(convertImportEntries([text("opaque/metrics.json", [{
      date: "20230229",
      summary: [{ activity: "walking", steps: 100, distance: 80 }]
    }])])).rejects.toThrow("invalid date");
  });

  test("recovers nested Moves activities, steps, and GPS from an activities-only file", async () => {
    const result = await convertImportEntries([text("unknown/layout/activities.json", [{
      date: "20140611",
      summary: [{ activity: "walking", duration: 60, distance: 80, steps: 100 }],
      segments: [{
        type: "place",
        startTime: "20140611T075200+0800",
        endTime: "20140611T135400+0800",
        activities: [{
          activity: "walking",
          manual: true,
          startTime: "20140611T075305+0800",
          endTime: "20140611T075405+0800",
          distance: 80,
          steps: 100,
          trackPoints: [
            { lat: 31.2, lon: 121.4, time: "20140611T075305+0800" },
            { lat: 31.2005, lon: 121.4005, time: "20140611T075405+0800" }
          ]
        }]
      }]
    }])]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "walk" })]);
    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 100 })]);
    expect(result.rows.raw_gps).toHaveLength(2);
    expect(result.rows.samples).toHaveLength(2);
  });

  test("links anonymous Arc item samples to its route using canonical time identity", async () => {
    const result = await convertImportEntries([text("anonymous.json", {
      timelineItems: [{
        isVisit: false,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00+00:00",
        activityType: "walking",
        samples: [
          { date: "2024-05-01T08:00:00Z", location: { latitude: 1, longitude: 1, timestamp: "2024-05-01T08:00:00Z" } },
          { date: "2024-05-01T09:00:00Z", location: { latitude: 1.01, longitude: 1.01, timestamp: "2024-05-01T09:00:00Z" } }
        ]
      }]
    })]);

    expect(result.rows.moves[0]?.distance_m).toBeGreaterThan(0);
    expect(result.rows.route_paths).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(2);
  });

  test("fuses Arc place aliases and updates place metadata by revision", async () => {
    const result = await convertImportEntries([
      text("backup/Place/p.json", {
        placeId: "p",
        name: "Old",
        center: { latitude: 31.2, longitude: 121.4 },
        lastSaved: "2024-01-01T00:00:00Z"
      }),
      text("export.json", {
        timelineItems: [{
          itemId: "visit",
          isVisit: true,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T09:00:00Z",
          lastSaved: "2024-05-02T00:00:00Z",
          center: { latitude: 31.2, longitude: 121.4 },
          place: {
            placeId: "p",
            mapboxPlaceId: "m",
            name: "Home",
            center: { latitude: 31.2, longitude: 121.4 }
          }
        }]
      })
    ]);

    expect(result.rows.pois).toEqual([
      expect.objectContaining({ name: "Home", first_seen_ts: Date.parse("2024-05-01T08:00:00Z") / 1000 })
    ]);
    expect(result.rows.stays[0]?.poi_id).toBe(result.rows.pois[0]?.id);
  });

  test("fuses a sparse Arc Place revision and records backup stay visit semantics", async () => {
    const result = await convertImportEntries([
      text("opaque/old-place.json", {
        placeId: "p",
        name: "Old",
        center: { latitude: 31.2, longitude: 121.4 },
        radius: { mean: 25 },
        lastSaved: "2024-01-01T00:00:00Z"
      }),
      text("opaque/new-place.json", {
        placeId: "p",
        name: "New",
        lastSaved: "2024-01-02T00:00:00Z"
      }),
      text("opaque/stay.json", {
        itemId: "stay",
        placeId: "p",
        isVisit: true,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z"
      })
    ]);

    const start = Date.parse("2024-05-01T08:00:00Z") / 1000;
    expect(result.rows.pois).toEqual([expect.objectContaining({
      name: "New",
      lat: 31.2,
      lon: 121.4,
      visitCount: 1,
      first_seen_ts: start,
      last_seen_ts: start
    })]);
    expect(result.rows.stays).toEqual([expect.objectContaining({ poi_id: result.rows.pois[0]!.id })]);
    expect(result.rows.raw_visits).toEqual([expect.objectContaining({ arrival_ts: start, horizontal_acc_m: 25 })]);
  });

  test("links a fused Arc export stay to Place metadata supplied by its backup item", async () => {
    const result = await convertImportEntries([
      text("Place/p.json", {
        placeId: "p",
        name: "Home",
        center: { latitude: 1, longitude: 1 }
      }),
      text("export.json", { timelineItems: [{
        itemId: "stay",
        isVisit: true,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z",
        center: { latitude: 1, longitude: 1 }
      }] }),
      text("TimelineItem/stay.json", {
        itemId: "stay",
        isVisit: true,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z",
        placeId: "p"
      })
    ]);

    expect(result.rows.stays).toEqual([expect.objectContaining({ poi_id: result.rows.pois[0]?.id })]);
    expect(result.rows.stay_pois).toHaveLength(1);
    expect(result.rows.pois).toEqual([expect.objectContaining({ visitCount: 1 })]);
  });

  test("does not double count duplicated Arc stay and move step claims", async () => {
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [
        {
          itemId: "stay",
          isVisit: true,
          startDate: "2024-09-19T00:25:00Z",
          endDate: "2024-09-19T00:28:00Z",
          center: { latitude: 1, longitude: 1 },
          stepCount: 354
        },
        {
          itemId: "move",
          isVisit: false,
          startDate: "2024-09-19T00:28:00Z",
          endDate: "2024-09-19T00:35:00Z",
          activityType: "walking",
          stepCount: 354
        }
      ]
    })]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 354 })]);
  });

  test("selects one canonical pedometer source for a mixed Arc and Moves day", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "arc-move",
        isVisit: false,
        startDate: "2014-04-02T00:30:00Z",
        endDate: "2014-04-02T00:40:00Z",
        activityType: "walking",
        stepCount: 500
      }] }),
      text("moves.json", [{
        date: "20140402",
        summary: [{ activity: "walking", steps: 500, distance: 400 }],
        segments: [{
          type: "move",
          startTime: "20140402T083000+0800",
          endTime: "20140402T084000+0800",
          activities: [{
            activity: "walking",
            startTime: "20140402T083000+0800",
            endTime: "20140402T084000+0800",
            steps: 500,
            distance: 400
          }]
        }]
      }])
    ]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 500, distance_m: 400 })]);
  });

  test("aligns Arc and Moves pedometer claims across a UTC day boundary", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "arc-move",
        isVisit: false,
        startDate: "2014-04-01T16:30:00Z",
        endDate: "2014-04-01T16:40:00Z",
        activityType: "walking",
        stepCount: 500
      }] }),
      text("moves.json", [{
        date: "20140402",
        summary: [{ activity: "walking", steps: 500 }],
        segments: [{
          type: "move",
          startTime: "20140402T003000+0800",
          endTime: "20140402T004000+0800",
          activities: [{
            activity: "walking",
            startTime: "20140402T003000+0800",
            endTime: "20140402T004000+0800",
            steps: 500
          }]
        }]
      }])
    ]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 500 })]);
  });

  test("normalizes stay POI links to the V12 primary key and one primary role", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "arc-stay",
        isVisit: true,
        startDate: "2014-04-02T08:00:00Z",
        endDate: "2014-04-02T10:00:00Z",
        center: { latitude: 31.2, longitude: 121.4 },
        place: { placeId: "p", name: "Arc Place", center: { latitude: 31.2, longitude: 121.4 } }
      }] }),
      text("moves.json", [{
        date: "20140402",
        segments: [{
          type: "place",
          startTime: "20140402T090000+0000",
          endTime: "20140402T100000+0000",
          place: { id: 2, name: "Moves Place", location: { lat: 31.2, lon: 121.4 } }
        }]
      }])
    ]);

    const identities = result.rows.stay_pois.map((row) => `${row.stay_id}:${row.poi_id}`);
    expect(new Set(identities).size).toBe(identities.length);
    for (const stay of result.rows.stays) {
      const links = result.rows.stay_pois.filter((row) => row.stay_id === stay.id);
      expect(links.filter((row) => row.role === "primary")).toHaveLength(stay.poi_id === null ? 0 : 1);
      expect(links.find((row) => row.role === "primary")?.poi_id ?? null).toBe(stay.poi_id);
    }
  });
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
  test("scans every Moves storyline level because aggregate files may contain unique dates", async () => {
    const reads: string[] = [];
    const storyline = [{
      date: "20140401",
      segments: [{
        type: "place",
        startTime: "20140401T080000+0000",
        endTime: "20140401T090000+0000",
        place: { id: 42, location: { lat: 60.1, lon: 24.1 } }
      }]
    }];
    const trackedHandle = (path: string, value: unknown): ImportFileHandle => {
      const data = new TextEncoder().encode(JSON.stringify(value));
      return {
        path,
        size: data.byteLength,
        readData: async () => {
          reads.push(path);
          return data;
        }
      };
    };

    const scan = await scanImportEntries([
      trackedHandle("moves_export/json/daily/storyline/storyline_20140401.json", storyline),
      trackedHandle("moves_export/json/full/storyline.json", storyline),
      trackedHandle("moves_export/json/daily/summary/summary_20140401.json", [{ date: "20140401" }])
    ]);

    expect(scan.sourceTypes).toEqual(["moves-export"]);
    expect(scan.supportedFileCount).toBe(2);
    expect(reads).toEqual(["moves_export/json/daily/summary/summary_20140401.json"]);
  });

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

  test("discovers supported history by content in arbitrary folders and filename casing", async () => {
    const scan = await scanImportEntries([
      handle("anything/nested/arc-history.JSON", {
        timelineItems: [
          { itemId: "arc-item-1", isVisit: false, startDate: "2024-05-01T08:00:00Z", endDate: "2024-05-01T09:00:00Z" }
        ]
      }),
      handle("other-layout/moves-data.json", [{
        date: "20140401",
        segments: [{
          type: "place",
          startTime: "20140401T080000+0000",
          endTime: "20140401T090000+0000",
          place: { id: 42, location: { lat: 60.1, lon: 24.1 } }
        }]
      }])
    ]);

    expect(scan.sourceTypes).toEqual(["arc-export", "moves-export"]);
    expect(scan.supportedFileCount).toBe(2);
    expect(scan.unknownFileCount).toBe(0);
  });

  test("discovers a single Moves day object in an arbitrary file", async () => {
    const entry = handle("opaque/history.JSON", {
      date: "20140401",
      segments: [{
        type: "place",
        startTime: "20140401T080000+0000",
        endTime: "20140401T090000+0000",
        place: { id: 42, location: { lat: 60.1, lon: 24.1 } }
      }]
    });

    const scan = await scanImportEntries([entry]);
    const result = await convertImportFileHandles([entry]);

    expect(scan.sourceTypes).toEqual(["moves-export"]);
    expect(result.rows.stays).toHaveLength(1);
  });

  test("discovers a segment-level Moves activity in an arbitrary file", async () => {
    const entry = handle("opaque/history.JSON", {
      date: "20140401",
      segments: [{
        type: "move",
        startTime: "20140401T080000+0000",
        endTime: "20140401T090000+0000",
        activity: "wlk",
        distance: 1_000
      }]
    });

    const result = await convertImportFileHandles([entry]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "walk", distance_m: 1_000 })]);
  });

  test("discovers anonymous Arc observations in an arbitrary file", async () => {
    const entry = handle("opaque/observations.JSON", [{
      date: "2021-03-15T10:00:00Z",
      coreMotionActivityType: "walking",
      location: {
        timestamp: "2021-03-15T10:00:00Z",
        latitude: -33.8688,
        longitude: 151.2093,
        horizontalAccuracy: 8
      }
    }]);

    const scan = await scanImportEntries([entry]);
    const result = await convertImportFileHandles([entry]);

    expect(scan.sourceTypes).toEqual(["arc-backup"]);
    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_walking: 1 })]);
  });

  test("reconstructs a stationary timeline from an Arc sample-only backup", async () => {
    const samples = [0, 60, 120].map((seconds) => {
      const date = new Date(Date.parse("2021-03-15T10:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `orphan-${seconds}`,
        date,
        movingState: "stationary",
        location: {
          timestamp: date,
          latitude: -33.8688 + seconds / 60_000_000,
          longitude: 151.2093 + seconds / 60_000_000,
          horizontalAccuracy: 8
        }
      };
    });

    const result = await convertImportEntries([text("opaque/samples.json", samples)]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.raw_gps).toHaveLength(3);
  });

  test("does not promote uniformly inaccurate stationary samples to a confident stay", async () => {
    const samples = [0, 60, 120].map((seconds) => {
      const date = new Date(Date.parse("2021-03-15T10:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `inaccurate-${seconds}`,
        date,
        movingState: "stationary",
        location: {
          timestamp: date,
          latitude: -33.8688,
          longitude: 151.2093,
          horizontalAccuracy: 500
        }
      };
    });

    const result = await convertImportEntries([text("opaque/samples.json", samples)]);

    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(3);
  });

  test("links a sample-reconstructed stay to one unambiguous Arc Place", async () => {
    const samples = [0, 60, 120].map((seconds) => {
      const date = new Date(Date.parse("2021-03-15T10:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `home-${seconds}`,
        date,
        movingState: "stationary",
        location: { timestamp: date, latitude: 1, longitude: 1, horizontalAccuracy: 8 }
      };
    });
    const result = await convertImportEntries([
      text("Place/home.json", { placeId: "home", name: "Home", center: { latitude: 1, longitude: 1 }, radius: { mean: 25 } }),
      text("samples.json", samples)
    ]);

    expect(result.rows.stays).toEqual([expect.objectContaining({ poi_id: result.rows.pois[0]?.id })]);
    expect(result.rows.stay_pois).toHaveLength(1);
    expect(result.rows.pois).toEqual([expect.objectContaining({ visitCount: 1 })]);
  });

  test("reconstructs a move from sample-only Arc geometry without activity labels", async () => {
    const samples = [0, 60, 120].map((seconds, index) => {
      const date = new Date(Date.parse("2021-03-15T10:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `moving-orphan-${seconds}`,
        date,
        location: {
          timestamp: date,
          latitude: -33.8688,
          longitude: 151.2093 + index * 0.015,
          horizontalAccuracy: 8
        }
      };
    });

    const result = await convertImportEntries([text("opaque/samples.json", samples)]);

    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.moves).toEqual([expect.objectContaining({ provider: "arc_reconstruction" })]);
    expect(result.rows.route_paths).toHaveLength(1);
  });

  test("keeps an implausible sample-only Arc jump as unknown raw evidence", async () => {
    const samples = [
      { sampleId: "jump-a", date: "2021-03-15T10:00:00Z", location: { timestamp: "2021-03-15T10:00:00Z", latitude: 0, longitude: 0 } },
      { sampleId: "jump-b", date: "2021-03-15T10:01:00Z", location: { timestamp: "2021-03-15T10:01:00Z", latitude: 50, longitude: 50 } }
    ];

    const result = await convertImportEntries([text("opaque/samples.json", samples)]);

    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.route_paths).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(2);
  });

  test("keeps raw evidence while bypassing one impossible point inside an Arc route", async () => {
    const samples = [
      ["2021-03-15T10:00:00Z", 0, 0],
      ["2021-03-15T10:01:00Z", 50, 50],
      ["2021-03-15T10:02:00Z", 0, 0.001],
      ["2021-03-15T10:03:00Z", 0, 0.002]
    ].map(([date, latitude, longitude], index) => ({
      sampleId: `route-spike-${index}`,
      date,
      movingState: "moving",
      location: { timestamp: date, latitude, longitude, horizontalAccuracy: 8 }
    }));
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [{
        itemId: "route-with-spike",
        isVisit: false,
        startDate: "2021-03-15T10:00:00Z",
        endDate: "2021-03-15T10:03:00Z",
        activityType: "walking",
        samples
      }]
    })]);

    expect(result.rows.raw_gps).toHaveLength(4);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({ sample_count: 3 })]);
    expect(result.rows.moves).toEqual([expect.objectContaining({ distance_m: expect.any(Number) })]);
    expect(result.rows.moves[0]!.distance_m!).toBeLessThan(500);
  });

  test("reconstructs a continuous 250 meter-per-second flight", async () => {
    const samples = [0, 60, 120].map((seconds, index) => {
      const date = new Date(Date.parse("2021-03-15T10:00:00Z") + seconds * 1_000).toISOString();
      return {
        sampleId: `flight-${index}`,
        date,
        movingState: "moving",
        location: { timestamp: date, latitude: 0, longitude: index * 0.135, horizontalAccuracy: 8 }
      };
    });

    const result = await convertImportEntries([text("LocomotionSample/flight.json", samples)]);

    expect(result.rows.raw_gps).toHaveLength(3);
    expect(result.rows.no_data_gaps).toHaveLength(0);
    expect(result.rows.moves).toEqual([expect.objectContaining({ provider: "arc_reconstruction" })]);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({ sample_count: 3 })]);
  });

  test("replaces a stationary-dominant low-confidence long Arc move with a gap", async () => {
    const start = Date.parse("2021-03-15T00:00:00Z");
    const samples = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start + index * 2 * 60 * 60 * 1_000).toISOString();
      return {
        sampleId: `stationary-drift-${index}`,
        date,
        coreMotionActivityType: index < 5 ? "stationary" : "walking",
        movingState: "uncertain",
        location: {
          timestamp: date,
          latitude: 1,
          longitude: 1 + index * 0.01,
          horizontalAccuracy: 2_000
        }
      };
    });
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [{
        itemId: "stationary-dominant-long-move",
        isVisit: false,
        startDate: "2021-03-15T00:00:00Z",
        endDate: "2021-03-15T12:00:00Z",
        activityType: "car",
        activityTypeConfidenceScore: 0,
        uncertainActivityType: true,
        unknownActivityType: true,
        samples
      }]
    })]);

    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.route_paths).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(7);
    expect(result.rows.raw_motion_activity).toHaveLength(7);
  });

  test("detects gzip content even when the filename has no gzip suffix", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      timelineItems: [{
        itemId: "move-1",
        isVisit: false,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z"
      }]
    }));
    const compressed = gzipSync(encoded);
    const entry: ImportFileHandle = {
      path: "unknown/history.json",
      size: compressed.byteLength,
      readData: async () => compressed
    };

    const scan = await scanImportEntries([entry]);
    const result = await convertImportFileHandles([entry]);

    expect(scan.sourceTypes).toEqual(["arc-export"]);
    expect(result.rows.moves).toHaveLength(1);
  });

  test("streams gzip history without requesting a full file buffer", async () => {
    const compressed = gzipSync(new TextEncoder().encode(JSON.stringify({
      timelineItems: [{
        itemId: "move-1",
        isVisit: false,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z"
      }]
    })));
    const entry: ImportFileHandle = {
      path: "unknown/history.json",
      size: compressed.byteLength,
      readData: async () => {
        throw new Error("full-buffer read must not be used");
      },
      readChunks: async function* () {
        for (let offset = 0; offset < compressed.length; offset += 1) {
          yield compressed.subarray(offset, offset + 1);
        }
      }
    };

    const result = await convertImportFileHandles([entry]);

    expect(result.rows.moves).toHaveLength(1);
  });

  test("rejects a gzip whose trailer CRC does not match its JSON", async () => {
    const compressed = gzipSync(new TextEncoder().encode(JSON.stringify([{
      date: "20140402",
      summary: [{ activity: "walking", steps: 100 }]
    }])));
    compressed[compressed.length - 8] ^= 0xff;

    const result = await convertImportEntries([
      { path: "random/damaged.json.gz", data: compressed },
      text("random/healthy.json", [{
        date: "20140403",
        summary: [{ activity: "walking", steps: 200 }]
      }])
    ]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 200 })]);
    expect(result.report.diagnostics.some((message) => message.includes("Gzip CRC"))).toBe(true);
  });

  test("recognizes only a root-level timelineItems key as an Arc export wrapper", async () => {
    const result = await convertImportEntries([
      text("opaque/item.json", {
        metadata: { timelineItems: [{ ignored: true }] },
        itemId: "stay-1",
        isVisit: true,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z",
        center: { latitude: 1, longitude: 1 }
      })
    ]);

    expect(result.rows.stays).toHaveLength(1);
  });

  test("streams an Arc wrapper whose timelineItems key follows large metadata", async () => {
    const result = await convertImportEntries([
      text("opaque/export.json", {
        metadata: "x".repeat(300_000),
        timelineItems: [{
          itemId: "move-1",
          isVisit: false,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T09:00:00Z"
        }]
      })
    ]);

    expect(result.rows.moves).toHaveLength(1);
  });

  test("discovers an Arc Place tombstone by content in an arbitrary folder", async () => {
    const scan = await scanImportEntries([
      handle("opaque/deleted-place.json", {
        placeId: "deleted-place",
        deleted: true,
        lastSaved: "2024-01-02T00:00:00Z"
      })
    ]);

    expect(scan.sourceTypes).toEqual(["arc-backup"]);
    expect(scan.supportedFileCount).toBe(1);
  });

  test("does not advertise Arc range summaries as convertible history", async () => {
    const summary = handle("opaque/coverage.json", {
      dateRange: { start: "2024-05-01T00:00:00Z", duration: 86_400 },
      itemsNeedingConfirmCount: 2
    });

    const scan = await scanImportEntries([summary]);

    expect(scan.sourceTypes).toEqual(["arc-backup"]);
    expect(scan.supportedFileCount).toBe(0);
    await expect(convertImportFileHandles([summary])).rejects.toThrow("contains no timeline records to convert");
  });
});

describe("convertImportEntries", () => {
  test("rejects an unreadable recognized history file", async () => {
    await expect(convertImportEntries([
      {
        path: "Export/JSON/Daily/2024-05-01.json",
        data: new TextEncoder().encode("not-json")
      }
    ])).rejects.toThrow("Export/JSON/Daily/2024-05-01.json");
  });

  test.each([
    ["Export/JSON/Daily/2024-05-01.json", { timelineItems: null }],
    ["Previous Backups ABC/LocomotionSample/2024-W18.json", { sampleId: "sample-1" }],
    ["moves_export/json/daily/storyline/storyline_20140401.json", [{ date: "20140401" }]]
  ])("rejects a recognized history file with an invalid shape: %s", async (path, value) => {
    await expect(convertImportEntries([text(path, value)])).rejects.toThrow(path);
  });

  test.each([
    ["Arc", text("arc.json", { timelineItems: [{ itemId: "bad", isVisit: false, startDate: "bad", endDate: "also-bad" }] })],
    ["Moves", text("moves.json", [{ date: "20140402", segments: [{ type: "move", startTime: "bad", endTime: "also-bad", activity: "walking" }] }])]
  ])("rejects %s input when every otherwise valid record has an invalid time window", async (_source, entry) => {
    await expect(convertImportEntries([entry])).rejects.toThrow("No convertible history records remained");
  });

  test("rejects an incomplete Arc backup when it is the only history item", async () => {
    await expect(convertImportEntries([
      text("Previous Backups ABC/TimelineItem/A/item.json", { itemId: "item-1", isVisit: true })
    ])).rejects.toThrow("Skipped backup timeline item with invalid time window");
  });

  test("isolates a damaged file when other usable history exists", async () => {
    const result = await convertImportEntries([
      {
        path: "random/damaged.json",
        data: new TextEncoder().encode("not-json")
      },
      text("random/healthy.json", {
        timelineItems: [{
          itemId: "move-1",
          isVisit: false,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T09:00:00Z",
          activityType: "walk"
        }]
      })
    ]);

    expect(result.rows.moves).toHaveLength(1);
    expect(result.report.diagnostics.some((message) => message.includes("random/damaged.json"))).toBe(true);
  });

  test("rolls back valid prefixes from a truncated history file", async () => {
    const truncated = '[{"date":"20140402","summary":[{"activity":"walking","steps":100}]},{"date":"20140403","segments":[';
    const result = await convertImportEntries([
      { path: "random/truncated.json", data: new TextEncoder().encode(truncated) },
      text("random/healthy.json", [{
        date: "20140404",
        summary: [{ activity: "walking", steps: 200 }]
      }])
    ]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ steps_delta: 200 })]);
    expect(result.report.diagnostics.some((message) => message.includes("random/truncated.json"))).toBe(true);
  });

  test("keeps healthy Arc items when another item in the same file is invalid", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [
          {
            itemId: "healthy",
            isVisit: false,
            startDate: "2024-05-01T08:00:00Z",
            endDate: "2024-05-01T09:00:00Z"
          },
          {
            itemId: "invalid",
            isVisit: false,
            startDate: "2024-05-01T09:00:00Z"
          }
        ]
      })
    ]);

    expect(result.rows.moves).toHaveLength(1);
    expect(result.report.diagnostics.some((message) => message.includes("missing isVisit, startDate, or endDate"))).toBe(true);
  });

  test("skips deleted Arc backup samples that no longer reference a timeline item", async () => {
    await expect(convertImportEntries([
      text("Previous Backups ABC/LocomotionSample/2020-W06.json", [{ sampleId: "sample-1", deleted: true }])
    ])).rejects.toThrow("No convertible history records remained");
  });

  test("honors a newer Arc timeline item tombstone", async () => {
    await expect(convertImportEntries([
      text("live.json", {
        timelineItems: [{
          itemId: "deleted-item",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          lastSaved: "2024-01-01T00:00:00Z"
        }]
      }),
      text("tombstone.json", {
        itemId: "deleted-item",
        deleted: true,
        lastSaved: "2024-01-02T00:00:00Z"
      })
    ])).rejects.toThrow("No convertible history records remained");
  });

  test("honors a newer Arc Place tombstone from an arbitrary folder", async () => {
    await expect(convertImportEntries([
      text("opaque/live-place.json", {
        placeId: "deleted-place",
        name: "Deleted Place",
        center: { latitude: 1, longitude: 1 },
        lastSaved: "2024-01-01T00:00:00Z"
      }),
      text("opaque/deleted-place.json", {
        placeId: "deleted-place",
        deleted: true,
        lastSaved: "2024-01-02T00:00:00Z"
      })
    ])).rejects.toThrow("No convertible history records remained");
  });

  test("honors a newer Arc sample tombstone", async () => {
    await expect(convertImportEntries([
      text("live.json", [{
        sampleId: "deleted-sample",
        date: "2021-03-15T08:00:00Z",
        lastSaved: "2024-01-01T00:00:00Z",
        location: {
          timestamp: "2021-03-15T08:00:00Z",
          latitude: 1,
          longitude: 1
        }
      }]),
      text("tombstone.json", [{
        sampleId: "deleted-sample",
        deleted: true,
        lastSaved: "2024-01-02T00:00:00Z"
      }])
    ])).rejects.toThrow("No convertible history records remained");
  });

  test("keeps a live Arc item saved after an older tombstone", async () => {
    const result = await convertImportEntries([
      text("tombstone.json", {
        itemId: "restored-item",
        deleted: true,
        lastSaved: "2024-01-01T00:00:00Z"
      }),
      text("live.json", {
        timelineItems: [{
          itemId: "restored-item",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          lastSaved: "2024-01-02T00:00:00Z"
        }]
      })
    ]);

    expect(result.rows.moves).toHaveLength(1);
  });

  test("keeps a newer manual Arc activity correction while supplementing its older samples", async () => {
    const samples = [0, 1].map((index) => ({
      sampleId: `sample-${index}`,
      date: `2021-03-15T08:0${index}:00Z`,
      location: {
        timestamp: `2021-03-15T08:0${index}:00Z`,
        latitude: 1 + index * 0.001,
        longitude: 1 + index * 0.001
      }
    }));
    const result = await convertImportEntries([
      text("old.json", {
        timelineItems: [{
          itemId: "corrected-item",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: "walking",
          manualActivityType: false,
          lastSaved: "2024-01-01T00:00:00Z",
          samples
        }]
      }),
      text("new.json", {
        timelineItems: [{
          itemId: "corrected-item",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: "car",
          manualActivityType: true,
          lastSaved: "2024-01-02T00:00:00Z"
        }]
      })
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "car" })]);
    expect(result.rows.raw_gps).toHaveLength(2);
  });

  test("honors explicit activity removal in a newer Arc timeline item revision", async () => {
    const samples = [0, 1].map((index) => ({
      sampleId: `stationary-${index}`,
      date: `2021-03-15T08:0${index}:00Z`,
      movingState: "stationary",
      location: {
        timestamp: `2021-03-15T08:0${index}:00Z`,
        latitude: 1,
        longitude: 1
      }
    }));
    const result = await convertImportEntries([
      text("old.json", {
        timelineItems: [{
          itemId: "cleared-activity",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: "walking",
          confirmedType: "walking",
          manualActivityType: true,
          lastSaved: "2024-01-01T00:00:00Z",
          samples
        }]
      }),
      text("new.json", {
        timelineItems: [{
          itemId: "cleared-activity",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: null,
          confirmedType: null,
          manualActivityType: null,
          unknownActivityType: true,
          lastSaved: "2024-01-02T00:00:00Z"
        }]
      })
    ]);

    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(2);
  });

  test("honors explicit low-confidence flag removal in a newer Arc timeline item revision", async () => {
    const result = await convertImportEntries([
      text("old.json", {
        timelineItems: [{
          itemId: "cleared-confidence-flags",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: "walking",
          activityTypeConfidenceScore: 0,
          uncertainActivityType: true,
          unknownActivityType: true,
          lastSaved: "2024-01-01T00:00:00Z"
        }]
      }),
      text("new.json", {
        timelineItems: [{
          itemId: "cleared-confidence-flags",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: "walking",
          activityTypeConfidenceScore: null,
          uncertainActivityType: null,
          unknownActivityType: null,
          lastSaved: "2024-01-02T00:00:00Z"
        }]
      })
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "walk" })]);
    expect(result.rows.no_data_gaps).toHaveLength(0);
  });

  test("moves revised Arc samples to the newer live timeline item", async () => {
    const samples = (timelineItemId: string, lastSaved: string) => [0, 1].map((index) => ({
      sampleId: `relinked-${index}`,
      timelineItemId,
      lastSaved,
      date: `2021-03-15T08:0${index}:00Z`,
      location: {
        timestamp: `2021-03-15T08:0${index}:00Z`,
        latitude: 1 + index * 0.01,
        longitude: 1 + index * 0.01
      }
    }));
    const result = await convertImportEntries([
      text("old.json", { timelineItems: [{
        itemId: "a-old",
        isVisit: false,
        startDate: "2021-03-15T08:00:00Z",
        endDate: "2021-03-15T09:00:00Z",
        lastSaved: "2024-01-01T00:00:00Z",
        samples: samples("a-old", "2024-01-01T00:00:00Z")
      }] }),
      text("old-tombstone.json", {
        itemId: "a-old",
        deleted: true,
        lastSaved: "2024-01-03T00:00:00Z"
      }),
      text("new.json", { timelineItems: [{
        itemId: "z-new",
        isVisit: false,
        startDate: "2021-03-15T08:00:00Z",
        endDate: "2021-03-15T09:00:00Z",
        lastSaved: "2024-01-04T00:00:00Z",
        samples: samples("z-new", "2024-01-04T00:00:00Z")
      }] })
    ]);

    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.moves[0]?.distance_m).toBeGreaterThan(0);
    expect(result.rows.route_paths).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(2);
  });

  test("uses the newer Arc sample payload when evidence quality is equal", async () => {
    const sample = (lastSaved: string, latitude: number, activity: string) => ({
      sampleId: "revised-sample",
      lastSaved,
      date: "2021-03-15T08:00:00Z",
      confirmedType: activity,
      location: {
        timestamp: "2021-03-15T08:00:00Z",
        latitude,
        longitude: 1,
        horizontalAccuracy: 5
      }
    });
    const result = await convertImportEntries([
      text("old.json", sample("2024-01-01T00:00:00Z", 9, "walking")),
      text("new.json", sample("2024-01-02T00:00:00Z", 1, "running"))
    ]);

    expect(result.rows.raw_gps).toEqual([expect.objectContaining({ lat: 1, lon: 1 })]);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_running: 1, confidence: 2 })]);
  });

  test("resolves Arc sample fields independently of sparse revision file order", async () => {
    const sample = (lastSaved: string, activity?: string) => ({
      sampleId: "revised-sample",
      lastSaved,
      date: "2021-03-15T08:00:00Z",
      confirmedType: activity,
      location: {
        timestamp: "2021-03-15T08:00:00Z",
        latitude: 1,
        longitude: 1,
        horizontalAccuracy: 5
      }
    });
    const revisions = {
      old: sample("2024-01-01T00:00:00Z", "walking"),
      current: sample("2024-01-02T00:00:00Z", "running"),
      sparse: { sampleId: "revised-sample", lastSaved: "2024-01-03T00:00:00Z", date: "2021-03-15T08:00:00Z" }
    };
    const convert = (paths: Array<keyof typeof revisions>) => convertImportEntries(paths.map((revision, index) => text(`${index}-${revision}.json`, revisions[revision])));

    const first = await convert(["old", "sparse", "current"]);
    const second = await convert(["old", "current", "sparse"]);

    expect(first.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_running: 1 })]);
    expect(second.rows.raw_motion_activity).toEqual(first.rows.raw_motion_activity);
  });

  test("deduplicates identified and anonymous copies of the same Arc observation", async () => {
    const observation = {
      date: "2021-03-15T08:00:00Z",
      movingState: "stationary",
      location: {
        timestamp: "2021-03-15T08:00:00Z",
        latitude: 1,
        longitude: 1,
        horizontalAccuracy: 5
      }
    };
    const result = await convertImportEntries([
      text("anonymous.json", observation),
      text("identified.json", { ...observation, sampleId: "sample-1" })
    ]);

    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.samples).toHaveLength(1);
  });

  test("merges complementary anonymous evidence into an identified Arc observation", async () => {
    const location = {
      timestamp: "2021-03-15T08:00:00Z",
      latitude: 1,
      longitude: 1,
      horizontalAccuracy: 5
    };
    const result = await convertImportEntries([
      text("anonymous.json", { date: "2021-03-15T08:00:00Z", movingState: "stationary", location }),
      text("identified.json", { sampleId: "sample-1", date: "2021-03-15T08:00:00Z", location })
    ]);

    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.samples).toHaveLength(1);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_stationary: 1 })]);
  });

  test("materializes shared identified boundary samples once without losing either route", async () => {
    const sharedLocation = {
      timestamp: "2021-03-15T09:00:00Z",
      latitude: 1.01,
      longitude: 1.01,
      horizontalAccuracy: 5
    };
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [{
        itemId: "first",
        isVisit: false,
        startDate: "2021-03-15T08:00:00Z",
        endDate: "2021-03-15T09:00:00Z",
        activityType: "walking",
        samples: [{
          sampleId: "first-start",
          date: "2021-03-15T08:00:00Z",
          location: { timestamp: "2021-03-15T08:00:00Z", latitude: 1, longitude: 1 }
        }, {
          sampleId: "first-boundary",
          date: "2021-03-15T09:00:00Z",
          location: sharedLocation
        }]
      }, {
        itemId: "second",
        isVisit: false,
        startDate: "2021-03-15T09:00:00Z",
        endDate: "2021-03-15T10:00:00Z",
        activityType: "walking",
        samples: [{
          sampleId: "second-boundary",
          date: "2021-03-15T09:00:00Z",
          confirmedType: "walking",
          location: sharedLocation
        }, {
          sampleId: "second-end",
          date: "2021-03-15T10:00:00Z",
          location: { timestamp: "2021-03-15T10:00:00Z", latitude: 1.02, longitude: 1.02 }
        }]
      }]
    })]);

    expect(result.rows.raw_gps).toHaveLength(3);
    expect(result.rows.samples).toHaveLength(3);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_walking: 1 })]);
    expect(result.rows.route_paths).toHaveLength(2);
    expect(result.rows.route_paths.every((route) => route.sample_count === 2)).toBe(true);
  });

  test("maps Arc activity evidence strength without manufacturing high confidence", async () => {
    const result = await convertImportEntries([
      text("observations.json", [
        { sampleId: "confirmed", date: "2021-03-15T08:00:00Z", confirmedType: "walking" },
        { sampleId: "motion", date: "2021-03-15T08:01:00Z", coreMotionActivityType: "walking" },
        { sampleId: "state", date: "2021-03-15T08:02:00Z", movingState: "stationary" }
      ])
    ]);

    expect(result.rows.raw_motion_activity.map((row) => row.confidence)).toEqual([2, 1, 0]);
  });

  test("infers an Arc move mode from the dominant strongest sample evidence", async () => {
    const samples = ["walking", "automotive", "automotive", "automotive"].map((activity, index) => ({
      sampleId: `sample-${index}`,
      date: `2021-03-15T08:0${index}:00Z`,
      coreMotionActivityType: activity,
      location: {
        timestamp: `2021-03-15T08:0${index}:00Z`,
        latitude: 1 + index * 0.001,
        longitude: 1 + index * 0.001
      }
    }));
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [{
        itemId: "move-1",
        isVisit: false,
        startDate: "2021-03-15T08:00:00Z",
        endDate: "2021-03-15T08:04:00Z",
        samples
      }]
    })]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "car" })]);
  });

  test("preserves Arc motion evidence that has no GPS coordinate", async () => {
    const result = await convertImportEntries([
      text("Previous Backups ABC/LocomotionSample/2020-W06.json", [{
        sampleId: "sample-1",
        timelineItemId: "move-1",
        date: "2020-02-03T10:00:00Z",
        coreMotionActivityType: "walking",
        secondsFromGMT: 3600
      }])
    ]);

    expect(result.rows.raw_gps).toHaveLength(0);
    expect(result.rows.samples).toHaveLength(0);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({
      is_walking: 1,
      tz_offset_s: 3600
    })]);
  });

  test("converts a Moves tracking-off segment into a no-data gap", async () => {
    const result = await convertImportEntries([
      text("moves_export/json/daily/storyline/storyline_20151226.json", [{
        date: "20151226",
        segments: [{
          type: "off",
          startTime: "20151226T131624+0800",
          endTime: "20151226T134553+0800"
        }]
      }])
    ]);

    expect(result.rows.no_data_gaps).toEqual([expect.objectContaining({
      reason: "Unknown",
      notes: "moves_tracking_off"
    })]);
  });

  test("merges consecutive Moves tracking-off segments across an unclassified interval", async () => {
    const result = await convertImportEntries([
      text("moves_export/json/daily/storyline/storyline_20151226.json", [{
        date: "20151226",
        segments: [
          {
            type: "off",
            startTime: "20151226T130000+0800",
            endTime: "20151226T131000+0800"
          },
          {
            type: "off",
            startTime: "20151226T132000+0800",
            endTime: "20151226T133000+0800"
          }
        ]
      }])
    ]);

    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.no_data_gaps[0]!.end_ts! - result.rows.no_data_gaps[0]!.start_ts).toBe(30 * 60);
  });

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

  test("fuses complementary Arc item and sample fields across arbitrary source files", async () => {
    const sharedSample = {
      sampleId: "sample-1",
      timelineItemId: "stay-1",
      date: "2021-03-15T10:00:00Z",
      location: {
        timestamp: "2021-03-15T10:00:00Z",
        latitude: -33.8688,
        longitude: 151.2093,
        horizontalAccuracy: 8
      }
    };
    const result = await convertImportEntries([
      text("opaque/source-a.json", {
        timelineItems: [{
          itemId: "stay-1",
          isVisit: true,
          startDate: "2021-03-15T09:00:00Z",
          endDate: "2021-03-15T11:00:00Z",
          place: {
            placeId: "place-1",
            name: "Complete Place",
            location: { latitude: -33.8688, longitude: 151.2093 }
          }
        }]
      }),
      text("opaque/source-b.json", {
        timelineItems: [{
          itemId: "stay-1",
          isVisit: true,
          startDate: "2021-03-15T09:00:00Z",
          endDate: "2021-03-15T11:00:00Z",
          samples: [sharedSample]
        }]
      }),
      text("opaque/source-c.json", [{
        ...sharedSample,
        coreMotionActivityType: "stationary"
      }])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.pois).toEqual([expect.objectContaining({ name: "Complete Place" })]);
    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_stationary: 1 })]);
  });

  test("uses all Arc item observations for pedometer distance", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [{
          itemId: "move-1",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T09:00:00Z",
          activityType: "walking",
          stepCount: 100,
          samples: [
            {
              sampleId: "sample-1",
              date: "2021-03-15T08:00:00Z",
              location: { timestamp: "2021-03-15T08:00:00Z", latitude: 1, longitude: 1 }
            },
            {
              sampleId: "sample-2",
              date: "2021-03-15T09:00:00Z",
              location: { timestamp: "2021-03-15T09:00:00Z", latitude: 1.001, longitude: 1.001 }
            }
          ]
        }]
      })
    ]);

    expect(result.rows.raw_pedometer).toEqual([expect.objectContaining({ distance_m: expect.any(Number) })]);
    expect(result.rows.raw_pedometer[0]!.distance_m).toBeGreaterThan(0);
  });

  test("does not use non-pedestrian route distance as pedometer distance", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [{
          itemId: "flight-1",
          isVisit: false,
          startDate: "2024-06-29T04:35:48Z",
          endDate: "2024-06-29T06:59:34Z",
          activityType: "airplane",
          stepCount: 33,
          samples: [
            {
              sampleId: "departure",
              date: "2024-06-29T04:35:48Z",
              location: { timestamp: "2024-06-29T04:35:48Z", latitude: 31.23, longitude: 121.47 }
            },
            {
              sampleId: "arrival",
              date: "2024-06-29T06:59:34Z",
              location: { timestamp: "2024-06-29T06:59:34Z", latitude: 35, longitude: 140 }
            }
          ]
        }]
      })
    ]);

    expect(result.rows.moves[0]?.distance_m).toBeGreaterThan(1_000_000);
    expect(result.rows.raw_pedometer).toEqual([
      expect.objectContaining({ steps_delta: 33, distance_m: null })
    ]);
  });

  test("keeps Arc steps while rejecting an implausible pedestrian distance", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "misclassified-transport",
        isVisit: false,
        startDate: "2019-09-08T08:00:00Z",
        endDate: "2019-09-08T09:00:00Z",
        activityType: "walking",
        stepCount: 514,
        samples: [
          { date: "2019-09-08T08:00:00Z", location: { timestamp: "2019-09-08T08:00:00Z", latitude: 31.2, longitude: 120.3 } },
          { date: "2019-09-08T09:00:00Z", location: { timestamp: "2019-09-08T09:00:00Z", latitude: 31.2, longitude: 121.45 } }
        ]
      }] })
    ]);

    expect(result.rows.raw_pedometer).toEqual([
      expect.objectContaining({ steps_delta: 514, distance_m: null })
    ]);
  });

  test("prefers a matched pre-shutdown Moves pedometer distance", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "moves-imported-walk",
        isVisit: false,
        startDate: "2014-09-08T08:00:00Z",
        endDate: "2014-09-08T09:00:00Z",
        activityType: "walking",
        stepCount: 514,
        samples: [
          { date: "2014-09-08T08:00:00Z", location: { timestamp: "2014-09-08T08:00:00Z", latitude: 31.2, longitude: 120.3 } },
          { date: "2014-09-08T09:00:00Z", location: { timestamp: "2014-09-08T09:00:00Z", latitude: 31.2, longitude: 121.45 } }
        ]
      }] }),
      text("moves.json", [{
        date: "20140908",
        segments: [{
          type: "move",
          startTime: "20140908T085400+0000",
          endTime: "20140908T090000+0000",
          activities: [{
            activity: "walking",
            startTime: "20140908T085400+0000",
            endTime: "20140908T090000+0000",
            steps: 514,
            distance: 281
          }]
        }]
      }])
    ]);

    expect(result.rows.raw_pedometer).toEqual([
      expect.objectContaining({ steps_delta: 514, distance_m: 281 })
    ]);
  });

  test("produces the same fused result regardless of paths and file order", async () => {
    const placeEvidence = {
      timelineItems: [{
        itemId: "stay-1",
        isVisit: true,
        startDate: "2021-03-15T09:00:00Z",
        endDate: "2021-03-15T11:00:00Z",
        place: {
          placeId: "place-1",
          name: "Stable Place",
          location: { latitude: -33.8688, longitude: 151.2093 }
        }
      }]
    };
    const sampleEvidence = {
      timelineItems: [{
        itemId: "stay-1",
        isVisit: true,
        startDate: "2021-03-15T09:00:00Z",
        endDate: "2021-03-15T11:00:00Z",
        samples: [{
          sampleId: "sample-1",
          date: "2021-03-15T10:00:00Z",
          latitude: -33.8688,
          longitude: 151.2093,
          coreMotionActivityType: "stationary"
        }]
      }]
    };
    const first = await convertImportEntries([
      text("alpha/one.json", placeEvidence),
      text("zeta/two.json", sampleEvidence)
    ]);
    const second = await convertImportEntries([
      text("zeta/two.json", placeEvidence),
      text("alpha/one.json", sampleEvidence)
    ]);
    const summary = (result: Awaited<ReturnType<typeof convertImportEntries>>) => ({
      pois: result.rows.pois.map((poi) => [poi.name, poi.lat, poi.lon]),
      stays: result.rows.stays.map((stay) => [stay.start_ts, stay.end_ts, stay.centroid_lat, stay.centroid_lon]),
      rawGPS: result.rows.raw_gps.map((row) => [row.ts, row.lat, row.lon]),
      motion: result.rows.raw_motion_activity.map((row) => [row.ts, row.is_stationary])
    });

    expect(summary(first)).toEqual(summary(second));
  });

  test("deduplicates Arc samples without sample identifiers by observation content", async () => {
    const sample = {
      timelineItemId: "move-1",
      date: "2021-03-15T10:00:00Z",
      location: {
        timestamp: "2021-03-15T10:00:00Z",
        latitude: -33.8688,
        longitude: 151.2093,
        horizontalAccuracy: 8
      }
    };
    const result = await convertImportEntries([
      text("Backup A/LocomotionSample/2021-W11.json", [sample]),
      text("Backup B/LocomotionSample/2021-W11.json", [{ ...sample, coreMotionActivityType: "walking" }])
    ]);

    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.raw_motion_activity).toEqual([expect.objectContaining({ is_walking: 1 })]);
  });

  test("keeps the timestamp paired with the preferred location for conflicting sample versions", async () => {
    const result = await convertImportEntries([
      text("one.json", [{
        sampleId: "sample-1",
        timelineItemId: "move-1",
        date: "2021-03-15T08:00:00Z",
        location: {
          timestamp: "2021-03-15T08:00:00Z",
          latitude: 1,
          longitude: 1,
          horizontalAccuracy: 300
        }
      }]),
      text("two.json", [{
        sampleId: "sample-1",
        timelineItemId: "move-1",
        date: "2021-03-15T09:00:00Z",
        location: {
          timestamp: "2021-03-15T09:00:00Z",
          latitude: 2,
          longitude: 2,
          horizontalAccuracy: 5
        }
      }])
    ]);

    expect(result.rows.raw_gps).toEqual([expect.objectContaining({
      ts: Date.parse("2021-03-15T09:00:00Z") / 1000,
      lat: 2,
      lon: 2
    })]);
  });

  test("drops observation fields outside V12 value ranges", async () => {
    const result = await convertImportEntries([
      text("observations.json", [{
        sampleId: "sample-1",
        date: "2021-03-15T09:00:00Z",
        secondsFromGMT: 999999,
        location: {
          timestamp: "2021-03-15T09:00:00Z",
          latitude: 2,
          longitude: 2,
          horizontalAccuracy: 5,
          courseAccuracy: 999
        }
      }])
    ]);

    expect(result.rows.raw_gps).toEqual([expect.objectContaining({
      tz_offset_s: null,
      course_acc_deg: null
    })]);
  });

  test("selects the most complete Moves day when duplicate evidence has arbitrary paths", async () => {
    const place = (id: number, startTime: string, endTime: string, lat: number) => ({
      type: "place",
      startTime,
      endTime,
      place: { id, location: { lat, lon: 151.2 } }
    });
    const partialDay = [{
      date: "20140401",
      segments: [place(1, "20140401T080000+0000", "20140401T090000+0000", -33.86)]
    }];
    const completeDay = [{
      date: "20140401",
      segments: [
        place(1, "20140401T080000+0000", "20140401T090000+0000", -33.86),
        {
          type: "move",
          startTime: "20140401T090000+0000",
          endTime: "20140401T093000+0000",
          activities: [{ activity: "wlk", startTime: "20140401T090000+0000", endTime: "20140401T093000+0000" }]
        },
        place(2, "20140401T093000+0000", "20140401T110000+0000", -33.87)
      ]
    }];

    const result = await convertImportEntries([
      text("unknown/a-partial.json", partialDay),
      text("unknown/z-complete.json", completeDay)
    ]);

    expect(result.rows.stays).toHaveLength(2);
    expect(result.rows.moves).toHaveLength(1);
  });

  test("prefers a healthy Moves day over a larger fragmented candidate", async () => {
    const healthy = [{
      date: "20140401",
      segments: [
        {
          type: "place",
          startTime: "20140401T080000+0000",
          endTime: "20140401T090000+0000",
          place: { id: 1, location: { lat: 60.1, lon: 24.1 } }
        },
        {
          type: "move",
          startTime: "20140401T090000+0000",
          endTime: "20140401T093000+0000",
          activities: [{ activity: "wlk", startTime: "20140401T090000+0000", endTime: "20140401T093000+0000" }]
        },
        {
          type: "place",
          startTime: "20140401T093000+0000",
          endTime: "20140401T110000+0000",
          place: { id: 2, location: { lat: 60.2, lon: 24.2 } }
        }
      ]
    }];
    const fragmented = [{
      date: "20140401",
      segments: Array.from({ length: 120 }, (_, index) => {
        const start = new Date(Date.UTC(2014, 3, 1, 8, 0, index)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
        const end = new Date(Date.UTC(2014, 3, 1, 8, 0, index + 1)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
        return { type: "off", startTime: start, endTime: end };
      })
    }];

    const result = await convertImportEntries([
      text("unknown/healthy.json", healthy),
      text("unknown/fragmented.json", fragmented)
    ]);

    expect(result.rows.stays).toHaveLength(2);
    expect(result.rows.moves).toHaveLength(1);
  });

  test("collapses a single dense Moves fragment source into an unknown range", async () => {
    const segments = Array.from({ length: 120 }, (_, index) => {
      const start = new Date(Date.UTC(2014, 3, 1, 8, 0, index)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
      const end = new Date(Date.UTC(2014, 3, 1, 8, 0, index + 1)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
      return index % 2 === 0
        ? { type: "place", startTime: start, endTime: end, place: { id: index, location: { lat: 1, lon: 1 } } }
        : { type: "move", startTime: start, endTime: end, activity: "walking" };
    });

    const result = await convertImportEntries([text("moves.json", [{ date: "20140401", segments }])]);

    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.report.diagnostics).toContain("Collapsed dense short-duration Moves fragments into unknown timeline ranges");
  });

  test("preserves raw GPS and steps when dense Moves semantics are collapsed", async () => {
    const segments = Array.from({ length: 20 }, (_, index) => {
      const start = new Date(Date.UTC(2014, 3, 1, 8, 0, index)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
      const end = new Date(Date.UTC(2014, 3, 1, 8, 0, index + 1)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
      return {
        type: "move",
        startTime: start,
        endTime: end,
        activities: [{
          activity: "walking",
          startTime: start,
          endTime: end,
          steps: 1,
          trackPoints: [{ lat: 1, lon: 1 + index / 10_000, time: start }]
        }]
      };
    });

    const result = await convertImportEntries([text("moves.json", [{ date: "20140401", segments }])]);

    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(20);
    expect(result.rows.raw_pedometer.reduce((sum, row) => sum + (row.steps_delta ?? 0), 0)).toBe(20);
  });

  test("collapses a dense zero-duration Moves source into one unknown range", async () => {
    const segments = Array.from({ length: 20 }, (_, index) => {
      const time = new Date(Date.UTC(2014, 3, 1, 8, index)).toISOString().replace(/[-:]/g, "").replace(".000Z", "+0000");
      return { type: index % 2 === 0 ? "move" : "off", startTime: time, endTime: time, activity: "walking" };
    });

    const result = await convertImportEntries([text("moves.json", [{ date: "20140401", segments }])]);

    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.no_data_gaps[0]!.end_ts! - result.rows.no_data_gaps[0]!.start_ts).toBe(19 * 60);
  });

  test.each([99, 120])("reconstructs a fragmented stationary Arc window from %i item claims", async (itemCount) => {
    const start = Date.parse("2021-03-15T00:00:00Z");
    const timelineItems = Array.from({ length: itemCount }, (_, index) => {
      const date = new Date(start + index * 60_000).toISOString();
      return {
        itemId: `fragment-${index}`,
        isVisit: index % 2 === 0,
        startDate: date,
        endDate: date,
        samples: [{
          sampleId: `sample-${index}`,
          timelineItemId: `fragment-${index}`,
          date,
          secondsFromGMT: 0,
          movingState: "stationary",
          location: {
            timestamp: date,
            latitude: -33.8688 + (index % 3) * 0.00001,
            longitude: 151.2093 + (index % 3) * 0.00001,
            horizontalAccuracy: 12
          }
        }]
      };
    });

    const result = await convertImportEntries([
      text("unrecognised-layout/history.json", { timelineItems })
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(0);
    expect(result.rows.stays[0]!.end_ts! - result.rows.stays[0]!.start_ts).toBeGreaterThan(60 * 60);
    expect(result.report.diagnostics).toContain("Reconstructed fragmented Arc window from stationary samples");
  });

  test("reconstructs dense positive one-second Arc fragments instead of emitting zero-minute events", async () => {
    const start = Date.parse("2021-03-15T00:00:00Z");
    const timelineItems = Array.from({ length: 120 }, (_, index) => {
      const startDate = new Date(start + index * 1_000).toISOString();
      const endDate = new Date(start + (index + 1) * 1_000).toISOString();
      return {
        itemId: `short-${index}`,
        isVisit: index % 2 === 0,
        startDate,
        endDate,
        center: index % 2 === 0 ? { latitude: -33.8688, longitude: 151.2093 } : undefined,
        samples: [{
          sampleId: `short-sample-${index}`,
          timelineItemId: `short-${index}`,
          date: startDate,
          movingState: "stationary",
          location: {
            timestamp: startDate,
            latitude: -33.8688,
            longitude: 151.2093,
            horizontalAccuracy: 12
          }
        }]
      };
    });

    const result = await convertImportEntries([text("arc.json", { timelineItems })]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.no_data_gaps).toHaveLength(0);
    expect(result.rows.stays[0]!.end_ts! - result.rows.stays[0]!.start_ts).toBe(120);
  });

  test("keeps positive and manual Arc anchors when zero-duration neighbors are fragmented", async () => {
    const result = await convertImportEntries([text("arc.json", {
      timelineItems: [
        { itemId: "stay-a", isVisit: true, startDate: "2021-03-15T08:00:00Z", endDate: "2021-03-15T08:02:00Z", center: { latitude: 1, longitude: 1 } },
        { itemId: "zero-a", isVisit: false, startDate: "2021-03-15T08:01:00Z", endDate: "2021-03-15T08:01:00Z" },
        { itemId: "manual", isVisit: false, manualActivityType: true, activityType: "walking", startDate: "2021-03-15T08:02:00Z", endDate: "2021-03-15T08:04:00Z" },
        { itemId: "zero-b", isVisit: true, startDate: "2021-03-15T08:03:00Z", endDate: "2021-03-15T08:03:00Z" },
        { itemId: "stay-b", isVisit: true, startDate: "2021-03-15T08:04:00Z", endDate: "2021-03-15T08:06:00Z", center: { latitude: 1.01, longitude: 1.01 } }
      ]
    })]);

    expect(result.rows.stays).toHaveLength(2);
    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "walk" })]);
  });

  test("does not duplicate Arc samples present in both export and backup", async () => {
    const sample = {
      sampleId: "sample-1",
      timelineItemId: "move-1",
      date: "2021-03-15T10:00:00Z",
      location: {
        timestamp: "2021-03-15T10:00:00Z",
        latitude: -33.8688,
        longitude: 151.2093,
        horizontalAccuracy: 8
      }
    };
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2021-03-15.json", {
        timelineItems: [
          {
            itemId: "move-1",
            isVisit: false,
            startDate: "2021-03-15T10:00:00Z",
            endDate: "2021-03-15T10:20:00Z",
            activityType: "walk",
            samples: [sample]
          }
        ]
      }),
      text("Previous Backups ABC/LocomotionSample/2021-W11.json", [sample])
    ]);

    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.samples).toHaveLength(1);
  });

  test("keeps backup-only Arc samples when an export item has partial sample history", async () => {
    const shared = {
      sampleId: "sample-1",
      timelineItemId: "move-1",
      date: "2021-03-15T10:00:00Z",
      latitude: -33.8688,
      longitude: 151.2093
    };
    const backupOnly = {
      sampleId: "sample-2",
      timelineItemId: "move-1",
      date: "2021-03-15T10:10:00Z",
      latitude: -33.8698,
      longitude: 151.2103
    };
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2021-03-15.json", {
        timelineItems: [{
          itemId: "move-1",
          isVisit: false,
          startDate: "2021-03-15T10:00:00Z",
          endDate: "2021-03-15T10:20:00Z",
          activityType: "walk",
          samples: [shared]
        }]
      }),
      text("Previous Backups ABC/LocomotionSample/2021-W11.json", [shared, backupOnly])
    ]);

    expect(result.rows.raw_gps).toHaveLength(2);
    expect(result.rows.samples).toHaveLength(2);
  });

  test("deduplicates repeated sample identifiers inside an Arc timeline item", async () => {
    const sample = {
      sampleId: "sample-1",
      timelineItemId: "move-1",
      date: "2021-03-15T10:00:00Z",
      latitude: -33.8688,
      longitude: 151.2093
    };
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2021-03-15.json", {
        timelineItems: [
          {
            itemId: "move-1",
            isVisit: false,
            startDate: "2021-03-15T10:00:00Z",
            endDate: "2021-03-15T10:20:00Z",
            activityType: "walk",
            samples: [sample, sample]
          }
        ]
      })
    ]);

    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.rows.samples).toHaveLength(1);
  });

  test("selects one richest Arc item when an export file repeats the same itemId", async () => {
    const baseItem = {
      itemId: "move-1",
      isVisit: false,
      startDate: "2021-03-15T10:00:00Z",
      endDate: "2021-03-15T10:20:00Z",
      activityType: "walk"
    };
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2021-03-15.json", {
        timelineItems: [
          {
            ...baseItem,
            samples: [{ sampleId: "sample-1", date: "2021-03-15T10:00:00Z", latitude: -33.86, longitude: 151.20 }]
          },
          {
            ...baseItem,
            samples: [
              { sampleId: "sample-1", date: "2021-03-15T10:00:00Z", latitude: -33.86, longitude: 151.20 },
              { sampleId: "sample-2", date: "2021-03-15T10:10:00Z", latitude: -33.87, longitude: 151.21 }
            ]
          }
        ]
      })
    ]);

    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.raw_gps).toHaveLength(2);
    expect(result.rows.samples).toHaveLength(2);
  });

  test("drops a zero-duration Arc event while preserving its raw sample evidence", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2018-07-08.json", {
        timelineItems: [{
          itemId: "zero-move",
          isVisit: false,
          startDate: "2018-07-08T04:29:26Z",
          endDate: "2018-07-08T04:29:26Z",
          activityType: "walk",
          samples: [{
            sampleId: "zero-move-sample",
            date: "2018-07-08T04:29:26Z",
            latitude: 31.2,
            longitude: 121.4
          }]
        }]
      })
    ]);

    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.raw_gps).toHaveLength(1);
    expect(result.report.diagnostics).toContain("Skipped non-positive-duration Arc move");
  });

  test("does not duplicate Arc pedometer evidence present in export and backup", async () => {
    const timelineItem = {
      itemId: "move-1",
      isVisit: false,
      startDate: "2021-03-15T10:00:00Z",
      endDate: "2021-03-15T10:20:00Z",
      activityType: "walk",
      stepCount: 120
    };
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2021-03-15.json", { timelineItems: [timelineItem] }),
      text("Previous Backups ABC/TimelineItem/A/move-1.json", timelineItem)
    ]);

    expect(result.rows.raw_pedometer).toHaveLength(1);
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

  test("overlays only the Moves-covered interval and preserves surrounding Arc history", async () => {
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

    expect(result.rows.stays).toHaveLength(3);
    expect(result.rows.stays[0]?.start_ts).toBe(Date.parse("2017-04-03T08:00:00Z") / 1000);
    expect(Math.max(...result.rows.stays.map((stay) => stay.end_ts!))).toBe(Date.parse("2017-04-03T12:00:00Z") / 1000);
    expect(result.rows.no_data_gaps).toHaveLength(2);
    expect(result.rows.pois.find((poi) => poi.name === "Arc")).toBeDefined();
    expect(result.rows.pois.find((poi) => poi.name === "Moves")).toBeDefined();
  });

  test("keeps Arc POI metadata when a matching Moves stay has no name", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [{
          itemId: "arc-stay",
          isVisit: true,
          startDate: "2017-04-03T10:00:00Z",
          endDate: "2017-04-03T11:00:00Z",
          radius: { mean: 18 },
          place: {
            placeId: "arc-place",
            name: "Arc Venue",
            location: { latitude: 60.1, longitude: 24.1 }
          }
        }]
      }),
      text("moves.json", [{
        date: "20170403",
        segments: [{
          type: "place",
          startTime: "20170403T100000+0000",
          endTime: "20170403T110000+0000",
          place: { id: 42, location: { lat: 60.1, lon: 24.1 } }
        }]
      }])
    ]);

    const arcPoi = result.rows.pois.find((poi) => poi.name === "Arc Venue");
    expect(result.rows.stays).toEqual([expect.objectContaining({ poi_id: arcPoi?.id, radius_m: 18 })]);
    expect(result.rows.stay_pois).toEqual([expect.objectContaining({ poi_id: arcPoi?.id, role: "primary" })]);
  });

  test("chooses the healthier Moves candidate without relying on directory level", async () => {
    const daily = {
      date: "20170403",
      segments: [
        {
          type: "place",
          startTime: "20170403T100000+0000",
          endTime: "20170403T110000+0000",
          place: { id: 42, name: "Daily", location: { lat: 60.1, lon: 24.1 } }
        }
      ]
    };
    const aggregate = {
      ...daily,
      segments: [
        {
          type: "place",
          startTime: "20170403T100000+0000",
          endTime: "20170403T120000+0000",
          place: { id: 42, name: "Aggregate", location: { lat: 60.1, lon: 24.1 } }
        }
      ]
    };

    const result = await convertImportEntries([
      text("moves_export/json/daily/storyline/storyline_20170403.json", [daily]),
      text("moves_export/json/full/storyline.json", [aggregate]),
      text("moves_export/json/monthly/storyline/storyline_201704.json", [aggregate]),
      text("moves_export/json/yearly/storyline/storyline_2017.json", [aggregate])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.stays[0]?.end_ts).toBe(Date.parse("2017-04-03T12:00:00Z") / 1000);
    expect(result.rows.pois.map((poi) => poi.name)).toEqual(["Aggregate"]);
  });

  test("uses a newer partial Moves revision without losing other storyline intervals", async () => {
    const result = await convertImportEntries([
      text("old-storyline.json", [{
        date: "20140402",
        lastUpdate: "20140401T024827Z",
        segments: [
          {
            type: "place",
            startTime: "20140402T080000+0000",
            endTime: "20140402T090000+0000",
            place: { id: 1, name: "Old", location: { lat: 1, lon: 2 } }
          },
          {
            type: "move",
            startTime: "20140402T090000+0000",
            endTime: "20140402T100000+0000",
            activity: "walking",
            distance: 1_000
          }
        ]
      }]),
      text("new-places.json", [{
        date: "20140402",
        lastUpdate: "20140402T024827Z",
        segments: [{
          type: "place",
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          place: { id: 1, name: "New", location: { lat: 3, lon: 4 } }
        }]
      }])
    ]);

    expect(result.rows.stays).toEqual([expect.objectContaining({ centroid_lat: 3, centroid_lon: 4 })]);
    expect(result.rows.pois).toEqual([expect.objectContaining({ name: "New", lat: 3, lon: 4 })]);
    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "walk", distance_m: 1_000 })]);
  });

  test("fuses a coordinate-less Moves place revision with older geometry", async () => {
    const result = await convertImportEntries([
      text("old.json", [{
        date: "20140402",
        lastUpdate: "20140401T024827Z",
        segments: [{
          type: "place",
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          place: { id: 1, name: "Old", location: { lat: 1, lon: 2 } }
        }]
      }]),
      text("new.json", [{
        date: "20140402",
        lastUpdate: "20140402T024827Z",
        segments: [{
          type: "place",
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          place: { id: 1, name: "New" }
        }]
      }])
    ]);

    expect(result.rows.stays).toEqual([expect.objectContaining({ centroid_lat: 1, centroid_lon: 2 })]);
    expect(result.rows.pois).toEqual([expect.objectContaining({ name: "New", lat: 1, lon: 2 })]);
  });

  test("uses a newer Moves revision when it corrects an event boundary and mode", async () => {
    const day = (lastUpdate: string, startTime: string, activity: string) => [{
      date: "20140402",
      lastUpdate,
      segments: [{
        type: "move",
        startTime,
        endTime: "20140402T100000+0000",
        activities: [{ activity, startTime, endTime: "20140402T100000+0000" }]
      }]
    }];
    const result = await convertImportEntries([
      text("old.json", day("20140401T024827Z", "20140402T080000+0000", "walking")),
      text("new.json", day("20140402T024827Z", "20140402T080500+0000", "cycling"))
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({
      start_ts: Date.parse("2014-04-02T08:05:00Z") / 1000,
      mode: "bicycle"
    })]);
  });

  test("uses the parent Moves revision when fusing conflicting nested activities", async () => {
    const day = (lastUpdate: string, activity: Record<string, unknown>) => [{
      date: "20140402",
      lastUpdate,
      segments: [{
        type: "move",
        startTime: "20140402T080000+0000",
        endTime: "20140402T090000+0000",
        activities: [{
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          ...activity
        }]
      }]
    }];
    const result = await convertImportEntries([
      text("old.json", day("20140401T024827Z", { activity: "walking", distance: 1_000, steps: 100 })),
      text("new.json", day("20140402T024827Z", { activity: "cycling" }))
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "bicycle", distance_m: null })]);
    expect(result.rows.raw_pedometer).toHaveLength(0);
  });

  test("keeps backup-only Moves track points while applying a partial point revision", async () => {
    const points = (middleLatitude: number, partial: boolean) => partial
      ? [{ lat: middleLatitude, lon: 1, time: "20140402T083000+0000" }]
      : [
          { lat: 1, lon: 1, time: "20140402T080000+0000" },
          { lat: middleLatitude, lon: 1, time: "20140402T083000+0000" },
          { lat: 1.2, lon: 1, time: "20140402T090000+0000" }
        ];
    const day = (lastUpdate: string, trackPoints: Array<Record<string, unknown>>) => [{
      date: "20140402",
      lastUpdate,
      segments: [{
        type: "move",
        startTime: "20140402T080000+0000",
        endTime: "20140402T090000+0000",
        activities: [{
          activity: "walking",
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          trackPoints
        }]
      }]
    }];
    const result = await convertImportEntries([
      text("old.json", day("20140401T000000Z", points(1.1, false))),
      text("new.json", day("20140402T000000Z", points(1.15, true)))
    ]);

    expect(result.rows.raw_gps).toHaveLength(3);
    expect(result.rows.raw_gps.find((row) => row.ts === Date.parse("2014-04-02T08:30:00Z") / 1000)?.lat).toBe(1.15);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({ sample_count: 3 })]);
  });

  test("keeps per-point Moves revisions independent of file order", async () => {
    const day = (lastUpdate: string, trackPoints: Array<Record<string, unknown>>) => [{
      date: "20140402",
      lastUpdate,
      segments: [{
        type: "move",
        startTime: "20140402T100000+0000",
        endTime: "20140402T120000+0000",
        activities: [{
          activity: "walking",
          startTime: "20140402T100000+0000",
          endTime: "20140402T120000+0000",
          trackPoints
        }]
      }]
    }];
    const old = day("20140402T100000Z", [
      { lat: 1, lon: 1, time: "20140402T100000+0000" },
      { lat: 1.1, lon: 1, time: "20140402T110000+0000" },
      { lat: 1.2, lon: 1, time: "20140402T120000+0000" }
    ]);
    const middle = day("20140402T110000Z", [{ lat: 2, lon: 1, time: "20140402T100000+0000" }]);
    const current = day("20140402T120000Z", [{ lat: 3, lon: 1, time: "20140402T110000+0000" }]);
    const first = await convertImportEntries([text("a.json", old), text("b.json", middle), text("c.json", current)]);
    const second = await convertImportEntries([text("a.json", old), text("b.json", current), text("c.json", middle)]);
    const projection = (result: typeof first) => result.rows.raw_gps.map((row) => ({ ts: row.ts, lat: row.lat, lon: row.lon }));

    expect(projection(first)).toEqual([
      { ts: Date.parse("2014-04-02T10:00:00Z") / 1000, lat: 2, lon: 1 },
      { ts: Date.parse("2014-04-02T11:00:00Z") / 1000, lat: 3, lon: 1 },
      { ts: Date.parse("2014-04-02T12:00:00Z") / 1000, lat: 1.2, lon: 1 }
    ]);
    expect(projection(second)).toEqual(projection(first));
    expect(second.rows.route_paths).toEqual(first.rows.route_paths);
  });

  test("partitions segment-level Moves track points across multiple activities", async () => {
    const result = await convertImportEntries([text("moves.json", [{
      date: "20140402",
      segments: [{
        type: "move",
        startTime: "20140402T080000+0000",
        endTime: "20140402T100000+0000",
        trackPoints: [
          { lat: 1, lon: 1, time: "20140402T080000+0000" },
          { lat: 1.1, lon: 1.1, time: "20140402T090000+0000" },
          { lat: 1.2, lon: 1.2, time: "20140402T100000+0000" }
        ],
        activities: [
          { activity: "walking", startTime: "20140402T080000+0000", endTime: "20140402T090000+0000" },
          { activity: "car", startTime: "20140402T090000+0000", endTime: "20140402T100000+0000" }
        ]
      }]
    }])]);

    expect(result.rows.moves).toHaveLength(2);
    expect(result.rows.route_paths.map((route) => route.sample_count)).toEqual([2, 2]);
  });

  test("uses the newer Moves segment revision when its semantic kind changed", async () => {
    const result = await convertImportEntries([
      text("old.json", [{
        date: "20140402",
        lastUpdate: "20140401T024827Z",
        summary: [{ activity: "walking", steps: 100 }],
        caloriesIdle: 1_500,
        segments: [{
          type: "place",
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          place: { id: 1, name: "Home", location: { lat: 1, lon: 2 } }
        }]
      }]),
      text("new.json", [{
        date: "20140402",
        lastUpdate: "20140402T024827Z",
        segments: [{
          type: "move",
          startTime: "20140402T080000+0000",
          endTime: "20140402T090000+0000",
          activity: "cycling"
        }]
      }])
    ]);

    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "bicycle" })]);
  });

  test("supplements a broad Moves segment with fields from narrower evidence", async () => {
    const result = await convertImportEntries([
      text("broad.json", [{
        date: "20170403",
        segments: [{
          type: "place",
          startTime: "20170403T080000+0000",
          endTime: "20170403T120000+0000",
          place: { id: 42, location: { lat: 60.1, lon: 24.1 } }
        }]
      }]),
      text("named.json", [{
        date: "20170403",
        segments: [{
          type: "place",
          startTime: "20170403T090000+0000",
          endTime: "20170403T100000+0000",
          place: { id: 42, name: "Home", location: { lat: 60.1, lon: 24.1 } }
        }]
      }])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.pois).toEqual([expect.objectContaining({ name: "Home" })]);
    expect(result.rows.stays[0]!.poi_id).toBe(result.rows.pois[0]!.id);
  });

  test("does not replace Arc history with an unusable Moves move", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [{
          itemId: "arc-stay",
          isVisit: true,
          startDate: "2017-04-03T09:00:00Z",
          endDate: "2017-04-03T10:00:00Z",
          center: { latitude: 60.1, longitude: 24.1 }
        }]
      }),
      text("moves.json", [{
        date: "20170403",
        segments: [{
          type: "move",
          startTime: "20170403T090000+0000",
          endTime: "20170403T100000+0000",
          activities: [{
            activity: "wlk",
            startTime: "20170403T110000+0000",
            endTime: "20170403T120000+0000"
          }]
        }]
      }])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.moves).toHaveLength(0);
  });

  test("keeps an evidence-backed Arc route over an unnamed Moves stay", async () => {
    const samples = [8, 9, 10, 11, 12].map((hour, index) => ({
      sampleId: `sample-${index}`,
      date: `2021-03-15T${hour.toString().padStart(2, "0")}:00:00Z`,
      location: {
        timestamp: `2021-03-15T${hour.toString().padStart(2, "0")}:00:00Z`,
        latitude: 1 + index * 0.001,
        longitude: 1 + index * 0.001
      }
    }));
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [{
          itemId: "arc-move",
          isVisit: false,
          startDate: "2021-03-15T08:00:00Z",
          endDate: "2021-03-15T12:00:00Z",
          samples
        }]
      }),
      text("moves.json", [{
        date: "20210315",
        segments: [{
          type: "place",
          startTime: "20210315T093000+0000",
          endTime: "20210315T100000+0000",
          place: { id: 42, location: { lat: 2, lon: 2 } }
        }]
      }])
    ]);

    expect(result.rows.stays).toHaveLength(0);
    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({ move_id: result.rows.moves[0]!.id })]);
  });

  test("reads Moves aggregates even when a daily file exists", async () => {
    const reads: string[] = [];
    const day = [{
      date: "20170403",
      segments: [{
        type: "place",
        startTime: "20170403T100000+0000",
        endTime: "20170403T110000+0000",
        place: { id: 42, name: "Daily", location: { lat: 60.1, lon: 24.1 } }
      }]
    }];
    const makeHandle = (path: string): ImportFileHandle => {
      const data = new TextEncoder().encode(JSON.stringify(day));
      return {
        path,
        size: data.byteLength,
        readData: async () => {
          reads.push(path);
          return data;
        }
      };
    };

    await convertImportFileHandles([
      makeHandle("moves_export/json/daily/storyline/storyline_20170403.json"),
      makeHandle("moves_export/json/full/storyline.json")
    ]);

    expect(reads).toContain("moves_export/json/daily/storyline/storyline_20170403.json");
    expect(reads).toContain("moves_export/json/full/storyline.json");
  });

  test("keeps aggregate-only Moves dates when only some daily files are present", async () => {
    const makeDay = (date: string, startTime: string, endTime: string, id: number) => ({
      date,
      segments: [{
        type: "place",
        startTime,
        endTime,
        place: { id, location: { lat: 60 + id / 100, lon: 24 } }
      }]
    });
    const result = await convertImportEntries([
      text("moves_export/json/daily/storyline/storyline_20170403.json", [
        makeDay("20170403", "20170403T100000+0000", "20170403T110000+0000", 1)
      ]),
      text("moves_export/json/full/storyline.json", [
        makeDay("20170403", "20170403T100000+0000", "20170403T110000+0000", 1),
        makeDay("20170404", "20170404T100000+0000", "20170404T110000+0000", 2)
      ])
    ]);

    expect(result.rows.stays).toHaveLength(2);
  });

  test("imports each Moves calendar day once when an aggregate contains duplicates", async () => {
    const day = {
      date: "20160101",
      segments: [
        {
          type: "place",
          startTime: "20160101T100000+0000",
          endTime: "20160101T110000+0000",
          place: { id: 42, name: "Home", location: { lat: 60.1, lon: 24.1 } }
        }
      ]
    };

    const result = await convertImportEntries([
      text("moves_export/json/full/storyline.json", [day, day])
    ]);

    expect(result.rows.stays).toHaveLength(1);
    expect(result.rows.pois).toHaveLength(1);
    expect(result.rows.pois[0]?.visitCount).toBe(1);
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

    expect(streamed.sort()).toEqual(["raw_gps:1", "raw_motion_activity:1", "raw_pedometer:1", "samples:1"]);
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
    expect(result.report.userVersion).toBe(12);
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
      [Date.parse("2024-05-01T09:00:00Z") / 1000, Date.parse("2024-05-01T10:10:00Z") / 1000],
      [Date.parse("2024-05-01T10:35:00Z") / 1000, Date.parse("2024-05-01T11:00:00Z") / 1000]
    ]);
    expect(result.rows.moves.map((move) => [move.mode, move.start_ts, move.end_ts])).toEqual([
      ["walk", Date.parse("2024-05-01T10:10:00Z") / 1000, Date.parse("2024-05-01T10:20:00Z") / 1000],
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

  test("reports the verified App timeline invariants", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2024-05-01.json", {
        timelineItems: [
          {
            itemId: "stay-1",
            isVisit: true,
            startDate: "2024-05-01T09:00:00Z",
            endDate: "2024-05-01T10:00:00Z",
            place: { name: "Home", location: { latitude: -33.86, longitude: 151.2 } }
          },
          {
            itemId: "move-1",
            isVisit: false,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T10:30:00Z",
            activityType: "walk"
          }
        ]
      })
    ]);

    expect(result.report.timelineIntegrity).toEqual({
      eventCount: 2,
      duplicateStartCount: 0,
      overlapCount: 0,
      adjacentSameKindCount: 0,
      openEventCount: 0,
      openEventNotLastCount: 0,
      nonPositiveDurationCount: 0
    });
  });

  test("preserves distinct adjacent stays with an explicit uncertainty gap", async () => {
    const result = await convertImportEntries([
      text("Export/JSON/Daily/2024-05-01.json", {
        timelineItems: [
          {
            itemId: "stay-1",
            isVisit: true,
            startDate: "2024-05-01T09:00:00Z",
            endDate: "2024-05-01T10:00:00Z",
            place: {
              placeId: "place-1",
              name: "Old",
              location: { latitude: -33.86, longitude: 151.2 }
            }
          },
          {
            itemId: "stay-2",
            isVisit: true,
            startDate: "2024-05-01T10:00:00Z",
            endDate: "2024-05-01T11:00:00Z",
            radius: { mean: 25 },
            place: {
              placeId: "place-2",
              name: "Current",
              location: { latitude: -33.87, longitude: 151.21 }
            }
          }
        ]
      })
    ]);

    expect(result.rows.stays).toHaveLength(2);
    expect(result.rows.no_data_gaps).toEqual([expect.objectContaining({
      notes: "generated_between_stays"
    })]);
    expect(result.rows.no_data_gaps[0]!.end_ts! - result.rows.no_data_gaps[0]!.start_ts).toBe(60);
    expect(result.rows.stays.map((stay) => stay.poi_id)).toEqual([
      result.rows.pois.find((poi) => poi.name === "Old")?.id,
      result.rows.pois.find((poi) => poi.name === "Current")?.id
    ]);
  });

  test("creates a minimal gap between distinct adjacent short stays", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [
        {
          itemId: "short-1",
          isVisit: true,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T08:00:30Z",
          center: { latitude: 0, longitude: 0 }
        },
        {
          itemId: "short-2",
          isVisit: true,
          startDate: "2024-05-01T08:00:30Z",
          endDate: "2024-05-01T08:01:00Z",
          center: { latitude: 1, longitude: 1 }
        }
      ] })
    ]);

    expect(result.rows.stays).toHaveLength(2);
    expect(result.rows.no_data_gaps).toHaveLength(1);
    expect(result.rows.no_data_gaps[0]!.end_ts! - result.rows.no_data_gaps[0]!.start_ts).toBeCloseTo(1);
    expect(result.report.timelineIntegrity.adjacentSameKindCount).toBe(0);
  });

  test("does not shrink a short stay while reserving uncertainty on both sides", async () => {
    const result = await convertImportEntries([
      text("arc.json", {
        timelineItems: [
          {
            itemId: "stay-1",
            isVisit: true,
            startDate: "2021-03-14T05:16:59Z",
            endDate: "2021-03-14T09:50:08Z",
            radius: { mean: 5.749 },
            center: { latitude: 31.23808568, longitude: 121.45797168 }
          },
          {
            itemId: "stay-2",
            isVisit: true,
            startDate: "2021-03-14T09:50:08Z",
            endDate: "2021-03-14T09:50:50Z",
            radius: { mean: 0.000001 },
            center: { latitude: 31.23740676, longitude: 121.45857505 }
          },
          {
            itemId: "stay-3",
            isVisit: true,
            startDate: "2021-03-14T09:50:50Z",
            endDate: "2021-03-14T09:55:06Z",
            radius: { mean: 27.466 },
            center: { latitude: 31.2368169, longitude: 121.45918566 }
          }
        ]
      })
    ]);

    const middle = result.rows.stays.find((stay) => stay.centroid_lat === 31.23740676);
    expect(middle!.end_ts! - middle!.start_ts).toBe(42);
    expect(result.rows.no_data_gaps).toHaveLength(2);
    expect(result.rows.no_data_gaps.every((gap) => gap.end_ts! - gap.start_ts! >= 60)).toBe(true);
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

    expect(result.rows.moves).toHaveLength(0);
    expect(result.rows.stays.map((stay) => [stay.start_ts, stay.end_ts])).toEqual([
      [Date.parse("2024-05-01T10:00:00Z") / 1000, Date.parse("2024-05-01T11:00:00Z") / 1000]
    ]);
  });

  test("merges compatible same-start Arc stays without losing the longer interval", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [
        {
          itemId: "short",
          isVisit: true,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T09:00:00Z",
          center: { latitude: 1, longitude: 1 }
        },
        {
          itemId: "long",
          isVisit: true,
          startDate: "2024-05-01T08:00:00Z",
          endDate: "2024-05-01T10:00:00Z",
          center: { latitude: 1, longitude: 1 }
        }
      ] })
    ]);

    expect(result.rows.stays).toEqual([expect.objectContaining({
      start_ts: Date.parse("2024-05-01T08:00:00Z") / 1000,
      end_ts: Date.parse("2024-05-01T10:00:00Z") / 1000
    })]);
  });

  test("keeps a routed Arc move over an overlapping Moves tracking-off claim", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "route",
        isVisit: false,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T10:00:00Z",
        activityType: "walking",
        samples: [
          { date: "2024-05-01T08:00:00Z", location: { timestamp: "2024-05-01T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2024-05-01T10:00:00Z", location: { timestamp: "2024-05-01T10:00:00Z", latitude: 1.1, longitude: 1.1 } }
        ]
      }] }),
      text("moves.json", [{ date: "20240501", segments: [{
        type: "off",
        startTime: "20240501T090000+0000",
        endTime: "20240501T093000+0000"
      }] }])
    ]);

    expect(result.rows.moves).toHaveLength(1);
    expect(result.rows.route_paths).toHaveLength(1);
    expect(result.rows.no_data_gaps).toHaveLength(0);
  });

  test("keeps Arc route geometry while applying a manual Moves mode correction", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "route",
        isVisit: false,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z",
        activityType: "walking",
        samples: [
          { date: "2024-05-01T08:00:00Z", location: { timestamp: "2024-05-01T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2024-05-01T09:00:00Z", location: { timestamp: "2024-05-01T09:00:00Z", latitude: 1.1, longitude: 1.1 } }
        ]
      }] }),
      text("moves.json", [{ date: "20240501", segments: [{
        type: "move",
        startTime: "20240501T080000+0000",
        endTime: "20240501T090000+0000",
        activities: [{
          activity: "cycling",
          manual: true,
          startTime: "20240501T080000+0000",
          endTime: "20240501T090000+0000"
        }]
      }] }])
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({ mode: "bicycle", provider: "moves_export" })]);
    expect(result.rows.moves[0]?.distance_m).toBeGreaterThan(0);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({ move_id: result.rows.moves[0]?.id })]);
  });

  test("prefers pre-shutdown Moves semantics while retaining matching Arc route geometry", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "moves-imported-arc-route",
        isVisit: false,
        startDate: "2017-04-03T08:00:00Z",
        endDate: "2017-04-03T09:00:00Z",
        activityType: "walking",
        samples: [
          { date: "2017-04-03T08:00:00Z", location: { timestamp: "2017-04-03T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2017-04-03T09:00:00Z", location: { timestamp: "2017-04-03T09:00:00Z", latitude: 1.1, longitude: 1.1 } }
        ]
      }] }),
      text("moves.json", [{ date: "20170403", segments: [{
        type: "move",
        startTime: "20170403T080000+0000",
        endTime: "20170403T090000+0000",
        activities: [{
          activity: "transport",
          startTime: "20170403T080000+0000",
          endTime: "20170403T090000+0000"
        }]
      }] }])
    ]);

    expect(result.rows.moves).toEqual([
      expect.objectContaining({ mode: "transit", provider: "moves_export" })
    ]);
    expect(result.rows.moves[0]?.distance_m).toBeGreaterThan(0);
    expect(result.rows.route_paths).toEqual([
      expect.objectContaining({ move_id: result.rows.moves[0]?.id })
    ]);
  });

  test("uses Moves provenance and values for an exact pre-shutdown Arc duplicate", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "moves-imported-arc-duplicate",
        isVisit: false,
        startDate: "2017-04-03T08:00:00Z",
        endDate: "2017-04-03T09:00:00Z",
        secondsFromGMT: 36_000,
        activityType: "walking",
        samples: [
          { date: "2017-04-03T08:00:00Z", location: { timestamp: "2017-04-03T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2017-04-03T09:00:00Z", location: { timestamp: "2017-04-03T09:00:00Z", latitude: 1.01, longitude: 1.01 } }
        ]
      }] }),
      text("moves.json", [{ date: "20170403", segments: [{
        type: "move",
        startTime: "20170403T090000+0100",
        endTime: "20170403T100000+0100",
        activities: [{
          activity: "walking",
          distance: 321,
          startTime: "20170403T090000+0100",
          endTime: "20170403T100000+0100"
        }]
      }] }])
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({
      provider: "moves_export",
      distance_m: 321,
      tz_offset_s: 3_600
    })]);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({
      move_id: result.rows.moves[0]?.id,
      provider: "arc_import"
    })]);
  });

  test("records an exact pre-shutdown Arc duplicate as Moves semantic evidence", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "moves-imported-arc-duplicate",
        isVisit: false,
        startDate: "2017-04-03T08:00:00Z",
        endDate: "2017-04-03T09:00:00Z",
        activityType: "walking"
      }, {
        itemId: "arc-manual-overlap",
        isVisit: false,
        startDate: "2017-04-03T08:00:00Z",
        endDate: "2017-04-03T09:00:00Z",
        activityType: "cycling",
        manualActivityType: true
      }] }),
      text("moves.json", [{ date: "20170403", segments: [{
        type: "move",
        startTime: "20170403T080000Z",
        endTime: "20170403T090000Z",
        activities: [{
          activity: "walking",
          startTime: "20170403T080000Z",
          endTime: "20170403T090000Z"
        }]
      }] }])
    ]);

    expect(result.rows.moves).toEqual([expect.objectContaining({
      mode: "walk",
      provider: "moves_export"
    })]);
  });

  test("does not replace Arc provenance for post-shutdown or non-exact Moves overlap", async () => {
    const postShutdown = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "post-shutdown-arc-duplicate",
        isVisit: false,
        startDate: "2024-04-03T08:00:00Z",
        endDate: "2024-04-03T09:00:00Z",
        secondsFromGMT: 36_000,
        activityType: "walking",
        samples: [
          { date: "2024-04-03T08:00:00Z", location: { timestamp: "2024-04-03T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2024-04-03T09:00:00Z", location: { timestamp: "2024-04-03T09:00:00Z", latitude: 1.01, longitude: 1.01 } }
        ]
      }] }),
      text("moves.json", [{ date: "20240403", segments: [{
        type: "move",
        startTime: "20240403T090000+0100",
        endTime: "20240403T100000+0100",
        activities: [{
          activity: "walking",
          distance: 321,
          startTime: "20240403T090000+0100",
          endTime: "20240403T100000+0100"
        }]
      }] }])
    ]);
    expect(postShutdown.rows.moves).toEqual([expect.objectContaining({
      provider: "arc_import",
      tz_offset_s: 36_000
    })]);
    expect(postShutdown.rows.moves[0]?.distance_m).not.toBe(321);

    const nonExact = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "pre-shutdown-arc-tail",
        isVisit: false,
        startDate: "2017-04-03T08:00:00Z",
        endDate: "2017-04-03T09:01:00Z",
        activityType: "walking"
      }] }),
      text("moves.json", [{ date: "20170403", segments: [{
        type: "move",
        startTime: "20170403T080000Z",
        endTime: "20170403T090000Z",
        activities: [{
          activity: "walking",
          startTime: "20170403T080000Z",
          endTime: "20170403T090000Z"
        }]
      }] }])
    ]);
    expect([...nonExact.rows.moves]
      .sort((lhs, rhs) => lhs.start_ts - rhs.start_ts)
      .map((move) => [move.provider, move.start_ts, move.end_ts])).toEqual([
      ["moves_export", Date.parse("2017-04-03T08:00:00Z") / 1_000, Date.parse("2017-04-03T09:00:00Z") / 1_000],
      ["arc_import", Date.parse("2017-04-03T09:00:00Z") / 1_000, Date.parse("2017-04-03T09:01:00Z") / 1_000]
    ]);
  });

  test("prefers pre-shutdown Moves activity segmentation over a broad Arc move", async () => {
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "moves-imported-aggregate",
        isVisit: false,
        startDate: "2017-04-03T08:00:00Z",
        endDate: "2017-04-03T10:00:00Z",
        activityType: "walking",
        manualActivityType: true,
        samples: [
          { date: "2017-04-03T08:00:00Z", location: { timestamp: "2017-04-03T08:00:00Z", latitude: 1, longitude: 1 } },
          { date: "2017-04-03T10:00:00Z", location: { timestamp: "2017-04-03T10:00:00Z", latitude: 1.1, longitude: 1.1 } }
        ]
      }] }),
      text("moves.json", [{ date: "20170403", segments: [{
        type: "move",
        startTime: "20170403T080000+0000",
        endTime: "20170403T100000+0000",
        activities: [{
          activity: "walking",
          startTime: "20170403T080000+0000",
          endTime: "20170403T090000+0000"
        }, {
          activity: "transport",
          startTime: "20170403T090000+0000",
          endTime: "20170403T100000+0000"
        }]
      }] }])
    ]);

    expect(result.rows.moves.map((move) => [move.mode, move.start_ts, move.end_ts])).toEqual([
      ["walk", Date.parse("2017-04-03T08:00:00Z") / 1_000, Date.parse("2017-04-03T09:00:00Z") / 1_000],
      ["transit", Date.parse("2017-04-03T09:00:00Z") / 1_000, Date.parse("2017-04-03T10:00:00Z") / 1_000]
    ]);
  });

  test("drops route geometry when overlap resolution shifts a move boundary", async () => {
    const move = (id: string, start: string, end: string, lon: number) => ({
      itemId: id,
      isVisit: false,
      startDate: start,
      endDate: end,
      activityType: "walking",
      samples: [
        { date: start, location: { timestamp: start, latitude: 1, longitude: lon } },
        { date: end, location: { timestamp: end, latitude: 1, longitude: lon + 1 } }
      ]
    });
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [
        move("first", "2024-05-01T08:00:00Z", "2024-05-01T10:00:00Z", 1),
        move("second", "2024-05-01T09:00:00Z", "2024-05-01T11:00:00Z", 2)
      ] })
    ]);

    const shifted = result.rows.moves.find((row) => row.start_ts === Date.parse("2024-05-01T10:00:00Z") / 1000);
    expect(shifted?.distance_m).toBeNull();
    expect(result.rows.route_paths.map((path) => path.move_id)).not.toContain(shifted?.id);
  });

  test("builds Arc routes only from samples inside the move window", async () => {
    const sample = (time: string, longitude: number) => ({
      date: time,
      location: { timestamp: time, latitude: 1, longitude }
    });
    const result = await convertImportEntries([
      text("arc.json", { timelineItems: [{
        itemId: "windowed-route",
        isVisit: false,
        startDate: "2024-05-01T08:00:00Z",
        endDate: "2024-05-01T09:00:00Z",
        activityType: "walking",
        samples: [
          sample("2024-05-01T07:00:00Z", 0),
          sample("2024-05-01T08:10:00Z", 1),
          sample("2024-05-01T08:50:00Z", 1.1),
          sample("2024-05-01T10:00:00Z", 3)
        ]
      }] })
    ]);

    expect(result.rows.raw_gps).toHaveLength(4);
    expect(result.rows.route_paths).toEqual([expect.objectContaining({
      sample_count: 2,
      bbox_min_lon: 1,
      bbox_max_lon: 1.1
    })]);
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
