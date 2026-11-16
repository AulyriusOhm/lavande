import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopCalendar, NewEventDialog } from "@/desktop/calendar";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import {
  CURRENT_MONTH,
  CURRENT_YEAR,
  EVENTS,
  TODAY_ISO,
  isoInDays,
  monthLabel,
  type CalendarEvent,
} from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

type ChangeListener = (event: { matches: boolean; media: string }) => void;

const ORIGINAL_MATCH_MEDIA = window.matchMedia;
const CTA = "Nouveau rendez-vous";
const NEXT_MONTH_LABEL = `${monthLabel((CURRENT_MONTH + 1) % 12)} ${CURRENT_YEAR + (CURRENT_MONTH === 11 ? 1 : 0)}`;

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

function Providers({ children }: { children: ReactNode }) {
  return (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
}

function mount(width: number) {
  const viewport = installViewport(width);
  const onNewEvent = vi.fn();
  const onEditEvent = vi.fn();
  render(<DesktopCalendar onNewEvent={onNewEvent} onEditEvent={onEditEvent} />, { wrapper: Providers });
  return { viewport, onNewEvent, onEditEvent };
}

function Probe() {
  const { events } = useMailStore();
  return (
    <ul data-testid="probe">
      {events.map((event) => (
        <li key={event.id} data-id={event.id}>
          {`${event.title} | ${event.date} | ${event.start} | ${event.end} | ${event.calendar ?? ""}`}
        </li>
      ))}
    </ul>
  );
}

function mountDialog(event: CalendarEvent | null, initialDate?: string) {
  installViewport(1440);
  const onClose = vi.fn();
  render(
    <>
      <Probe />
      <NewEventDialog open event={event} initialDate={initialDate} onClose={onClose} />
    </>,
    { wrapper: Providers },
  );
  return { onClose };
}

const calendarButtons = () => screen.queryAllByRole("button", { name: CTA });
const layout = () => screen.getByTestId("calendar-layout");
const dayPanel = () => screen.getByTestId("day-panel");
const monthGrid = () => screen.getByTestId("month-grid");
const periodLabel = () => screen.getByTestId("period-label").textContent;
const todayButton = () => screen.getByRole("button", { name: "Aujourd'hui" }) as HTMLButtonElement;
const groupToggle = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
const probeTitles = () =>
  Array.from(screen.getByTestId("probe").querySelectorAll("li")).map((item) => item.textContent ?? "");
const countOf = (label: string) =>
  Number(((screen.getByLabelText(label).closest("label")?.textContent ?? "").match(/\d+/g) ?? []).join(""));
const groupCount = (label: string) => Number((groupToggle(label).textContent ?? "").replace(/\D/g, ""));
const seedEvents = (events: CalendarEvent[]) =>
  window.localStorage.setItem("lavande.events.v1", JSON.stringify(events));

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
  window.localStorage.clear();
});

describe("Agenda PC · pas de doublon de création avec le dock", () => {
  it("n'expose aucun bouton « Nouveau rendez-vous » en fenêtre large", () => {
    mount(1440);

    expect(calendarButtons()).toHaveLength(0);
  });

  it("n'expose aucun bouton « Nouveau rendez-vous » en fenêtre étroite", () => {
    mount(860);

    expect(calendarButtons()).toHaveLength(0);
  });

  it("reste sans doublon à chaque redimensionnement successif", () => {
    const { viewport } = mount(1440);
    expect(calendarButtons()).toHaveLength(0);

    for (const width of [1180, 1024, 900, 760, 1024, 1320, 640]) {
      viewport.resize(width);
      expect(calendarButtons(), `largeur ${width}px`).toHaveLength(0);
      expect(dayPanel(), `largeur ${width}px`).toBeTruthy();
      expect(monthGrid(), `largeur ${width}px`).toBeTruthy();
    }
  });

  it("déclenche la création depuis le « + » contextuel d'une case", () => {
    const { onNewEvent } = mount(1280);
    const target = isoInDays(2);

    fireEvent.click(screen.getByRole("button", { name: `Ajouter un rendez-vous le ${target}` }));

    expect(onNewEvent).toHaveBeenCalledTimes(1);
    expect(onNewEvent).toHaveBeenCalledWith(target);
  });
});

