import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useReducedMotion } from "motion/react";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { isNativeShell } from "@/lib/native";

vi.mock("@/lib/native", () => ({ isNativeShell: vi.fn(() => false) }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const nativeMock = vi.mocked(isNativeShell);
const reduceMock = vi.mocked(useReducedMotion);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function buttonClass(): DOMTokenList {
  return (document.querySelector("button") as HTMLButtonElement).classList;
}

describe("ShimmerButton", () => {
  it("garde le balayage animé hors coquille native", () => {
    nativeMock.mockReturnValue(false);
    reduceMock.mockReturnValue(false);
    const { container } = render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect(container.querySelector("span[style*='shimmer-sweep']")).not.toBeNull();
  });

  it("garde shadow, transition et scale hors coquille native", () => {
    nativeMock.mockReturnValue(false);
    reduceMock.mockReturnValue(false);
    render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect(buttonClass().contains("shadow-[0_10px_30px_-12px_var(--accent)]")).toBe(true);
    expect(buttonClass().contains("transition-[transform,box-shadow]")).toBe(true);
    expect(buttonClass().contains("active:scale-[0.97]")).toBe(true);
  });

  it("retire le balayage animé sur la coquille native (clip arrondi WebView)", () => {
    nativeMock.mockReturnValue(true);
    reduceMock.mockReturnValue(false);
    const { container } = render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect(container.querySelector("span[style*='shimmer-sweep']")).toBeNull();
    expect(container.querySelector("button")?.className).toContain("rounded-full");
  });

  it("retire shadow, transition et scale sur la coquille native", () => {
    nativeMock.mockReturnValue(true);
    reduceMock.mockReturnValue(false);
    render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect([...buttonClass()].some((name) => name.startsWith("shadow-"))).toBe(false);
    expect(buttonClass().contains("active:scale-[0.97]")).toBe(false);
    expect(buttonClass().contains("transition-[transform,box-shadow]")).toBe(false);
  });

  it("garde le shadow en reduced-motion seul (non-régression desktop)", () => {
    nativeMock.mockReturnValue(false);
    reduceMock.mockReturnValue(true);
    const { container } = render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect(container.querySelector("span[style*='shimmer-sweep']")).toBeNull();
    expect(buttonClass().contains("shadow-[0_10px_30px_-12px_var(--accent)]")).toBe(true);
    expect(buttonClass().contains("active:scale-[0.97]")).toBe(true);
  });
});
