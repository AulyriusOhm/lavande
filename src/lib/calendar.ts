export type CalendarEvent = {
  id: string;
  date: string;
  start: string;
  end: string;
  title: string;
  location?: string;
  description?: string;
  tone?: number;
  fromMail?: boolean;
  mailId?: string;
  attendees?: string[];
  calendar?: string;
  /** Événement venu d'un calendrier relu à sa source : affiché, jamais édité ici. */
  external?: boolean;
  /** Règle de récurrence présente dans le fichier : l'occurrence n'est pas développée. */
  recurring?: boolean;
  /**
   * De quoi réécrire un événement CalDAV : `uid` de la ressource et `etag` connu,
   * pour la source du démon qui détient les identifiants. Absent : lecture seule.
   */
  caldav?: CaldavBinding;
};

export type CaldavBinding = {
  sourceId: string;
  uid: string;
  etag?: string;
};

const TODAY = new Date();

export const CURRENT_MONTH = TODAY.getMonth();
export const CURRENT_YEAR = TODAY.getFullYear();

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function isoDay(year: number, month: number, day: number) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export function isoInDays(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return isoDay(date.getFullYear(), date.getMonth(), date.getDate());
}

export const TODAY_ISO = isoInDays(0);

export function capitalizeFirst(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const MONTH_FMT = new Intl.DateTimeFormat("fr-FR", { month: "long" });

export function monthLabel(month: number) {
  return capitalizeFirst(MONTH_FMT.format(new Date(2020, month, 1)));
}

export const EVENTS: CalendarEvent[] = import.meta.env.VITE_DISTRIBUTION === "1" ? [] : [
  {
    id: "e1",
    date: TODAY_ISO,
    start: "10:00",
    end: "10:30",
    title: "Point maquettes v3",
    location: "Visio · Meet",
    fromMail: true,
    mailId: "1",
    attendees: ["Camille Rousseau", "Léa Fontaine"],
    calendar: "Pro",
  },
  {
    id: "e2",
    date: TODAY_ISO,
    start: "12:30",
    end: "14:00",
    title: "Déjeuner — café des Lilas",
    location: "Rue des Lilas, Lyon",
    fromMail: true,
    mailId: "4",
    attendees: ["Léa Fontaine"],
    calendar: "Perso",
  },
  {
    id: "e3",
    date: TODAY_ISO,
    start: "16:00",
    end: "17:00",
    title: "Revue PR feat/imap-sync",
    location: "GitHub",
    attendees: ["Marie"],
    calendar: "Pro",
  },
  {
    id: "e4",
    date: isoInDays(1),
    start: "09:15",
    end: "09:45",
    title: "Daily équipe mobile",
    calendar: "Pro",
  },
  {
    id: "e5",
    date: isoInDays(1),
    start: "14:00",
    end: "15:30",
    title: "Atelier couleur & tokens",
    location: "Studio",
    tone: 4,
    calendar: "Pro",
  },
  {
    id: "e6",
    date: isoInDays(3),
    start: "11:00",
    end: "11:30",
    title: "Signature avenant phase 2",
    location: "Visio",
    tone: 1,
    attendees: ["Marc Delaunay"],
    calendar: "Pro",
  },
  {
    id: "e7",
    date: isoInDays(6),
    start: "18:30",
    end: "20:00",
    title: "Concert — Halle 0",
    calendar: "Perso",
  },
  {
    id: "e8",
    date: isoInDays(8),
    start: "08:00",
    end: "09:00",
    title: "Revue de design système",
    calendar: "Pro",
  },
];

export function monthGrid(year = CURRENT_YEAR, month = CURRENT_MONTH) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const total = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= total; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function daysInMonth(year = CURRENT_YEAR, month = CURRENT_MONTH) {
  return new Date(year, month + 1, 0).getDate();
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Jour réel : « 2026-02-31 » retombe au dernier jour du mois, une valeur libre est ignorée. */
export function clampIsoDay(value: string | undefined) {
  const match = ISO_DAY.exec(value ?? "");
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  const last = daysInMonth(year, month - 1);
  return isoDay(year, month - 1, Math.min(Math.max(Number(match[3]), 1), last));
}

export function isoTime(value: string | undefined) {
  if (!value || !ISO_TIME.test(value)) return undefined;
  return value;
}

export function overlappingEvents(list: CalendarEvent[], date: string, start: string, end: string) {
  return list.filter((event) => event.date === date && event.start < end && start < event.end);
}

export function conflictingIds(list: CalendarEvent[]) {
  const ids = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    for (let other = index + 1; other < list.length; other += 1) {
      const a = list[index];
      const b = list[other];
      if (a.date === b.date && a.start < b.end && b.start < a.end) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}

export const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
