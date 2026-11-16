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

describe("Réglages mobile · affichage des conversations", () => {
  it("bascule vers la citation classique et le persiste", async () => {
    mount();

    const tidy = screen.getByRole("button", { name: "Bien rangé" });
    const inline = screen.getByRole("button", { name: "Tout dans le même mail" });
    expect(tidy.getAttribute("aria-pressed")).toBe("true");
    expect(tidy.className).toContain("min-h-11");
    expect(screen.getByText("Le fil repliable dans la rédaction")).toBeTruthy();

    fireEvent.click(inline);

    await waitFor(() => expect(stored().threadView).toBe("inline"));
    expect(inline.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("La citation classique, repliable")).toBeTruthy();
  });
});
