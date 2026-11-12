import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages mobile · raccourcis clavier", () => {
  it("déplie la liste complète des touches, actions sur le message comprises", () => {
    mount();

    const toggle = screen.getByRole("button", { name: /Toutes les touches/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Suppr")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Suppr")).toBeTruthy();
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(0);
    expect(screen.getByText("Actions sur le message")).toBeTruthy();
    expect(screen.getByText("Suivre le message")).toBeTruthy();
    expect(screen.getAllByText("Lu / non lu").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Message suivant").length).toBe(2);
  });
});
