import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

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

describe("Réglages PC · affichage des mails", () => {
  it("choisit le confort par défaut et bascule vers le compact", async () => {
    renderSettings();

    const cozy = screen.getByRole("button", { name: "Confort" });
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
    expect(compact.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Aperçu du message et avatar large")).toBeTruthy();

    fireEvent.click(compact);

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    expect(cozy.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Plus de mails à l'écran, sans aperçu")).toBeTruthy();

    fireEvent.click(cozy);
    await waitFor(() => expect(stored().mailDensity).toBe("cozy"));
  });
});
