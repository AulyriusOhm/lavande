import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewEventSheet } from "@/screens/new-event-sheet";
import type { CalendarEvent } from "@/lib/calendar";
import type { NewEventDraft } from "@/screens/new-event-sheet";

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
