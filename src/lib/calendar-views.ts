import type { CalendarEvent } from "@/lib/calendar";
import { capitalizeFirst, monthGrid } from "@/lib/calendar";

export type ViewMode = "month" | "week" | "day" | "list";

export const DAY_START_MIN = 8 * 60;
export const DAY_END_MIN = 20 * 60;
export const PX_PER_MIN = 1;

const WEEKDAYS_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function parts(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month: month - 1, day };
}

function toDate(iso: string) {
  const { year, month, day } = parts(iso);
  return new Date(year, month, day, 12, 0, 0, 0);
}

function isoFromDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function minutesOf(time: string) {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes ?? 0);
}

export function timeOf(minutes: number) {
  const total = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function addDaysISO(iso: string, count: number) {
  const date = toDate(iso);
  date.setDate(date.getDate() + count);
  return isoFromDate(date);
}

export function weekStartISO(iso: string) {
  const date = toDate(iso);
  return addDaysISO(iso, -((date.getDay() + 6) % 7));
}

export function weekDaysISO(anchorISO: string) {
  const start = weekStartISO(anchorISO);
  return Array.from({ length: 7 }, (_, index) => addDaysISO(start, index));
}

export function sameWeek(aISO: string, bISO: string) {
  return weekStartISO(aISO) === weekStartISO(bISO);
}

function addMonthsISO(iso: string, count: number) {
  const { year, month, day } = parts(iso);
  const target = new Date(year, month + count, 1, 12, 0, 0, 0);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return isoFromDate(new Date(target.getFullYear(), target.getMonth(), Math.min(day, last), 12, 0, 0, 0));
}

function monthName(month: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "long" }).format(new Date(2020, month, 1, 12));
}

export function periodLabel(mode: ViewMode, anchorISO: string, _todayISO?: string, locale = "fr-FR") {
  const anchor = parts(anchorISO);
  if (mode === "month") return `${capitalizeFirst(monthName(anchor.month, locale))} ${anchor.year}`;
  if (mode === "week") {
    const start = parts(weekStartISO(anchorISO));
    const end = parts(addDaysISO(weekStartISO(anchorISO), 6));
    if (start.month === end.month) {
      return `${start.day} – ${end.day} ${monthName(start.month, locale)} ${start.year}`;
    }
    if (start.year === end.year) {
      return `${start.day} ${monthName(start.month, locale)} – ${end.day} ${monthName(end.month, locale)} ${start.year}`;
    }
    return `${start.day} ${monthName(start.month, locale)} ${start.year} – ${end.day} ${monthName(end.month, locale)} ${end.year}`;
  }
  if (mode === "day") {
    return `${capitalizeFirst(WEEKDAYS_LONG[(toDate(anchorISO).getDay() + 6) % 7])} ${anchor.day} ${monthName(anchor.month, locale)} ${anchor.year}`;
  }
  return "À venir";
}

export function shiftAnchor(mode: ViewMode, anchorISO: string, delta: number) {
  if (mode === "week") return addDaysISO(anchorISO, delta * 7);
  if (mode === "day") return addDaysISO(anchorISO, delta);
  return addMonthsISO(anchorISO, delta);
}

export function layoutDay(events: CalendarEvent[]) {
  const out = new Map<string, { col: number; cols: number }>();
  const sorted = [...events].sort(
    (a, b) => minutesOf(a.start) - minutesOf(b.start) || minutesOf(a.end) - minutesOf(b.end),
  );
  let cluster: CalendarEvent[] = [];
  let clusterEnd: number | null = null;

  const flush = () => {
    if (cluster.length === 0) return;
    const colEnds: number[] = [];
    const slots: { id: string; col: number }[] = [];
    for (const event of cluster) {
      const start = minutesOf(event.start);
      const end = minutesOf(event.end);
      const free = colEnds.findIndex((value) => value <= start);
      const col = free === -1 ? colEnds.length : free;
      if (free === -1) {
        colEnds.push(end);
      } else {
        colEnds[free] = end;
      }
      slots.push({ id: event.id, col });
    }
    const cols = Math.max(1, colEnds.length);
    for (const slot of slots) out.set(slot.id, { col: slot.col, cols });
    cluster = [];
    clusterEnd = null;
  };

  for (const event of sorted) {
    const start = minutesOf(event.start);
    const end = minutesOf(event.end);
    if (clusterEnd !== null && start >= clusterEnd) flush();
    cluster.push(event);
    clusterEnd = clusterEnd === null ? end : Math.max(clusterEnd, end);
  }
  flush();

  return out;
}

export function blockGeometry(event: CalendarEvent, dayStartMin = DAY_START_MIN, pxPerMin = PX_PER_MIN) {
  const start = minutesOf(event.start);
  const duration = Math.max(0, minutesOf(event.end) - start);
  return {
    top: (start - dayStartMin) * pxPerMin,
    height: Math.max(20, duration * pxPerMin - 2),
  };
}

export type EventFilters = {
  calendars?: Set<string>;
  fromMail?: boolean;
  conflictsOnly?: boolean;
  attendeesOnly?: boolean;
  query?: string;
};

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function filterEvents(events: CalendarEvent[], filters: EventFilters, conflictIds: Set<string>) {
  const query = normalize(filters.query?.trim() ?? "");
  return events.filter((event) => {
    if (filters.calendars && !filters.calendars.has(event.calendar ?? "")) return false;
    if (filters.fromMail && !event.fromMail) return false;
    if (filters.conflictsOnly && !conflictIds.has(event.id)) return false;
    if (filters.attendeesOnly && !event.attendees?.length) return false;
    if (query && !normalize(event.title).includes(query)) return false;
    return true;
  });
}

export function upcomingEvents(events: CalendarEvent[], fromISO: string) {
  return events
    .filter((event) => event.date >= fromISO)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

export function miniMonthCells(year: number, month: number) {
  return monthGrid(year, month);
}
