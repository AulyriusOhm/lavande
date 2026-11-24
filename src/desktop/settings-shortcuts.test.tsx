import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/pgp/keys")) return response({ keys: [] });
      return response([]);
    }),
  );
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

function openSection(label: string) {
  const nav = screen.getByRole("navigation", { name: "Sections des réglages" });
  fireEvent.click(within(nav).getByRole("button", { name: label }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages · section raccourcis clavier", () => {
  it("propose la section dans le sommaire", () => {
    mount();
    openSection("Raccourcis clavier");

    expect(screen.getAllByText("Raccourcis clavier").length).toBeGreaterThan(1);
    expect(document.getElementById("reglages-clavier")).toBeTruthy();
  });

  it("liste toutes les touches groupées, actions sur le message comprises", () => {
    mount();
    openSection("Raccourcis clavier");
    const section = document.getElementById("reglages-clavier") as HTMLElement;

    expect(within(section).getByText("Suppr")).toBeTruthy();
    expect(within(section).getAllByText("Ctrl").length).toBeGreaterThan(0);
    expect(within(section).getAllByText("Maj").length).toBeGreaterThan(0);

    expect(within(section).getAllByText("Actions sur le message").length).toBe(1);
    expect(within(section).getAllByText("Navigation").length).toBe(1);
    expect(within(section).getAllByText("Aide").length).toBe(1);

    expect(within(section).getByText("Supprimer")).toBeTruthy();
    expect(within(section).getByText("Archiver")).toBeTruthy();
    expect(within(section).getByText("Suivre le message")).toBeTruthy();
    expect(within(section).getByText("Lu / non lu")).toBeTruthy();
    expect(within(section).getByText("Répondre")).toBeTruthy();
    expect(within(section).getByText("Transférer")).toBeTruthy();
    expect(within(section).getAllByText("Message suivant").length).toBe(2);
    expect(within(section).getAllByText("Raccourcis clavier").length).toBe(3);
    expect(within(section).getAllByText("Afficher ou masquer cette liste").length).toBe(2);
  });
});
