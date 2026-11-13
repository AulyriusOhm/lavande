import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { isNativeShell } from "@/lib/native";

vi.mock("@/lib/native", () => ({ isNativeShell: vi.fn(() => false) }));

const nativeMock = vi.mocked(isNativeShell);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ShimmerButton", () => {
  it("garde le balayage animé hors coquille native", () => {
    nativeMock.mockReturnValue(false);
    const { container } = render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect(container.querySelector("span[style*='shimmer-sweep']")).not.toBeNull();
  });

  it("retire le balayage animé sur la coquille native (clip arrondi WebView)", () => {
    nativeMock.mockReturnValue(true);
    const { container } = render(<ShimmerButton>Envoyer</ShimmerButton>);

    expect(container.querySelector("span[style*='shimmer-sweep']")).toBeNull();
    expect(container.querySelector("button")?.className).toContain("rounded-full");
  });
});