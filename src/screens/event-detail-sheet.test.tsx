import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EventDetailSheet } from "@/screens/event-detail-sheet";
import type { CalendarEvent } from "@/lib/calendar";

const LOCAL: CalendarEvent = {
  id: "e1",
  date: "2026-11-20",
  start: "09:00",
  end: "09:30",
  title: "Standup",
  location: "Visio",
  calendar: "Pro",
  attendees: ["Camille Rousseau"],
};

const ICS: CalendarEvent = {
  id: "ics:exemple-tld:b1",
  date: "2026-11-20",
  start: "11:00",
  end: "12:00",
  title: "Réunion externe",
  location: "Salle 2",
  calendar: "exemple.tld",
  external: true,
};

const CALDAV: CalendarEvent = {
  ...ICS,
  id: "caldav:perso:b1",
  title: "Réunion Zimbra",
  caldav: { sourceId: "src-1", uid: "b1", etag: "etag-1" },
};

const mount = (props: Partial<React.ComponentProps<typeof EventDetailSheet>> = {}) =>
  render(
    <EventDetailSheet
      event={LOCAL}
      conflict={false}
      onClose={() => {}}
      onEdit={() => {}}
      onDelete={async () => {}}
      {...props}
    />,
  );

const deleteDialog = () => screen.getByRole("alertdialog", { name: "Supprimer ce rendez-vous ?" });

beforeEach(() => {
  window.localStorage.clear();
});

describe("Feuille de détail d'un rendez-vous", () => {
  it("affiche le calendrier, la date longue, les horaires, le lieu et les participants", () => {
    mount();

    const sheet = screen.getByRole("dialog", { name: "Détail du rendez-vous" });
    expect(within(sheet).getByText("Pro")).toBeTruthy();
    expect(within(sheet).getByText(/Vendredi 20 novembre 2026/)).toBeTruthy();
    expect(within(sheet).getByText("09:00 → 09:30")).toBeTruthy();
    expect(within(sheet).getByText("Visio")).toBeTruthy();
    expect(within(sheet).getByText("Camille Rousseau")).toBeTruthy();
  });

  it("écrit « Journée entière » pour un événement sans heure", () => {
    mount({ event: { ...LOCAL, start: "", end: "" } });

    expect(screen.getByText("Journée entière")).toBeTruthy();
  });

  it("propose Modifier et Supprimer pour un événement local", () => {
    mount();

    expect(screen.getByRole("button", { name: "Modifier" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Supprimer" })).toBeTruthy();
    expect(screen.queryByText("Lecture seule — géré par la source")).toBeNull();
  });

  it("propose Modifier et Supprimer pour un événement CalDAV", () => {
    mount({ event: CALDAV });

    expect(screen.getByRole("button", { name: "Modifier" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Supprimer" })).toBeTruthy();
  });

  it("reste en lecture seule pour une source ICS ou Google sans binding CalDAV", () => {
    mount({ event: ICS, onEdit: undefined, onDelete: undefined });

    expect(screen.getByText("Lecture seule — géré par la source")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Modifier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Supprimer" })).toBeNull();
  });

  it("ouvre le mail lié quand il est chargé", () => {
    const onOpenMail = vi.fn();
    mount({ onOpenMail });

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le mail" }));

    expect(onOpenMail).toHaveBeenCalledTimes(1);
  });

  it("note qu'une série récurrente se modifie en entier", () => {
    mount({ event: { ...LOCAL, recurring: true } });

    expect(screen.getByText(/la modification porte sur la série entière/)).toBeTruthy();
  });

  it("badge le conflit et le lien mail", () => {
    mount({ event: { ...LOCAL, fromMail: true }, conflict: true });

    expect(screen.getByText("conflit")).toBeTruthy();
    expect(screen.getByText("mail")).toBeTruthy();
  });
});

describe("Feuille de détail · suppression confirmée", () => {
  it("demande confirmation et n'appelle rien sur Annuler", () => {
    const onDelete = vi.fn(async () => {});
    mount({ onDelete });

    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    expect(deleteDialog()).toBeTruthy();

    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Annuler" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("supprime l'événement après confirmation", async () => {
    const onDelete = vi.fn(async () => {});
    mount({ onDelete });

    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Supprimer" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(LOCAL));
  });
});
