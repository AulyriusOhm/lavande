import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Démo vitrine : le drapeau est posé avant l'évaluation des modules, comme dans
// un build `VITE_MAIL_BACKEND=demo VITE_DEMO_READONLY=1 vite build`.
vi.hoisted(() => {
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  vi.stubEnv("VITE_DEMO_READONLY", "1");
});

import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

function openSection(label: string) {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sections des réglages" })).getByRole("button", { name: label }),
  );
}

const section = () => document.getElementById("reglages-messagerie") as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages · filtres Zimbra en démo", () => {
  it("s'affiche en lecture seule, sans appel ni bouton d'écriture", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
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
    openSection("Filtres & absence");

    await waitFor(() =>
      expect(within(section()).getByText(/Démo : les filtres et le message d'absence/)).toBeTruthy(),
    );
    expect(within(section()).queryByRole("button", { name: "Nouveau filtre" })).toBeNull();
    expect(within(section()).queryByRole("button", { name: "Enregistrer l'absence" })).toBeNull();
    expect(within(section()).getByText(/Démo : les étiquettes/)).toBeTruthy();
    expect(within(section()).queryByRole("button", { name: "Créer l'étiquette" })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/zimbra/")),
    ).toHaveLength(0);
  });
});
