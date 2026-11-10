export type CalendarEvent = {
  id: string;
  day: number;
  start: string;
  end: string;
  title: string;
  location?: string;
  tone: number;
  fromMail?: boolean;
  attendees?: string[];
};

const TODAY = new Date();

export const CURRENT_MONTH = TODAY.getMonth();
export const CURRENT_YEAR = TODAY.getFullYear();
export const TODAY_DATE = TODAY.getDate();

export const MONTH_LABEL = new Intl.DateTimeFormat("fr-FR", {
  month: "long",
  year: "numeric",
}).format(new Date(CURRENT_YEAR, CURRENT_MONTH, 1));

export const EVENTS: CalendarEvent[] = [
  {
    id: "e1",
    day: TODAY_DATE,
    start: "10:00",
    end: "10:30",
    title: "Point maquettes v3",
    location: "Visio · Meet",
    tone: 0,
    fromMail: true,
    attendees: ["Camille Rousseau", "Léa Fontaine"],
  },
  {
    id: "e2",
    day: TODAY_DATE,
    start: "12:30",
    end: "14:00",
    title: "Déjeuner — café des Lilas",
    location: "Rue des Lilas, Lyon",
    tone: 3,
    fromMail: true,
    attendees: ["Léa Fontaine"],
  },
  {
    id: "e3",
    day: TODAY_DATE,
    start: "16:00",
    end: "17:00",
    title: "Revue PR feat/imap-sync",
    location: "GitHub",
    tone: 2,
    attendees: ["Marie"],
  },
  {
    id: "e4",
    day: TODAY_DATE + 1,
    start: "09:15",
    end: "09:45",
    title: "Daily équipe mobile",
    tone: 0,
  },
  {
    id: "e5",
    day: TODAY_DATE + 1,
    start: "14:00",
    end: "15:30",
    title: "Atelier couleur & tokens",
    location: "Studio",
    tone: 4,
    fromMail: true,
  },
  {
    id: "e6",
    day: TODAY_DATE + 3,
    start: "11:00",
    end: "11:30",
    title: "Signature avenant phase 2",
    location: "Visio",
    tone: 1,
    attendees: ["Marc Delaunay"],
  },
  {
    id: "e7",
    day: TODAY_DATE + 6,
    start: "18:30",
    end: "20:00",
    title: "Concert — Halle 0",
    tone: 5,
  },
  {
    id: "e8",
    day: TODAY_DATE + 8,
    start: "08:00",
    end: "09:00",
    title: "Revue de design système",
    tone: 0,
  },
];

export function eventsForDay(day: number) {
  return EVENTS.filter((event) => event.day === day).sort((a, b) => a.start.localeCompare(b.start));
}

export function daysWithEvents() {
  return new Set(EVENTS.map((event) => event.day));
}

export function monthGrid() {
  const first = new Date(CURRENT_YEAR, CURRENT_MONTH, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(CURRENT_YEAR, CURRENT_MONTH + 1, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
