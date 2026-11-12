import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/lib/calendar";
import {
  DAY_END_MIN,
  DAY_START_MIN,
  PX_PER_MIN,
  addDaysISO,
  blockGeometry,
  filterEvents,
  layoutDay,
  miniMonthCells,
  minutesOf,
  periodLabel,
  sameWeek,
  shiftAnchor,
  timeOf,
  upcomingEvents,
  weekDaysISO,
  weekStartISO,
} from "@/lib/calendar-views";

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e0",
  date: "2026-11-12",
  start: "09:00",
  end: "10:00",
  title: "Rendez-vous",
  ...over,
});

describe("calendar-views · constantes", () => {
  it("borne la journée de 8 h à 20 h avec 60 px par heure", () => {
    expect(DAY_START_MIN).toBe(480);
    expect(DAY_END_MIN).toBe(1200);
    expect(PX_PER_MIN).toBe(1);
  });
});

describe("calendar-views · heures", () => {
  it("convertit une heure en minutes", () => {
    expect(minutesOf("00:00")).toBe(0);
    expect(minutesOf("09:15")).toBe(555);
    expect(minutesOf("20:00")).toBe(1200);
  });

  it("fait un aller-retour minutes → heure → minutes", () => {
    for (const minutes of [0, 1, 60, 480, 555, 719, 1200, 1439]) {
      expect(minutesOf(timeOf(minutes))).toBe(minutes);
    }
  });

  it("formate en HH:MM et borne la journée", () => {
    expect(timeOf(555)).toBe("09:15");
    expect(timeOf(0)).toBe("00:00");
    expect(timeOf(-30)).toBe("00:00");
    expect(timeOf(24 * 60 + 90)).toBe("24:00");
  });
});

