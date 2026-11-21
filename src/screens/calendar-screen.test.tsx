import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CalendarScreen } from "@/screens/calendar-screen";
import { TODAY_ISO, type CalendarEvent } from "@/lib/calendar";
import { agendaCalendars, loadCalendars } from "@/lib/calendars";
import { externalCalendarEvents, loadIcsState } from "@/lib/ics";
import { MAIL_SUGGESTIONS, type MailSuggestion } from "@/lib/tasks";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const MEETING: MailSuggestion = {
  ...MAIL_SUGGESTIONS[0],
  id: "sg-rdv",
  kind: "event",
  account: "perso",
  mailId: "1",
  from: "Camille Rousseau",
  proposal: "Atelier budget",
  due: "",
  dueTone: "none",
  date: "2026-11-20",
  start: "10:00",
  end: "10:30",
  location: "Visio",
  timestamp: Date.now(),
};

const EVENT: CalendarEvent = {
  id: "e1",
  date: TODAY_ISO,
  start: "09:00",
  end: "09:30",
  title: "Standup",
};

function MailProbe() {
  const { openMail } = useMailStore();
  return <span data-testid="open-mail">{openMail?.id ?? "aucun"}</span>;
}

function mount({
  suggestions = [] as MailSuggestion[],
  onAcceptSuggestion,
  onDismissSuggestion,
  onOpenEvent,
  events = [] as CalendarEvent[],
  externalEvents = [] as CalendarEvent[],
  sourceCount = 0,
}: {
  suggestions?: MailSuggestion[];
  onAcceptSuggestion?: (draft: Record<string, string | undefined>) => void;
  onDismissSuggestion?: (suggestion: MailSuggestion) => void;
  onOpenEvent?: (event: CalendarEvent) => void;
  events?: CalendarEvent[];
  externalEvents?: CalendarEvent[];
  sourceCount?: number;
} = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
  return render(
    <>
      <MailProbe />
      <CalendarScreen
        events={events}
        externalEvents={externalEvents}
        sourceCount={sourceCount}
        suggestions={suggestions}
        onAcceptSuggestion={onAcceptSuggestion}
        onDismissSuggestion={onDismissSuggestion}
        onOpenEvent={onOpenEvent}
      />
    </>,
    { wrapper },
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

describe("Agenda mobile · suggestions de rendez-vous", () => {
  it("affiche le groupe « Suggestions de RDV » avec son compte et son créneau", () => {
    mount({ suggestions: [MEETING], events: [EVENT] });

    const group = screen.getByTestId("event-suggestions");
    expect(within(group).getByText("Suggestions de RDV")).toBeTruthy();
    expect(within(group).getByText("1 proposition")).toBeTruthy();
    const row = within(group).getByTestId("event-suggestion-card");
    expect(within(row).getByTestId("event-suggestion-account").textContent).toBe("Perso");
    const when = within(row).getByTestId("event-suggestion-when");
    expect(within(when).getByText("10:00")).toBeTruthy();
    expect(within(when).getByText("ven. 20")).toBeTruthy();
    expect(row.textContent).toContain("Atelier budget");
    expect(row.textContent).toContain("Camille Rousseau");
    expect(row.textContent).toContain("Visio");
  });

  it("aligne la suggestion sur la colonne horaire : début proposé et date courte", () => {
    mount({ suggestions: [MEETING] });

    const row = screen.getByTestId("event-suggestion-card");
    const when = within(row).getByTestId("event-suggestion-when");
    expect(within(when).getByText("10:00")).toBeTruthy();
    expect(within(when).getByText("ven. 20")).toBeTruthy();
    expect(within(row).getByText("Atelier budget")).toBeTruthy();
  });

  it("garde Accepter et Ignorer cliquables dans la rangée", () => {
    const onAcceptSuggestion = vi.fn();
    const onDismissSuggestion = vi.fn();
    mount({ suggestions: [MEETING], onAcceptSuggestion, onDismissSuggestion });

    const row = screen.getByTestId("event-suggestion-card");
    fireEvent.click(within(row).getByRole("button", { name: "Accepter : Atelier budget" }));
    fireEvent.click(within(row).getByRole("button", { name: "Ignorer la suggestion" }));

    expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
    expect(onDismissSuggestion).toHaveBeenCalledWith(MEETING);
  });

  it("masque l'icône du mail quand le mail source n'est pas chargé", () => {
    mount({ suggestions: [{ ...MEETING, mailId: "absent" }] });

    const row = screen.getByTestId("event-suggestion-card");
    expect(within(row).queryByRole("button", { name: "Ouvrir le mail" })).toBeNull();
  });

  it("garde les suggestions de RDV hors de la liste du jour", () => {
    mount({ suggestions: [MEETING], events: [EVENT] });

    expect(screen.getByText("Standup")).toBeTruthy();
    expect(screen.getByText("1 événement")).toBeTruthy();
  });

  it("n'affiche ni groupe ni carte quand il n'y a aucune suggestion de RDV", () => {
    mount({ suggestions: [{ ...MAIL_SUGGESTIONS[0], kind: undefined }], events: [EVENT] });

    expect(screen.queryByTestId("event-suggestions")).toBeNull();
    expect(screen.queryByTestId("event-suggestion-card")).toBeNull();
  });

  it("remonte le créneau complet au moment d'accepter", () => {
    const onAcceptSuggestion = vi.fn();
    mount({ suggestions: [MEETING], onAcceptSuggestion });

    fireEvent.click(screen.getByRole("button", { name: "Accepter : Atelier budget" }));

    expect(onAcceptSuggestion).toHaveBeenCalledWith({
      title: "Atelier budget",
      date: "2026-11-20",
      start: "10:00",
      end: "10:30",
      location: "Visio",
    });
  });

  it("ouvre le mail d'origine depuis la carte", () => {
    mount({ suggestions: [MEETING] });

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le mail" }));

    expect(screen.getByTestId("open-mail").textContent).toBe("1");
  });

  it("ignore une suggestion", () => {
    const onDismissSuggestion = vi.fn();
    mount({ suggestions: [MEETING], onDismissSuggestion });

    fireEvent.click(screen.getByRole("button", { name: "Ignorer la suggestion" }));

    expect(onDismissSuggestion).toHaveBeenCalledWith(MEETING);
  });
});

const CALENDARS_KEY = "lavande.calendars.v1";
const ICS_KEY = "lavande.ics.v1";
const PREFS_KEY = "lavande.prefs";

/** Une source ICS active, un événement Google coupé par le périmètre du compte. */
function seedExternalSources() {
  window.localStorage.setItem(
    CALENDARS_KEY,
    JSON.stringify([
      { id: "pro", name: "Pro", tone: 0 },
      { id: "exemple-tld", name: "exemple.tld", tone: 1, source: { kind: "ics", url: "https://exemple.tld/cal.ics" } },
      { id: "gmail", name: "Agenda Gmail", tone: 3, source: { kind: "google", accountId: "perso", calendarId: "agenda" } },
    ]),
  );
  window.localStorage.setItem(
    ICS_KEY,
    JSON.stringify({
      events: {
        "exemple-tld": [
          { id: "ics:exemple-tld:b1", date: TODAY_ISO, start: "11:00", end: "12:00", title: "Réunion externe", external: true },
          { id: "ics:exemple-tld:b2", date: TODAY_ISO, start: "", end: "", title: "Journée off", external: true },
        ],
        gmail: [
          { id: "google:gmail:g1", date: TODAY_ISO, start: "15:00", end: "16:00", title: "Réunion Google", external: true },
        ],
      },
      synced: { "exemple-tld": Date.now(), gmail: Date.now() },
    }),
  );
  window.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({ perimeters: { perso: { mails: true, calendar: false, contacts: false } } }),
  );
  return externalCalendarEvents(loadIcsState(), agendaCalendars(loadCalendars()));
}

describe("Agenda mobile · rangées du jour", () => {
  it("colore la pastille du ton du calendrier de l'événement", () => {
    mount({ events: [{ ...EVENT, calendar: "Perso" }] });

    const row = screen.getByTestId("calendar-event");
    expect(row.querySelector(".bg-emerald-500")).toBeTruthy();
  });

  it("montre le badge récurrent et la micro-icône du mail lié", () => {
    mount({ events: [{ ...EVENT, recurring: true, fromMail: true, mailId: "1" }] });

    const row = screen.getByTestId("calendar-event");
    expect(within(row).getByRole("img", { name: "Récurrent" })).toBeTruthy();
    expect(within(row).getByRole("img", { name: "Mail lié" })).toBeTruthy();
  });

  it("signale un chevauchement par l'icône de conflit", () => {
    mount({
      events: [EVENT, { ...EVENT, id: "e2", title: "Point client", start: "09:15", end: "10:00" }],
    });

    expect(screen.getAllByRole("img", { name: "Conflit" })).toHaveLength(2);
  });

  it("écrit « jour » en colonne horaire d'un événement sans heure", () => {
    mount({ events: [{ ...EVENT, start: "", end: "", title: "Journée off" }] });

    const row = screen.getByTestId("calendar-event");
    expect(within(row).getByText("jour")).toBeTruthy();
    expect(within(row).getByText("Journée entière")).toBeTruthy();
    expect(within(row).queryByText("09:00")).toBeNull();
  });

  it("ouvre le détail d'un événement au tap sur la rangée", () => {
    const onOpenEvent = vi.fn();
    mount({ events: [EVENT], onOpenEvent });

    fireEvent.click(screen.getByTestId("calendar-event"));

    expect(onOpenEvent).toHaveBeenCalledWith(EVENT);
  });
});

describe("Agenda mobile · sources externes", () => {
  it("ajoute l'événement externe au fil du jour avec son badge ICS", () => {
    mount({ events: [EVENT], externalEvents: seedExternalSources() });

    expect(screen.getByText("Réunion externe")).toBeTruthy();
    expect(screen.getByText("3 événements")).toBeTruthy();
    const badges = screen.getAllByTestId("external-badge");
    expect(badges.map((badge) => badge.textContent)).toEqual(["ICS", "ICS"]);
  });

  it("compte l'événement externe dans la grille du mois", () => {
    mount({ events: [], externalEvents: seedExternalSources() });

    const cell = screen.getByRole("button", { pressed: true });
    expect(cell.getAttribute("aria-label")).toContain("2 événements");
  });

  it("écrit « Journée entière » pour un événement sans heure", () => {
    mount({ externalEvents: seedExternalSources() });

    expect(screen.getByText("Journée entière")).toBeTruthy();
    expect(screen.getByText("Réunion externe")).toBeTruthy();
  });

  it("reste en lecture seule : ni édition ni suppression", () => {
    mount({ externalEvents: seedExternalSources() });

    const title = screen.getByText("Réunion externe");
    expect(title.closest("[role='button']")).toBeNull();
    expect(screen.queryByRole("button", { name: /Supprimer|Modifier|Éditer|Modifier l'événement/ })).toBeNull();
  });

  it("n'affiche pas une source coupée par le périmètre du compte", () => {
    mount({ externalEvents: seedExternalSources() });

    expect(screen.queryByText("Réunion Google")).toBeNull();
    expect(screen.queryByText("Agenda Gmail")).toBeNull();
  });
});

describe("Agenda mobile · pied de page des sources", () => {
  it("n'annonce aucune source externe sans abonnement", () => {
    mount({ events: [EVENT] });

    expect(screen.getByText("Aucune source externe · 3 comptes")).toBeTruthy();
  });

  it("accorde une source au singulier", () => {
    mount({ sourceCount: 1 });

    expect(screen.getByText("1 source externe · 3 comptes")).toBeTruthy();
  });

  it("accorde plusieurs sources au pluriel", () => {
    mount({ sourceCount: 2 });

    expect(screen.getByText("2 sources externes · 3 comptes")).toBeTruthy();
  });
});
