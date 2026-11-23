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
const updates = () => (stored().updates ?? {}) as { autoCheck?: boolean; intervalHours?: number };

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
  fireEvent.click(screen.getByRole("button", { name: /^Application/ }));
}

const toggle = () => screen.getByRole("switch", { name: /Vérification automatique/ });
const chip = (label: string) => screen.getByRole("button", { name: label });

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · vérification des mises à jour", () => {
  it("affiche l'interrupteur et la fréquence courante", () => {
    mount();

    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(chip("1 h")).toBeTruthy();
    expect(chip("24 h").getAttribute("aria-pressed")).toBe("true");
  });

  it("coupe la vérification et masque les fréquences", async () => {
    mount();

    fireEvent.click(toggle());

    await waitFor(() => expect(updates().autoCheck).toBe(false));
    expect(screen.queryByRole("button", { name: "24 h" })).toBeNull();

    fireEvent.click(toggle());
    await waitFor(() => expect(updates().autoCheck).toBe(true));
    expect(chip("24 h").getAttribute("aria-pressed")).toBe("true");
  });

  it("choisit une autre fréquence et la persiste", async () => {
    mount();

    fireEvent.click(chip("12 h"));

    await waitFor(() => expect(updates().intervalHours).toBe(12));
    expect(chip("12 h").getAttribute("aria-pressed")).toBe("true");
  });
});
