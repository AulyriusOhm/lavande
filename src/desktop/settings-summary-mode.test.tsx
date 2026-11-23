import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;
const summaryPref = () => (stored().summary ?? {}) as { mode?: string; rollingDays?: number };

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

describe("Réglages PC · fenêtre du résumé", () => {
  it("choisit le mode périodique par défaut et garde les heures", () => {
    renderSettings();

    expect(screen.getByRole("button", { name: "Périodique" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Jours glissants" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByLabelText("Heure de début du résumé midi")).toBeTruthy();
    expect(screen.queryByLabelText("Nombre de jours de mails non lus")).toBeNull();
  });

  it("bascule en jours glissants et remplace les heures par la fenêtre", async () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Jours glissants" }));

    await waitFor(() => expect(summaryPref().mode).toBe("rolling"));
    expect(screen.getByRole("button", { name: "Jours glissants" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByLabelText("Heure de début du résumé midi")).toBeNull();
    const days = screen.getByLabelText("Nombre de jours de mails non lus") as HTMLInputElement;
    expect(days.value).toBe("15");
    expect(screen.getByText("non lus · 15 j")).toBeTruthy();
  });

  it("borne les jours entre 1 et 90 et les persiste", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Jours glissants" }));
    const days = () => screen.getByLabelText("Nombre de jours de mails non lus") as HTMLInputElement;

    await waitFor(() => expect(days()).toBeTruthy());

    fireEvent.change(days(), { target: { value: "0" } });
    await waitFor(() => expect(summaryPref().rollingDays).toBe(1));

    fireEvent.change(days(), { target: { value: "400" } });
    await waitFor(() => expect(summaryPref().rollingDays).toBe(90));
    expect(days().value).toBe("90");

    fireEvent.change(days(), { target: { value: "7" } });
    await waitFor(() => expect(summaryPref().rollingDays).toBe(7));
    expect(screen.getByText("non lus · 7 j")).toBeTruthy();
  });
});
