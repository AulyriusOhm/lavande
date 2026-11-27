import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewEventSheet } from "@/screens/new-event-sheet";
import { NewTaskSheet } from "@/screens/new-task-sheet";
import { PrefsProvider } from "@/lib/prefs";
import type { CalendarEvent } from "@/lib/calendar";
import type { Task } from "@/lib/tasks";
import type { NewEventDraft } from "@/screens/new-event-sheet";

const CALENDARS_KEY = "lavande.calendars.v1";

beforeEach(() => {
  window.localStorage.clear();
});

const DRAFT: NewEventDraft = {
  title: "Point maquettes v3",
  date: "2026-11-20",
  start: "10:00",
  end: "10:30",
  location: "Visio",
};

const titleInput = () => screen.getByLabelText("Titre") as HTMLInputElement;
const locationInput = () => screen.getByLabelText("Lieu") as HTMLInputElement;
const dateInput = () => screen.getByLabelText("Choisir une date") as HTMLInputElement;

describe("Nouveau rendez-vous mobile · préremplissage par une suggestion", () => {
  it("reprend titre, jour, heure, fin et lieu de la suggestion", () => {
    render(<NewEventSheet onClose={() => {}} onCreate={() => {}} draft={DRAFT} />);

    expect(titleInput().value).toBe("Point maquettes v3");
    expect(dateInput().value).toBe("2026-11-20");
    expect(locationInput().value).toBe("Visio");
    expect(screen.getByText("→ 10:30")).toBeTruthy();
    expect(screen.getByRole("button", { name: "30 min" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("crée l'événement avec le créneau prérempli", () => {
    const onCreate = vi.fn<(event: CalendarEvent) => void>();
    render(<NewEventSheet onClose={() => {}} onCreate={onCreate} draft={DRAFT} />);

    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      title: "Point maquettes v3",
      date: "2026-11-20",
      start: "10:00",
      end: "10:30",
      location: "Visio",
    });
  });

  it("garde la durée de la suggestion même hors des choix proposés", () => {
    render(<NewEventSheet onClose={() => {}} onCreate={() => {}} draft={{ ...DRAFT, end: "10:45" }} />);

    expect(screen.getByText("→ 10:45")).toBeTruthy();
  });

  it("ignore un jour ou des heures inexploitables", () => {
    render(
      <NewEventSheet
        onClose={() => {}}
        onCreate={() => {}}
        initialDate="2026-12-01"
        draft={{ title: "Sans créneau", date: "31/02/2026", start: "25:00", end: "26:00" }}
      />,
    );

    expect(titleInput().value).toBe("Sans créneau");
    expect(dateInput().value).toBe("2026-12-01");
    expect(screen.getByText("→ 11:00")).toBeTruthy();
  });
});

describe("Modifier un rendez-vous mobile", () => {
  const EVENT: CalendarEvent = {
    id: "e1",
    date: "2026-11-20",
    start: "09:00",
    end: "09:30",
    title: "Standup",
    location: "Visio",
    calendar: "Pro",
  };

  it("préremplit les champs de l'événement et propose Enregistrer", () => {
    render(<NewEventSheet onClose={() => {}} onCreate={() => {}} onUpdate={async () => null} event={EVENT} />);

    expect(screen.getByText("Modifier le rendez-vous")).toBeTruthy();
    expect(titleInput().value).toBe("Standup");
    expect(dateInput().value).toBe("2026-11-20");
    expect(locationInput().value).toBe("Visio");
    expect(screen.getByText("→ 09:30")).toBeTruthy();
    expect(screen.getByRole("button", { name: "30 min" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeTruthy();
  });

  it("enregistre la modification de l'événement existant", async () => {
    const onUpdate = vi.fn(async () => null);
    const onClose = vi.fn();
    const onCreate = vi.fn();
    render(<NewEventSheet onClose={onClose} onCreate={onCreate} onUpdate={onUpdate} event={EVENT} />);

    fireEvent.change(titleInput(), { target: { value: "Standup équipe" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect((onUpdate.mock.calls[0] as unknown[])[0]).toMatchObject({
      id: "e1",
      title: "Standup équipe",
      date: "2026-11-20",
      start: "09:00",
      end: "09:30",
      location: "Visio",
      calendar: "Pro",
    });
    expect(onCreate).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("ne se signale pas en conflit avec lui-même", () => {
    const onUpdate = vi.fn(async () => null);
    render(<NewEventSheet onClose={() => {}} onCreate={() => {}} onUpdate={onUpdate} events={[EVENT]} event={EVENT} />);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Enregistrer quand même" })).toBeNull();
  });

  it("garde la journée entière sans horaires", () => {
    render(
      <NewEventSheet
        onClose={() => {}}
        onCreate={() => {}}
        onUpdate={async () => null}
        event={{ ...EVENT, start: "", end: "" }}
      />,
    );

    expect(screen.getByText(/Journée entière · les horaires ne s'appliquent pas/)).toBeTruthy();
    expect(screen.queryByText("Heure")).toBeNull();
    expect(screen.queryByText("Durée")).toBeNull();
  });

  it("affiche l'échec d'écriture et garde la feuille ouverte", async () => {
    const onClose = vi.fn();
    render(
      <NewEventSheet
        onClose={onClose}
        onCreate={() => {}}
        onUpdate={async () => "Calendrier CalDAV · 412"}
        event={EVENT}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Calendrier CalDAV · 412"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Nouveau rendez-vous mobile · calendriers réels", () => {
  const seed = () =>
    window.localStorage.setItem(
      CALENDARS_KEY,
      JSON.stringify([
        { id: "boulot", name: "Boulot", tone: 1 },
        { id: "famille", name: "Famille", tone: 2 },
      ]),
    );

  it("affiche les calendriers enregistrés et présélectionne le premier", () => {
    seed();
    const onCreate = vi.fn<(event: CalendarEvent) => void>();
    render(<NewEventSheet onClose={() => {}} onCreate={onCreate} />);

    expect(screen.queryByRole("button", { name: "Gmail" })).toBeNull();
    expect(screen.getByRole("button", { name: "Boulot" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Famille" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(titleInput(), { target: { value: "Point" } });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(onCreate.mock.calls[0][0].calendar).toBe("Boulot");
  });

  it("crée dans le calendrier choisi", () => {
    seed();
    const onCreate = vi.fn<(event: CalendarEvent) => void>();
    render(<NewEventSheet onClose={() => {}} onCreate={onCreate} />);

    fireEvent.change(titleInput(), { target: { value: "Déjeuner" } });
    fireEvent.click(screen.getByRole("button", { name: "Famille" }));
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(onCreate.mock.calls[0][0].calendar).toBe("Famille");
  });
});

describe("Nouvelle tâche mobile · préremplissage par NewTaskDraft", () => {
  it("préremplit la feuille, affiche le mail lié et attache mailId à la tâche créée", () => {
    const onCreate = vi.fn<(task: Task) => void>();
    render(
      <PrefsProvider>
        <NewTaskSheet
          draft={{
            title: "Envoyer l'avenant",
            description: "Signature attendue",
            dueDate: "2026-11-28",
            assignee: "Marc",
            mailId: "3",
            mailFrom: "Marc Delaunay",
            mailSubject: "Devis signé — retour de ma part",
          }}
          onClose={() => {}}
          onCreate={onCreate}
        />
      </PrefsProvider>,
    );

    expect((screen.getByLabelText("Intitulé") as HTMLInputElement).value).toBe("Envoyer l'avenant");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Signature attendue");
    expect((screen.getByLabelText("Choisir une date") as HTMLInputElement).value).toBe("2026-11-28");
    expect((screen.getByLabelText("Assignée à") as HTMLInputElement).value).toBe("Marc");
    expect(screen.getByText("Mail lié")).toBeTruthy();
    expect(screen.getByText("Marc Delaunay")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Créer la tâche" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      title: "Envoyer l'avenant",
      dueDate: "2026-11-28",
      assignee: "Marc",
      mailId: "3",
      meta: "mail · Marc Delaunay",
    });
  });
});

describe("Nouveau rendez-vous mobile · invités", () => {
  it("transmet les adresses saisies, sans doublon", () => {
    const onCreate = vi.fn<(event: CalendarEvent) => void>();
    render(<NewEventSheet onClose={() => {}} onCreate={onCreate} draft={DRAFT} />);

    fireEvent.change(screen.getByLabelText("Invités"), {
      target: { value: "camille@studio-lilas.fr, Marc <marc@mail.fr>, camille@studio-lilas.fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Créer le rendez-vous" }));

    expect(onCreate.mock.calls[0][0].attendees).toEqual([
      "camille@studio-lilas.fr",
      "marc@mail.fr",
    ]);
  });

  it("préremplit les invités d'un rendez-vous existant", () => {
    render(
      <NewEventSheet
        onClose={() => {}}
        onCreate={() => {}}
        event={{
          id: "e-1",
          date: "2026-11-20",
          start: "10:00",
          end: "11:00",
          title: "Revue",
          attendees: ["camille@studio-lilas.fr"],
        }}
      />,
    );

    expect((screen.getByLabelText("Invités") as HTMLInputElement).value).toBe("camille@studio-lilas.fr");
  });
});
