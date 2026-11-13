import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

const GROUPS = ["Comptes", "Apparence", "Notifications", "Synchronisation", "Sécurité", "IA", "MCP", "Application"];

const SECTIONS = [
  { label: "Comptes", anchor: "reglages-comptes" },
  { label: "Signatures", anchor: "reglages-signatures" },
  { label: "Apparence", anchor: "reglages-apparence" },
  { label: "Raccourcis clavier", anchor: "reglages-clavier" },
  { label: "Modules", anchor: "reglages-modules" },
  { label: "Notifications", anchor: "reglages-notifications" },
  { label: "Synchronisation", anchor: "reglages-synchronisation" },
  { label: "Calendriers", anchor: "reglages-calendriers" },
  { label: "Sécurité & PGP", anchor: "reglages-securite" },
  { label: "Intelligence artificielle", anchor: "reglages-ia" },
  { label: "Résumés", anchor: "reglages-resumes" },
  { label: "Suggestions de tâches", anchor: "reglages-taches-ia" },
  { label: "Serveurs MCP", anchor: "reglages-assistant" },
  { label: "Mise à jour", anchor: "reglages-mise-a-jour" },
  { label: "À propos", anchor: "reglages-apropos" },
];

const scrolled: Element[] = [];

beforeEach(() => {
  window.localStorage.clear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
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

const nav = () => screen.getByRole("navigation", { name: "Sections des réglages" });

describe("Réglages · sommaire groupé", () => {
  it("range les sections en huit groupes nommés", () => {
    renderSettings();

    const groups = within(nav()).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(GROUPS);
    groups.forEach((group, index) => {
      expect(within(group).getByText(GROUPS[index], { selector: "p" })).toBeTruthy();
    });
  });

  it("garde toutes les sous-sections, dans l'ordre des groupes", () => {
    renderSettings();

    const buttons = within(nav()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(SECTIONS.map((section) => section.label));
  });

  it("rend les corps de sections dans l'ordre du sommaire", () => {
    renderSettings();

    const anchors = Array.from(document.querySelectorAll("[id^='reglages-']")).map((node) => node.id);
    expect(anchors).toEqual(SECTIONS.map((section) => section.anchor));
  });

  it("navigue vers une sous-section et marque le sommaire", () => {
    renderSettings();

    const target = within(nav()).getByRole("button", { name: "Calendriers" });
    fireEvent.click(target);

    expect(target.getAttribute("aria-current")).toBe("true");
    expect(within(nav()).getByRole("button", { name: "Comptes" }).getAttribute("aria-current")).toBe("false");
    expect(scrolled).toEqual([document.getElementById("reglages-calendriers")]);
  });
});
