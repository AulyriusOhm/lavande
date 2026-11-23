import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;
const summaryPref = () => (stored().summary ?? {}) as { mode?: string; rollingDays?: number };

function mount() {
  render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <SettingsScreen
              mails={[]}
              account="all"
              onOpenAccounts={() => {}}
              onOpenPgp={() => {}}
              onOpenMcp={() => {}}
            />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^IA/ }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · fenêtre du résumé", () => {
  it("affiche le mode périodique et masque la fenêtre en jours", () => {
    mount();

    expect(screen.getByRole("button", { name: "Périodique" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("matin · midi · soir")).toBeTruthy();
    expect(screen.queryByLabelText("Nombre de jours de mails non lus")).toBeNull();
  });

  it("bascule en jours glissants et persiste la fenêtre", async () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Jours glissants" }));

    await waitFor(() => expect(summaryPref().mode).toBe("rolling"));
    const days = screen.getByLabelText("Nombre de jours de mails non lus") as HTMLInputElement;
    expect(days.value).toBe("15");

    fireEvent.change(days, { target: { value: "400" } });

    await waitFor(() => expect(summaryPref().rollingDays).toBe(90));
    expect((screen.getByLabelText("Nombre de jours de mails non lus") as HTMLInputElement).value).toBe(
      "90",
    );
    expect(screen.getByText("non lus · 90 j")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Périodique" }));

    await waitFor(() => expect(summaryPref().mode).toBe("period"));
    expect(screen.queryByLabelText("Nombre de jours de mails non lus")).toBeNull();
  });
});
