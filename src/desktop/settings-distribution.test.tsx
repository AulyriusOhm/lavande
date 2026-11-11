import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 204, text: async () => "", json: async () => ({}) }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function renderSettings() {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <DesktopSettings />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

describe("Réglages · verrou distribution", () => {
  it("sans flag : l'aperçu de la maquette reste proposé", async () => {
    renderSettings();

    expect(await screen.findByText("Aperçu de la maquette mobile")).toBeTruthy();
    expect(screen.getByText("maquette PC")).toBeTruthy();
  });

  it("sous distribution : ni aperçu maquette, ni mention maquette", async () => {
    vi.stubEnv("VITE_DISTRIBUTION", "1");
    renderSettings();

    expect(await screen.findByRole("heading", { name: "À propos" })).toBeTruthy();
    expect(screen.queryByText("Aperçu de la maquette mobile")).toBeNull();
    expect(screen.queryByText("maquette PC")).toBeNull();
  });
});
