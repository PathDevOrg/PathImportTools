import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("favicon", () => {
  test("exposes png and ico icons from the built page", () => {
    const html = readFileSync(resolve("web/index.html"), "utf8");

    expect(html).toContain("/favicon.ico");
    expect(html).toContain("/favicon.png");
    expect(existsSync(resolve("web/public/favicon.ico"))).toBe(true);
    expect(existsSync(resolve("web/public/favicon.png"))).toBe(true);
  });
});
