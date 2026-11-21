import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
