import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 204, text: async () => "", json: async () => ({}) }) as unknown as Response),
  );
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

describe("Réglages · mise à jour", () => {
  it("hors coquille de bureau : section inactive, aucun téléchargement possible", async () => {
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Mise à jour" })).toBeTruthy();
    expect(screen.getByText("Version installée")).toBeTruthy();
    expect(screen.getByText("Bureau uniquement")).toBeTruthy();

    const check = screen.getByRole("button", { name: /Vérifier les mises à jour/i }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Installer et redémarrer/i })).toBeNull();
  });
});
