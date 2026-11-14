import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Dock, type TabId } from "@/components/dock";
import { isNativeShell } from "@/lib/native";
import { PrefsProvider } from "@/lib/prefs";

vi.mock("@/lib/native", () => ({ isNativeShell: vi.fn(() => false) }));

const nativeMock = vi.mocked(isNativeShell);

function renderDock(active: TabId = "inbox") {
  return render(
    <PrefsProvider>
      <Dock
        active={active}
        onChange={() => {}}
        onCompose={() => {}}
        onNewTask={() => {}}
        onNewEvent={() => {}}
      />
    </PrefsProvider>,
  );
}

function fabButton(): HTMLButtonElement {
  return screen.getByLabelText("Nouveau message") as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Dock", () => {
  it("garde le shadow et le scale du FAB hors coquille native", () => {
    nativeMock.mockReturnValue(false);
    renderDock();

    const button = fabButton();
    expect(button.className).toContain("shadow-");
    expect(button.className).toContain("active:scale-90");
    expect(button.parentElement?.getAttribute("style")).toBeTruthy();
  });

  it("retire shadow, scale et animation du FAB sur la coquille native (clip arrondi WebView)", () => {
    nativeMock.mockReturnValue(true);
    renderDock();

    const button = fabButton();
    expect(button.className).not.toContain("shadow-");
    expect(button.className).not.toContain("active:scale");
    expect(button.className).not.toContain("transition-transform");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("overflow-hidden");
    expect(button.className).toContain("bg-accent");

    const reflection = button.querySelector("span");
    expect(reflection?.className).toContain("bg-gradient-to-br");

    const wrapper = button.parentElement as HTMLElement;
    expect(wrapper.className).toBe("flex items-center overflow-hidden");
    expect(wrapper.getAttribute("style")).toBeNull();
  });

  it("suit l'onglet actif aussi en coquille native", () => {
    nativeMock.mockReturnValue(true);
    renderDock("settings");
    expect(screen.queryByLabelText("Nouveau message")).toBeNull();

    cleanup();
    renderDock("calendar");
    expect(screen.getByLabelText("Nouveau rendez-vous")).toBeTruthy();
  });
});
