import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DesktopDock, type DesktopView } from "@/desktop/dock";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

function mount({
  active = "inbox" as DesktopView,
  onChange = vi.fn(),
  onCompose = vi.fn(),
  onNewTask = vi.fn(),
  onNewEvent = vi.fn(),
  onSearch = vi.fn(),
} = {}) {
  render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <DesktopDock
              active={active}
              onChange={onChange}
              onCompose={onCompose}
              onNewTask={onNewTask}
              onNewEvent={onNewEvent}
              onSearch={onSearch}
            />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
  return { onChange, onCompose, onNewTask, onNewEvent, onSearch };
}

const tab = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  window.localStorage.clear();
});

describe("Dock PC · navigation", () => {
  it("affiche les quatre onglets et marque l'onglet actif", () => {
    mount();

    for (const label of ["Boîte", "Agenda", "Planification", "Réglages"]) {
      expect(tab(label).getAttribute("aria-current")).toBe(label === "Boîte" ? "true" : "false");
    }
  });

  it("change de vue au clic sur un onglet", () => {
    const { onChange } = mount();

    fireEvent.click(tab("Planification"));

    expect(onChange).toHaveBeenCalledWith("planning");
  });

  it("masque l'onglet Agenda quand l'agenda est désactivé", () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ calendarEnabled: false }));
    mount();

    expect(screen.queryByRole("button", { name: "Agenda" })).toBeNull();
    expect(tab("Boîte")).toBeTruthy();
  });
});

describe("Dock PC · recherche et action contextuelle", () => {
  it("ouvre la recherche depuis le dock", () => {
    const { onSearch } = mount();

    fireEvent.click(screen.getByRole("button", { name: "Rechercher" }));

    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("propose l'action de la vue courante", () => {
    const inbox = mount();
    fireEvent.click(screen.getByRole("button", { name: "Nouveau message" }));
    expect(inbox.onCompose).toHaveBeenCalledTimes(1);
  });

  it("n'affiche aucune action dans les réglages", () => {
    mount({ active: "settings" });

    expect(screen.queryByRole("button", { name: "Nouveau message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nouvelle tâche" })).toBeNull();
  });
});

describe("Dock PC · détachement visuel", () => {
  it("pose un halo et une aura décoratifs derrière la barre", () => {
    mount();

    const layers = Array.from(document.querySelectorAll<HTMLElement>(".dock-halo, .dock-aura"));
    expect(layers).toHaveLength(2);
    for (const layer of layers) expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".dock-glass")).toBeTruthy();
  });
});