describe("Agenda PC · bouton Aujourd'hui", () => {
  it("est désactivé sur la période courante", () => {
    mount(1440);

    expect(todayButton().disabled).toBe(true);
    expect(todayButton().getAttribute("title")).toBe("Vous êtes déjà sur aujourd'hui");
  });

  it("se réactive hors période, ramène sur aujourd'hui puis se redésactive", async () => {
    mount(1440);

    fireEvent.click(screen.getByTestId("view-day"));
    await waitFor(() => expect(screen.getByTestId("day-view")).toBeTruthy());
    expect(todayButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Période suivante" }));

    const shifted = periodLabel();
    expect(todayButton().disabled).toBe(false);
    expect(todayButton().getAttribute("title")).toBe("Revenir à aujourd'hui");

    fireEvent.click(todayButton());

    expect(todayButton().disabled).toBe(true);
    expect(periodLabel()).not.toBe(shifted);
  });
});

describe("Agenda PC · layout responsive", () => {
  it("place la journée à droite et garde l'en-tête complet en large", () => {
    mount(1440);

    expect(layout().className).toContain("flex-row");
    expect(layout().className).not.toContain("flex-col");
    expect(dayPanel().className).toContain("min-w-[320px]");
    expect(dayPanel().className).toContain("max-w-[440px]");
    expect(within(screen.getByTestId("calendar-header")).getByText(/^\d+ sur \d+ événements?$/)).toBeTruthy();
    expect(periodLabel()).toBe(`${monthLabel(CURRENT_MONTH)} ${CURRENT_YEAR}`);
  });

  it("empile la journée sous la grille en étroit", () => {
    mount(820);

    expect(layout().className).toContain("flex-col");
    expect(layout().className).toContain("overflow-y-auto");
    expect(dayPanel().className).toContain("w-full");
    expect(dayPanel().className).toContain("border-t");
    expect(periodLabel()).toBe(`${monthLabel(CURRENT_MONTH)} ${CURRENT_YEAR}`);
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

  it("garde la journée lisible en étroit", () => {
    mount(820);

    const panel = dayPanel();
    expect(within(panel).getByText("Journée")).toBeTruthy();
    expect(screen.getByTestId("day-heading").className).toContain("truncate");
    expect(within(panel).getByText("Point maquettes v3")).toBeTruthy();
  });
});

describe("Agenda PC · vue mois", () => {
  it("sélectionne le jour depuis la case entière", () => {
    mount(1440);

    const target = isoInDays(1);
    const cell = monthGrid().querySelector(`[data-date="${target}"]`);
    expect(cell).toBeTruthy();

    fireEvent.click(cell!);

    expect(within(dayPanel()).getByText("Daily équipe mobile")).toBeTruthy();
    expect(within(dayPanel()).queryByText("Point maquettes v3")).toBeNull();
  });

  it("crée un rendez-vous depuis le « + » d'une case", () => {
    const { onNewEvent } = mount(1440);

    const target = isoInDays(2);
    fireEvent.click(screen.getByRole("button", { name: `Ajouter un rendez-vous le ${target}` }));

    expect(onNewEvent).toHaveBeenCalledTimes(1);
  });
});

describe("Agenda PC · navigation entre les vues", () => {
  it("bascule mois → semaine → jour → liste → mois", async () => {
    mount(1440);

    fireEvent.click(screen.getByTestId("view-week"));
    await waitFor(() => expect(screen.getByTestId("week-view")).toBeTruthy());
    expect(screen.queryByTestId("month-grid")).toBeNull();
    expect(screen.getByTestId("week-grid")).toBeTruthy();
    expect(screen.getByTestId("mini-month")).toBeTruthy();

    fireEvent.click(screen.getByTestId("view-day"));
    await waitFor(() => expect(screen.getByTestId("day-view")).toBeTruthy());
    expect(screen.queryByTestId("week-view")).toBeNull();

    fireEvent.click(screen.getByTestId("view-list"));
    await waitFor(() => expect(screen.getByTestId("list-view")).toBeTruthy());

    fireEvent.click(screen.getByTestId("view-month"));
    await waitFor(() => expect(screen.getByTestId("month-grid")).toBeTruthy());
    expect(screen.queryByTestId("list-view")).toBeNull();
    expect(screen.queryByTestId("mini-month")).toBeNull();
  });

  it("garde une seule vue montée et dans le flux pendant la transition", async () => {
    mount(1440);

    const viewport = screen.getByTestId("grid-viewport");
    const frame = () => viewport.firstElementChild as HTMLElement;
    expect(frame().className).toContain("h-full");
    expect(frame().className).not.toContain("absolute");

    fireEvent.click(screen.getByTestId("view-week"));

    expect(viewport.children).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("week-view")).toBeTruthy());
    expect(viewport.children).toHaveLength(1);
    expect(screen.queryByTestId("month-grid")).toBeNull();
  });

  it("avance d'un mois avec la flèche suivante", () => {
    mount(1440);

    expect(periodLabel()).toBe(`${monthLabel(CURRENT_MONTH)} ${CURRENT_YEAR}`);

    fireEvent.click(screen.getByRole("button", { name: "Période suivante" }));

    expect(periodLabel()).toBe(NEXT_MONTH_LABEL);
  });

  it("affiche le jour complet sans couper le libellé", async () => {
    mount(1440);

    fireEvent.click(screen.getByTestId("view-day"));
    await waitFor(() => expect(screen.getByTestId("day-view")).toBeTruthy());

    const label = screen.getByTestId("period-label");
    const text = label.textContent ?? "";
    expect(label.className).not.toContain("leading-none");
    expect(label.className).toContain("leading-tight");
    expect(text.toLowerCase()).toContain(new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(new Date()));
    expect(text).toContain(monthLabel(CURRENT_MONTH).toLowerCase());
    expect(text).toContain(String(CURRENT_YEAR));
  });
});

describe("Agenda PC · événements sans calendrier", () => {
  it("masque puis réaffiche les événements sans calendrier", () => {
    seedEvents([
      { id: "orphan", date: TODAY_ISO, start: "09:00", end: "09:30", title: "Sans agenda" },
      { id: "pro", date: TODAY_ISO, start: "11:00", end: "11:30", title: "Avec agenda", calendar: "Pro" },
    ]);
    mount(1440);

    const filters = screen.getByTestId("calendar-filters");
    expect(within(dayPanel()).getByText("Sans agenda")).toBeTruthy();
    expect(groupCount("Mes calendriers")).toBe(2);
    expect(countOf("Sans calendrier")).toBe(1);

    fireEvent.click(within(filters).getByLabelText("Sans calendrier"));

    expect(within(dayPanel()).queryByText("Sans agenda")).toBeNull();
    expect(within(dayPanel()).getByText("Avec agenda")).toBeTruthy();
    expect(countOf("Sans calendrier")).toBe(1);

    fireEvent.click(within(filters).getByLabelText("Sans calendrier"));

    expect(within(dayPanel()).getByText("Sans agenda")).toBeTruthy();
  });

  it("cache la case quand la période n'a aucun orphelin", () => {
    mount(1440);

    expect(screen.queryByLabelText("Sans calendrier")).toBeNull();
  });
});

describe("Agenda PC · compteurs de filtres", () => {
  it("partitionne les cases : leur somme égale l'en-tête", () => {
    seedEvents([
      {
        id: "mail",
        date: TODAY_ISO,
        start: "10:00",
        end: "11:00",
        title: "Depuis un mail",
        fromMail: true,
        attendees: ["Camille"],
        calendar: "Pro",
      },
      { id: "conflit", date: TODAY_ISO, start: "10:30", end: "11:30", title: "En conflit", attendees: ["Léa"], calendar: "Pro" },
      { id: "invites", date: TODAY_ISO, start: "14:00", end: "15:00", title: "Avec invités", attendees: ["Marie"], calendar: "Pro" },
    ]);
    mount(1440);

    expect(countOf("Depuis un mail")).toBe(1);
    expect(countOf("Conflits")).toBe(1);
    expect(countOf("Avec invités")).toBe(1);
    expect(countOf("Depuis un mail") + countOf("Conflits") + countOf("Avec invités")).toBe(groupCount("Filtres"));
  });
});

describe("Agenda PC · filtres", () => {
  it("masque un calendrier décoché", () => {
    mount(1440);

    expect(within(dayPanel()).getByText("Point maquettes v3")).toBeTruthy();

    const filters = screen.getByTestId("calendar-filters");
    fireEvent.click(within(filters).getByLabelText("Pro"));

    expect(within(dayPanel()).queryByText("Point maquettes v3")).toBeNull();
    expect(within(dayPanel()).getByText("Déjeuner — café des Lilas")).toBeTruthy();
  });

  it("filtre la recherche en direct", () => {
    mount(1440);

    fireEvent.change(screen.getByLabelText("Rechercher"), { target: { value: "déjeuner" } });

    expect(within(dayPanel()).getByText("Déjeuner — café des Lilas")).toBeTruthy();
    expect(within(dayPanel()).queryByText("Point maquettes v3")).toBeNull();
  });
});

describe("Agenda PC · groupes de filtres repliables", () => {
  it("présente les deux groupes dépliés par défaut", () => {
    mount(1440);

    expect(groupToggle("Mes calendriers").getAttribute("aria-expanded")).toBe("true");
    expect(groupToggle("Filtres").getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByTestId("calendar-filters")).getByLabelText("Pro")).toBeTruthy();
    expect(screen.getByLabelText("Conflits")).toBeTruthy();
  });

  it("replie puis déplie chaque groupe au clic", () => {
    mount(1440);

    fireEvent.click(groupToggle("Mes calendriers"));
    expect(groupToggle("Mes calendriers").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("calendar-filters")).toBeNull();

    fireEvent.click(groupToggle("Mes calendriers"));
    expect(groupToggle("Mes calendriers").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("calendar-filters")).toBeTruthy();

    fireEvent.click(groupToggle("Filtres"));
    expect(groupToggle("Filtres").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Conflits")).toBeNull();

    fireEvent.click(groupToggle("Filtres"));
    expect(groupToggle("Filtres").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Conflits")).toBeTruthy();
  });

  it("filtre toujours après un repli puis dépli", () => {
    mount(1440);

    expect(within(dayPanel()).getByText("Point maquettes v3")).toBeTruthy();

    fireEvent.click(groupToggle("Mes calendriers"));
    fireEvent.click(groupToggle("Mes calendriers"));
    fireEvent.click(within(screen.getByTestId("calendar-filters")).getByLabelText("Pro"));

    expect(within(dayPanel()).queryByText("Point maquettes v3")).toBeNull();
    expect(within(dayPanel()).getByText("Déjeuner — café des Lilas")).toBeTruthy();
  });
});

describe("Agenda PC · dialogue de rendez-vous", () => {
  it("crée un rendez-vous et ferme le dialogue", () => {
    const { onClose } = mountDialog(null);

    expect(screen.getByTestId("event-dialog")).toBeTruthy();
    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Nouveau test" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    const created = probeTitles().filter((line) => line.startsWith("Nouveau test"));
    expect(created).toHaveLength(1);
    expect(created[0]).toContain(TODAY_ISO);
    expect(created[0]).toContain("Pro");
  });

  it("préremplit la date depuis initialDate", () => {
    mountDialog(null, isoInDays(3));

    expect((screen.getByTestId("event-date-input") as HTMLInputElement).value).toBe(isoInDays(3));
  });

  it("préremplit date et heure depuis un créneau cliqué (YYYY-MM-DDTHH:MM)", () => {
    mountDialog(null, `${isoInDays(2)}T09:30`);

    expect((screen.getByTestId("event-date-input") as HTMLInputElement).value).toBe(isoInDays(2));
    expect((screen.getByTestId("event-start-input") as HTMLInputElement).value).toBe("09:30");
    expect((screen.getByTestId("event-end-input") as HTMLInputElement).value).toBe("10:30");
  });

  it("ferme sur Échap", () => {
    const { onClose } = mountDialog(null);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("alerte sur un chevauchement sans bloquer la création", () => {
    mountDialog(null);

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Doublon" } });
    fireEvent.change(screen.getByTestId("event-start-input"), { target: { value: "10:00" } });

    expect(screen.getByRole("alert").textContent).toContain("Chevauchement");
    expect(screen.getByTestId("event-end-input")).toHaveProperty("value", "11:00");
    expect((screen.getByRole("button", { name: "Créer le rendez-vous" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("préremplit et enregistre une modification", () => {
    const { onClose } = mountDialog(EVENTS[0]!);

    expect((screen.getByTestId("event-title-input") as HTMLInputElement).value).toBe("Point maquettes v3");
    expect((screen.getByTestId("event-date-input") as HTMLInputElement).value).toBe(TODAY_ISO);
    expect((screen.getByTestId("event-start-input") as HTMLInputElement).value).toBe("10:00");

    fireEvent.change(screen.getByTestId("event-title-input"), { target: { value: "Point maquettes v4" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(probeTitles()).toHaveLength(EVENTS.length);
    expect(probeTitles().filter((line) => line.startsWith("Point maquettes v4"))).toHaveLength(1);
  });

  it("supprime le rendez-vous édité", () => {
    const { onClose } = mountDialog(EVENTS[0]!);

    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(probeTitles()).toHaveLength(EVENTS.length - 1);
    expect(probeTitles().some((line) => line.startsWith("Point maquettes v3"))).toBe(false);
  });

  it("désactive la création sans titre", () => {
    mountDialog(null);

    expect((screen.getByRole("button", { name: "Créer le rendez-vous" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
