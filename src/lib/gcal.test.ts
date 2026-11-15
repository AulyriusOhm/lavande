import { describe, expect, it } from "vitest";
import type { GoogleCalendar } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";
import { googleAutoAttachTarget } from "@/lib/gcal";

const cal = (over: Partial<GoogleCalendar> = {}): GoogleCalendar => ({
  id: "primary@gmail.com",
  summary: "Mon agenda",
  primary: false,
  ...over,
});

const googleDef = (accountId: string, calendarId: string): CalendarDef => ({
  id: `google:${accountId}:${calendarId}`,
  name: "Google",
  tone: 3,
  source: { kind: "google", accountId, calendarId },
});

describe("googleAutoAttachTarget", () => {
  it("attache le calendrier principal quand aucun calendrier du compte n'est présent", () => {
    const list = [cal({ id: "autres", summary: "Autres" }), cal({ id: "main", summary: "Principal", primary: true })];
    expect(googleAutoAttachTarget("acc1", list, [])?.id).toBe("main");
  });

  it("préfère le principal au premier de la liste", () => {
    const list = [cal({ id: "first", summary: "Premier" }), cal({ id: "main", summary: "Principal", primary: true })];
    expect(googleAutoAttachTarget("acc1", list, [])?.id).toBe("main");
  });

  it("retombe sur le premier calendrier sans principal", () => {
    const list = [cal({ id: "first", summary: "Premier" }), cal({ id: "second", summary: "Second" })];
    expect(googleAutoAttachTarget("acc1", list, [])?.id).toBe("first");
  });

  it("n'attache rien si un calendrier du compte est déjà dans l'agenda", () => {
    const list = [cal({ primary: true })];
    expect(googleAutoAttachTarget("acc1", list, [googleDef("acc1", "primary@gmail.com")])).toBeUndefined();
  });

  it("n'attache rien si le nom entre en conflit avec un calendrier existant", () => {
    const list = [cal({ summary: "Mon agenda", primary: true })];
    const existing: CalendarDef[] = [{ id: "local", name: "mon agenda", tone: 0 }];
    expect(googleAutoAttachTarget("acc1", list, existing)).toBeUndefined();
  });

  it("n'attache rien sur une liste vide", () => {
    expect(googleAutoAttachTarget("acc1", [], [])).toBeUndefined();
  });

  it("ignore les calendriers d'un autre compte déjà attachés", () => {
    const list = [cal({ id: "main", primary: true })];
    expect(googleAutoAttachTarget("acc1", list, [googleDef("acc2", "autre")])?.id).toBe("main");
  });
});
