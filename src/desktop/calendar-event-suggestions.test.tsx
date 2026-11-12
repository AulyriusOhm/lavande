import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopApp } from "@/desktop/desktop-shell";
import { DesktopPlanning } from "@/desktop/planning";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { LOCAL_SCHEMA_VERSION, docKey, type Doc } from "@/lib/sync/merge";
import { createDevice, createMemoryStorage, emptyState, type SyncStorage } from "@/lib/sync/storage";
import { isoInDays } from "@/lib/calendar";

vi.stubEnv("VITE_MAIL_BACKEND", "demo");

const MEETING_DAY = isoInDays(2);

function suggestionDoc(id: string, raw: Record<string, unknown>): Doc {
  return {
    id: `sg:${id}`,
    kind: "suggestion",
    v: LOCAL_SCHEMA_VERSION,
    raw: {
      status: "pending",
      mailId: "1",
      account: "perso",
      from: "Camille",
      subject: "Maquettes v3",
      proposal: `Proposition ${id}`,
      due: "",
      dueTone: "none",
      tone: 0,
      description: "",
      ...raw,
    },
    fields: {},
    readOnly: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function eventDoc(id: string, raw: Record<string, unknown> = {}): Doc {
  return suggestionDoc(id, {
    kind: "event",
    proposal: "Atelier budget",
    date: MEETING_DAY,
    start: "10:00",
    end: "10:30",
    location: "Visio",
    ...raw,
  });
}

function seededStorage(docs: Doc[]): SyncStorage {
  const base = emptyState(createDevice("test", "test"));
  return createMemoryStorage({
    ...base,
    docs: Object.fromEntries(docs.map((doc) => [docKey(doc.kind, doc.id), doc])),
  });
}

function Providers({ children, storage }: { children: ReactNode; storage: SyncStorage }) {
  return (
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={storage}>
          <MailStoreProvider>{children}</MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>
  );
}

function Probe() {
  const { events, openMail } = useMailStore();
  return (
    <>
      <span data-testid="open-mail">{openMail?.id ?? "aucun"}</span>
      <ul data-testid="events">
        {events.map((event) => (
          <li key={event.id}>{`${event.title} | ${event.date} | ${event.start} | ${event.end}`}</li>
        ))}
      </ul>
    </>
  );
}

function mountAgenda(docs: Doc[]) {
  const storage = seededStorage(docs);
  window.location.hash = "#calendar";
  render(
    <>
      <Probe />
      <DesktopApp />
    </>,
    { wrapper: ({ children }: { children: ReactNode }) => <Providers storage={storage}>{children}</Providers> },
  );
}

function mountPlanning(docs: Doc[]) {
  render(
    <>
      <Probe />
      <DesktopPlanning onNewTask={() => {}} onOpenSync={() => {}} />
    </>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Providers storage={seededStorage(docs)}>{children}</Providers>
      ),
    },
  );
}

const suggestionCards = () => screen.queryAllByTestId("event-suggestion-card");
const cardOf = (title: string) => {
  const card = suggestionCards().find((entry) => entry.textContent?.includes(title));
  if (!card) throw new Error(`carte introuvable : ${title}`);
  return card;
};
const probeEvents = () =>
  Array.from(screen.getByTestId("events").querySelectorAll("li")).map((item) => item.textContent ?? "");

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "?desktop");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  window.location.hash = "";
});

