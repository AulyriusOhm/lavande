import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { haptic } from "@/lib/haptics";
import { isNativeShell } from "@/lib/native";

vi.mock("@/lib/native", () => ({ isNativeShell: vi.fn(() => true) }));

const nativeMock = vi.mocked(isNativeShell);
const vibrate = vi.fn();
let clock = new Date("2026-01-05T12:00:00Z").getTime();

function tick(ms: number) {
  clock += ms;
  vi.setSystemTime(clock);
}

beforeEach(() => {
  vi.useFakeTimers();
  tick(1000);
  nativeMock.mockReturnValue(true);
  navigator.vibrate = vibrate;
});

afterEach(() => {
  delete (navigator as Partial<Navigator>).vibrate;
  vi.useRealTimers();
});

describe("retour haptique", () => {
  it("ne vibre pas hors coquille native", () => {
    nativeMock.mockReturnValue(false);

    haptic("medium");

    expect(vibrate).not.toHaveBeenCalled();
  });

  it("vibre selon le motif demandé", () => {
    haptic("light");
    tick(200);
    haptic("medium");
    tick(200);
    haptic("success");
    tick(200);
    haptic("error");

    expect(vibrate).toHaveBeenNthCalledWith(1, 8);
    expect(vibrate).toHaveBeenNthCalledWith(2, 18);
    expect(vibrate).toHaveBeenNthCalledWith(3, [12, 40, 12]);
    expect(vibrate).toHaveBeenNthCalledWith(4, [24, 60, 24]);
  });

  it("avale les appels rapprochés d'une action groupée", () => {
    haptic("light");
    tick(50);
    haptic("light");
    haptic("light");
    expect(vibrate).toHaveBeenCalledTimes(1);

    tick(80);
    haptic("light");
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it("reste silencieux quand le vibreur est absent", () => {
    delete (navigator as Partial<Navigator>).vibrate;

    expect(() => haptic("success")).not.toThrow();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