describe("calendar-views · dates", () => {
  it("décale une date en jours", () => {
    expect(addDaysISO("2026-11-12", 1)).toBe("2026-11-13");
    expect(addDaysISO("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("ramène au lundi de la semaine", () => {
    expect(weekStartISO("2026-11-11")).toBe("2026-11-09");
    expect(weekStartISO("2026-11-09")).toBe("2026-11-09");
    expect(weekStartISO("2026-11-15")).toBe("2026-11-09");
  });

  it("liste les sept jours de la semaine", () => {
    expect(weekDaysISO("2026-11-12")).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(sameWeek("2026-11-09", "2026-11-15")).toBe(true);
    expect(sameWeek("2026-11-15", "2026-11-16")).toBe(false);
  });
});

describe("calendar-views · libellés de période", () => {
  it("nomme le mois", () => {
    expect(periodLabel("month", "2026-11-12")).toBe("Novembre 2026");
  });

  it("nomme la semaine", () => {
    expect(periodLabel("week", "2026-11-12")).toBe("9 – 15 novembre 2026");
    expect(periodLabel("week", "2026-12-02")).toBe("30 novembre – 6 décembre 2026");
    expect(periodLabel("week", "2026-12-30")).toBe("28 décembre 2026 – 3 janvier 2027");
  });

  it("nomme le jour", () => {
    expect(periodLabel("day", "2026-11-12")).toBe("jeudi 12 novembre 2026");
  });

  it("nomme la liste", () => {
    expect(periodLabel("list", "2026-11-12")).toBe("À venir");
  });
});

describe("calendar-views · navigation", () => {
  it("décale d'un mois en bornant le jour", () => {
    expect(shiftAnchor("month", "2026-11-12", 1)).toBe("2026-12-12");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftAnchor("list", "2026-11-12", -1)).toBe("2026-10-12");
  });

  it("décale d'une semaine ou d'un jour", () => {
    expect(shiftAnchor("week", "2026-11-12", 1)).toBe("2026-11-19");
    expect(shiftAnchor("week", "2026-11-12", -2)).toBe("2026-10-29");
    expect(shiftAnchor("day", "2026-11-12", -1)).toBe("2026-11-11");
  });
});

describe("calendar-views · chevauchements", () => {
  it("met deux événements simultanés sur deux colonnes", () => {
    const layout = layoutDay([
      event({ id: "a", start: "09:00", end: "10:00" }),
      event({ id: "b", start: "09:30", end: "10:30" }),
    ]);

    expect(layout.get("a")).toEqual({ col: 0, cols: 2 });
    expect(layout.get("b")).toEqual({ col: 1, cols: 2 });
  });

  it("libère la colonne dès qu'un événement est fini", () => {
    const layout = layoutDay([
      event({ id: "a", start: "09:00", end: "09:30" }),
      event({ id: "b", start: "09:15", end: "09:45" }),
      event({ id: "c", start: "09:30", end: "10:00" }),
    ]);

    expect(layout.get("a")).toEqual({ col: 0, cols: 2 });
    expect(layout.get("b")).toEqual({ col: 1, cols: 2 });
    expect(layout.get("c")).toEqual({ col: 0, cols: 2 });
  });

  it("laisse une seule colonne sans chevauchement", () => {
    const layout = layoutDay([
      event({ id: "a", start: "09:00", end: "10:00" }),
      event({ id: "b", start: "10:00", end: "11:00" }),
    ]);

    expect(layout.get("a")).toEqual({ col: 0, cols: 1 });
    expect(layout.get("b")).toEqual({ col: 0, cols: 1 });
  });
});

describe("calendar-views · géométrie", () => {
  it("place un bloc depuis le début de journée", () => {
    expect(blockGeometry(event({ start: "09:00", end: "10:00" }), DAY_START_MIN, PX_PER_MIN)).toEqual({
      top: 60,
      height: 58,
    });
    expect(blockGeometry(event({ start: "08:00", end: "08:30" }))).toEqual({ top: 0, height: 28 });
  });

  it("garde une hauteur minimale pour un bloc très court", () => {
    expect(blockGeometry(event({ start: "09:00", end: "09:05" })).height).toBe(20);
  });
});

describe("calendar-views · filtres", () => {
  const events = [
    event({ id: "pro", title: "Point maquettes v3", calendar: "Pro", attendees: ["Camille"] }),
    event({ id: "mail", title: "Déjeuner — café des Lilas", calendar: "Perso", fromMail: true }),
    event({ id: "conflit", title: "Revue PR", calendar: "Pro" }),
  ];
  const conflicts = new Set(["conflit"]);

  it("filtre par calendrier", () => {
    const list = filterEvents(events, { calendars: new Set(["Pro"]) }, conflicts);
    expect(list.map((entry) => entry.id)).toEqual(["pro", "conflit"]);
  });

  it("filtre les événements issus d'un mail", () => {
    const list = filterEvents(events, { fromMail: true }, conflicts);
    expect(list.map((entry) => entry.id)).toEqual(["mail"]);
  });

  it("filtre les conflits et les participants", () => {
    expect(filterEvents(events, { conflictsOnly: true }, conflicts).map((entry) => entry.id)).toEqual(["conflit"]);
    expect(filterEvents(events, { attendeesOnly: true }, conflicts).map((entry) => entry.id)).toEqual(["pro"]);
  });

  it("cherche sans tenir compte de la casse ni des accents", () => {
    expect(filterEvents(events, { query: "MAQUETTES" }, conflicts).map((entry) => entry.id)).toEqual(["pro"]);
    expect(filterEvents(events, { query: "dejeuner" }, conflicts).map((entry) => entry.id)).toEqual(["mail"]);
    expect(filterEvents(events, { query: "  " }, conflicts)).toHaveLength(3);
  });
});

describe("calendar-views · à venir", () => {
  it("garde les événements à partir de la date et trie par date puis heure", () => {
    const list = upcomingEvents(
      [
        event({ id: "futur", date: "2026-11-13", start: "09:00" }),
        event({ id: "passe", date: "2026-11-11", start: "09:00" }),
        event({ id: "tard", date: "2026-11-12", start: "16:00" }),
        event({ id: "tot", date: "2026-11-12", start: "08:00" }),
      ],
      "2026-11-12",
    );

    expect(list.map((entry) => entry.id)).toEqual(["tot", "tard", "futur"]);
  });
});

describe("calendar-views · mini-mois", () => {
  it("réutilise la grille du mois", () => {
    const cells = miniMonthCells(2026, 10);
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((cell) => cell !== null)).toHaveLength(30);
    expect(cells[0]).toBeNull();
    expect(cells[6]).toBe(1);
  });
});
