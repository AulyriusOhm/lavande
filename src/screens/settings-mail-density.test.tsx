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
  fireEvent.click(screen.getByRole("button", { name: /^Apparence/ }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · affichage des mails", () => {
  it("bascule vers le compact et le persiste", async () => {
    mount();

    const cozy = screen.getByRole("button", { name: "Confort" });
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
    expect(compact.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(compact);

    await waitFor(() => expect(stored().mailDensity).toBe("compact"));
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Plus de mails à l'écran, sans aperçu")).toBeTruthy();

    fireEvent.click(cozy);
    await waitFor(() => expect(stored().mailDensity).toBe("cozy"));
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
  });
});