describe("Agenda desktop · suggestions de rendez-vous", () => {
  it("affiche les suggestions d'événements du planning dans le rail", async () => {
    mountAgenda([eventDoc("s-rdv")]);

    const card = await waitFor(() => cardOf("Atelier budget"));
    expect(within(card).getByTestId("event-suggestion-when").textContent).toContain("10:00 → 10:30");
    expect(card.textContent).toContain("Visio");
    expect(within(card).getByTestId("event-suggestion-account").textContent).toBe("Perso");
    expect(card.textContent).toContain("Camille");
  });

  it("n'affiche ni section ni tâche suggérée parmi les rendez-vous", async () => {
    mountAgenda([suggestionDoc("s-tache", { proposal: "Relancer Marc" })]);

    await waitFor(() => expect(screen.getByTestId("calendar-layout")).toBeTruthy());
    expect(screen.queryByTestId("event-suggestions")).toBeNull();
    expect(suggestionCards()).toHaveLength(0);
  });

  it("ouvre le mail source, et masque le bouton quand il n'est pas chargé", async () => {
    mountAgenda([eventDoc("s-mail"), eventDoc("s-orphelin", { proposal: "Déjeuner", mailId: "absent" })]);

    const carte = await waitFor(() => cardOf("Atelier budget"));
    expect(within(cardOf("Déjeuner")).queryByRole("button", { name: "Ouvrir le mail" })).toBeNull();

    fireEvent.click(within(carte).getByRole("button", { name: "Ouvrir le mail" }));

    expect(screen.getByTestId("open-mail").textContent).toBe("1");
  });

  it("ignore une suggestion", async () => {
    mountAgenda([eventDoc("s-ignore")]);

    const card = await waitFor(() => cardOf("Atelier budget"));
    fireEvent.click(within(card).getByRole("button", { name: "Ignorer la suggestion" }));

    await waitFor(() => expect(suggestionCards()).toHaveLength(0));
  });
});

describe("Agenda desktop · accepter une suggestion de rendez-vous", () => {
  it("préremplit le dialogue de création", async () => {
    mountAgenda([eventDoc("s-accept")]);

    const card = await waitFor(() => cardOf("Atelier budget"));
    fireEvent.click(within(card).getByRole("button", { name: "Accepter : Atelier budget" }));

    expect((screen.getByTestId("event-title-input") as HTMLInputElement).value).toBe("Atelier budget");
    expect((screen.getByTestId("event-date-input") as HTMLInputElement).value).toBe(MEETING_DAY);
    expect((screen.getByTestId("event-start-input") as HTMLInputElement).value).toBe("10:00");
    expect((screen.getByTestId("event-end-input") as HTMLInputElement).value).toBe("10:30");
    expect((screen.getByTestId("event-location-input") as HTMLInputElement).value).toBe("Visio");
    expect(suggestionCards()).toHaveLength(1);
  });

  it("ne retire la suggestion qu'une fois l'événement créé", async () => {
    mountAgenda([eventDoc("s-cree")]);

    const card = await waitFor(() => cardOf("Atelier budget"));
    fireEvent.click(within(card).getByRole("button", { name: "Accepter : Atelier budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    await waitFor(() => expect(suggestionCards()).toHaveLength(0));
    expect(probeEvents().filter((line) => line.startsWith("Atelier budget"))).toContain(
      `Atelier budget | ${MEETING_DAY} | 10:00 | 10:30`,
    );
  });

  it("conserve la suggestion quand le dialogue est annulé", async () => {
    mountAgenda([eventDoc("s-annule")]);

    const card = await waitFor(() => cardOf("Atelier budget"));
    fireEvent.click(within(card).getByRole("button", { name: "Accepter : Atelier budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

    await waitFor(() => expect(screen.queryByTestId("event-dialog")).toBeNull());
    expect(suggestionCards()).toHaveLength(1);
    expect(probeEvents().some((line) => line.startsWith("Atelier budget"))).toBe(false);
  });

  it("ramène un jour invalide au dernier jour du mois", async () => {
    mountAgenda([eventDoc("s-invalide", { date: "2026-02-31" })]);

    const card = await waitFor(() => cardOf("Atelier budget"));
    fireEvent.click(within(card).getByRole("button", { name: "Accepter : Atelier budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(probeEvents()).toContain("Atelier budget | 2026-02-28 | 10:00 | 10:30");
  });
});

describe("Planification desktop · les rendez-vous ne sont pas des tâches", () => {
  it("exclut les suggestions d'événements de la liste des tâches suggérées", () => {
    mountPlanning([
      suggestionDoc("s-tache", { proposal: "Relancer Marc" }),
      eventDoc("s-rdv", { proposal: "Atelier budget" }),
    ]);

    const cards = screen.getAllByTestId("suggestion-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Relancer Marc");
    expect(screen.queryByText("Atelier budget")).toBeNull();
  });
});
