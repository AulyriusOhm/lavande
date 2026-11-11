import { describe, expect, it } from "vitest";
import { isNightTime } from "./theme";

describe("isNightTime", () => {
  it("clair pendant la journée (7h–19h)", () => {
    expect(isNightTime(new Date(2026, 0, 1, 7))).toBe(false);
    expect(isNightTime(new Date(2026, 0, 1, 12))).toBe(false);
    expect(isNightTime(new Date(2026, 0, 1, 18))).toBe(false);
  });

  it("sombre la nuit (19h–7h)", () => {
    expect(isNightTime(new Date(2026, 0, 1, 19))).toBe(true);
    expect(isNightTime(new Date(2026, 0, 1, 23))).toBe(true);
    expect(isNightTime(new Date(2026, 0, 1, 3))).toBe(true);
    expect(isNightTime(new Date(2026, 0, 1, 6))).toBe(true);
  });
});
