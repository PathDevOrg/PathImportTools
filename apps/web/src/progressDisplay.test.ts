import { describe, expect, test } from "vitest";
import { progressDetailText, progressPercent } from "./progressDisplay";

describe("progressDetailText", () => {
  test("shows item counts even when byte progress is available", () => {
    expect(progressDetailText({
      phase: "parse",
      message: "Reading file",
      completed: 1234,
      total: 18414,
      bytesCompleted: 348_900_000,
      bytesTotal: 1_600_000_000
    })).toBe("1,234 / 18,414");
  });
});

describe("progressPercent", () => {
  test("starts at zero instead of using a fake minimum", () => {
    expect(progressPercent("converting", null)).toBe(0);
    expect(progressPercent("converting", {
      phase: "parse",
      message: "Reading file",
      completed: 1,
      total: 100
    })).toBe(1);
  });

  test("uses actual progress and caps active work below complete", () => {
    expect(progressPercent("converting", {
      phase: "parse",
      message: "Reading file",
      completed: 1890,
      total: 18291
    })).toBe(10);
    expect(progressPercent("converting", {
      phase: "parse",
      message: "Reading file",
      completed: 100,
      total: 100
    })).toBe(99);
    expect(progressPercent("complete", null)).toBe(100);
  });
});
