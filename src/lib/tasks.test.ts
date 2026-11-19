import { describe, expect, it } from "vitest";
import { MAIL_SUGGESTIONS, draftFromSuggestion, taskFromSuggestion, type MailSuggestion } from "@/lib/tasks";

const MEETING: MailSuggestion = {
  ...MAIL_SUGGESTIONS[0],
  kind: "event",
  proposal: "Atelier budget",
  date: "2026-11-20",
  start: "10:00",
  end: "10:30",
  location: "Visio",
};

describe("draftFromSuggestion · suggestion de rendez-vous → créneau de création", () => {
  it("reprend titre, jour, heures et lieu", () => {
    expect(draftFromSuggestion(MEETING)).toEqual({
      title: "Atelier budget",
      date: "2026-11-20",
      start: "10:00",
      end: "10:30",
      location: "Visio",
    });
  });

  it("ne garde que le titre quand la suggestion n'a pas de créneau", () => {
    expect(
      draftFromSuggestion({ ...MEETING, date: undefined, start: undefined, end: undefined, location: undefined }),
    ).toEqual({ title: "Atelier budget" });
  });

  it("ramène un jour hors calendrier au dernier jour du mois", () => {
    expect(draftFromSuggestion({ ...MEETING, date: "2026-02-31", location: undefined }).date).toBe("2026-02-28");
  });

  it("jette un jour ou des heures inexploitables", () => {
    const draft = draftFromSuggestion({ ...MEETING, date: "31/02/2026", start: "25:00", end: "26:00", location: "" });

    expect(draft).toEqual({ title: "Atelier budget" });
  });

  it("abandonne la fin quand elle ne suit pas le début", () => {
    expect(draftFromSuggestion({ ...MEETING, start: "11:00", end: "10:00" })).toMatchObject({
      start: "11:00",
    });
    expect(draftFromSuggestion({ ...MEETING, start: "11:00", end: "10:00" })).not.toHaveProperty("end");
  });

  it("abandonne une fin sans début", () => {
    expect(draftFromSuggestion({ ...MEETING, start: undefined, end: "10:30" })).not.toHaveProperty("end");
  });

  it("ignore le lieu vide", () => {
    expect(draftFromSuggestion({ ...MEETING, location: "" })).not.toHaveProperty("location");
  });
});

describe("taskFromSuggestion · assigné", () => {
  it("reprend l'assigné de la suggestion", () => {
    expect(taskFromSuggestion({ ...MAIL_SUGGESTIONS[0], assignee: "Stéphane" }, "t-sugg").assignee).toBe("Stéphane");
  });

  it("n'ajoute aucun champ assigné quand la suggestion n'en porte pas", () => {
    expect(taskFromSuggestion(MAIL_SUGGESTIONS[0], "t-sugg")).not.toHaveProperty("assignee");
  });
});
