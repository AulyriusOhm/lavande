import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function mount() {
  return render(
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
}

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · notifications", () => {
  it("coupe l'interrupteur général et le persiste", async () => {
    mount();

    const toggle = screen.getByRole("switch", { name: /^Notifications/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(stored().notifications).toMatchObject({ enabled: false });
  });

  it("règle le délai des rappels d'agenda", async () => {
    mount();

    fireEvent.click(screen.getByRole("radio", { name: "30 min" }));

    await waitFor(() => expect(stored().notifications).toMatchObject({ calendarMinutes: 30 }));
    expect(screen.getByRole("radio", { name: "30 min" }).getAttribute("aria-checked")).toBe("true");
  });

  it("coupe les notifications d'un seul compte", async () => {
    mount();

    const rows = screen.getAllByRole("switch", { name: /@/ });
    fireEvent.click(rows[0]);

    await waitFor(() =>
      expect(Object.values((stored().notifications as { accounts: Record<string, boolean> }).accounts)).toEqual([
        false,
      ]),
    );
    expect(rows[0].getAttribute("aria-checked")).toBe("false");
    expect(rows[1].getAttribute("aria-checked")).toBe("true");
  });
});
