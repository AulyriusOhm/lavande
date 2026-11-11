import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DesktopCalendar } from "@/desktop/calendar";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { CURRENT_MONTH, CURRENT_YEAR, monthLabel } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

type ChangeListener = (event: { matches: boolean; media: string }) => void;

const ORIGINAL_MATCH_MEDIA = window.matchMedia;
const CTA = "Nouveau rendez-vous";

function installViewport(width: number) {
  let current = width;
  const listeners = new Map<string, Set<ChangeListener>>();

  const matches = (media: string) => {
    const max = /max-width:\s*(\d+)px/.exec(media);
    if (max) return current <= Number(max[1]);
    const min = /min-width:\s*(\d+)px/.exec(media);
    if (min) return current >= Number(min[1]);
    return false;
  };

  const mediaQueryList = (media: string) => ({
    media,
    get matches() {
      return matches(media);
    },
    onchange: null,
    addEventListener: (type: string, listener: ChangeListener) => {
      if (type !== "change") return;
      const registered = listeners.get(media) ?? new Set<ChangeListener>();
      registered.add(listener);
      listeners.set(media, registered);
    },
    removeEventListener: (type: string, listener: ChangeListener) => {
      if (type !== "change") return;
      listeners.get(media)?.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => mediaQueryList(media),
  });

  return {
    resize(next: number) {
      current = next;
      act(() => {
        for (const [media, registered] of listeners) {
          for (const listener of registered) listener({ matches: matches(media), media });
        }
      });
    },
  };
}

function mount(width: number) {
  const viewport = installViewport(width);
  const onNewEvent = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  render(<DesktopCalendar onNewEvent={onNewEvent} />, { wrapper });
  return { viewport, onNewEvent };
}

const calendarButtons = () => screen.queryAllByRole("button", { name: CTA });
const layout = () => screen.getByTestId("calendar-layout");
const dayPanel = () => screen.getByTestId("day-panel");
const monthGrid = () => screen.getByTestId("month-grid");

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
  window.localStorage.clear();
});

describe("Agenda PC · bouton « Nouveau rendez-vous »", () => {
  it("n'expose qu'un seul bouton de création en fenêtre large", () => {
    mount(1440);

    expect(calendarButtons()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Ajouter" })).toBeNull();
  });

  it("n'expose qu'un seul bouton de création en fenêtre étroite", () => {
    mount(860);

    expect(calendarButtons()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Ajouter" })).toBeNull();
  });

  it("reste unique à chaque redimensionnement successif", () => {
    const { viewport } = mount(1440);
    expect(calendarButtons()).toHaveLength(1);

    for (const width of [1180, 1024, 900, 760, 1024, 1320, 640]) {
      viewport.resize(width);
      expect(calendarButtons(), `largeur ${width}px`).toHaveLength(1);
      expect(dayPanel(), `largeur ${width}px`).toBeTruthy();
      expect(monthGrid(), `largeur ${width}px`).toBeTruthy();
    }
  });

  it("déclenche la création depuis l'unique bouton", () => {
    const { onNewEvent } = mount(1280);

    fireEvent.click(calendarButtons()[0]!);

    expect(onNewEvent).toHaveBeenCalledTimes(1);
  });
});

describe("Agenda PC · layout responsive", () => {
  it("place la journée à droite et garde l'indicateur de mois en large", () => {
    mount(1440);

    expect(layout().className).toContain("flex-row");
    expect(layout().className).not.toContain("flex-col");
    expect(dayPanel().className).toContain("min-w-[320px]");
    expect(dayPanel().className).toContain("max-w-[440px]");
    expect(within(screen.getByTestId("calendar-header")).getByText(/^\d+ événements?$/)).toBeTruthy();
    expect(screen.getByText(`${monthLabel(CURRENT_MONTH)} ${CURRENT_YEAR}`)).toBeTruthy();
  });

  it("empile la journée sous la grille et libère l'en-tête en étroit", () => {
    mount(820);

    expect(layout().className).toContain("flex-col");
    expect(layout().className).toContain("overflow-y-auto");
    expect(dayPanel().className).toContain("w-full");
    expect(dayPanel().className).toContain("border-t");
    expect(within(screen.getByTestId("calendar-header")).queryByText(/^\d+ événements?$/)).toBeNull();
    expect(screen.getByText(`${monthLabel(CURRENT_MONTH)} ${CURRENT_YEAR}`)).toBeTruthy();
  });

  it("conserve 7 colonnes, 42 cases et une grille défilante à toute largeur", () => {
    const { viewport } = mount(1440);

    for (const width of [1440, 1024, 780]) {
      viewport.resize(width);
      expect(monthGrid().className, `largeur ${width}px`).toContain("grid-cols-7");
      expect(monthGrid().children, `largeur ${width}px`).toHaveLength(42);
      expect(screen.getByTestId("grid-viewport").className, `largeur ${width}px`).toContain("overflow-auto");
    }
  });

  it("garde la journée lisible en étroit, sans troncature du titre du jour", () => {
    mount(820);

    const panel = dayPanel();
    expect(within(panel).getByText("Journée")).toBeTruthy();
    const dayHeading = within(panel).getByText(/^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche) /);
    expect(dayHeading.className).toContain("truncate");
    expect(within(panel).getByText("Point maquettes v3")).toBeTruthy();
  });
});
