import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const GROUPS = ["Comptes", "Apparence", "Synchronisation", "Sécurité & PGP", "IA", "MCP", "Application"];

const GROUP_SECTIONS: Record<string, string[]> = {
  Comptes: ["Comptes", "Périmètre de synchronisation"],
  Apparence: ["Couleur d'accent", "Modules", "Apparence"],
  Synchronisation: ["Synchronisation", "Calendriers", "Sources", "Notifications", "Notifications par compte"],
  "Sécurité & PGP": ["Sécurité"],
  IA: ["Intelligence artificielle"],
  MCP: ["Assistant"],
  Application: ["Gestes des mails", "Raccourcis clavier"],
};

function mount(handlers: { accounts?: () => void; pgp?: () => void; mcp?: () => void } = {}) {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <SettingsScreen
              mails={[]}
              account="all"
              onOpenAccounts={handlers.accounts ?? (() => {})}
              onOpenPgp={handlers.pgp ?? (() => {})}
              onOpenMcp={handlers.mcp ?? (() => {})}
            />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

const groupRows = () =>
  screen.getAllByRole("button").map((row) => GROUPS.find((label) => row.textContent?.startsWith(label)));

const open = (label: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));

const back = () => fireEvent.click(screen.getByRole("button", { name: "Retour aux réglages" }));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Réglages mobile · navigation par groupes", () => {
  it("ouvre sur la liste des sept groupes, dans l'ordre", () => {
    mount();

    expect(groupRows()).toEqual(GROUPS);
    expect(screen.getByRole("heading", { level: 1, name: "Réglages" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Gestes des mails" })).toBeNull();
  });

  it("sous VITE_PLATFORM=android : six groupes, MCP retiré", () => {
    vi.stubEnv("VITE_PLATFORM", "android");
    mount();

    expect(groupRows()).toEqual(GROUPS.filter((label) => label !== "MCP"));
  });

  it("affiche les sections du groupe ouvert, puis revient à la liste", () => {
    mount();

    open("Apparence");

    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["Apparence", "Couleur d'accent", "Modules", "Apparence"]);
    expect(screen.queryByRole("heading", { name: "Gestes des mails" })).toBeNull();

    back();

    expect(groupRows()).toEqual(GROUPS);
    expect(screen.queryByRole("heading", { name: "Couleur d'accent" })).toBeNull();
  });

  it("range chaque bloc dans son groupe", () => {
    mount();

    for (const [label, sections] of Object.entries(GROUP_SECTIONS)) {
      open(label);

      for (const section of sections) {
        expect(screen.getAllByRole("heading", { name: section }).length).toBeGreaterThan(0);
      }

      for (const [other, foreign] of Object.entries(GROUP_SECTIONS)) {
        if (other === label) continue;
        for (const section of foreign) {
          if (sections.includes(section)) continue;
          expect(screen.queryByRole("heading", { name: section })).toBeNull();
        }
      }

      back();
    }
  });

  it("garde les accès profonds dans leur groupe", () => {
    const accounts = vi.fn();
    const pgp = vi.fn();
    const mcp = vi.fn();
    mount({ accounts, pgp, mcp });

    open("Sécurité & PGP");
    fireEvent.click(screen.getByRole("button", { name: /Gérer mes clés PGP/ }));
    expect(pgp).toHaveBeenCalledTimes(1);
    back();

    open("Comptes");
    fireEvent.click(screen.getByRole("button", { name: /Boîte unifiée/ }));
    expect(accounts).toHaveBeenCalledTimes(1);
    back();

    open("MCP");
    const card = screen.getByRole("heading", { name: "Assistant" }).parentElement?.parentElement as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Serveurs MCP/ }));
    expect(mcp).toHaveBeenCalledTimes(1);
  });
});
