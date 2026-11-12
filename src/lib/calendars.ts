import { useCallback, useEffect, useState } from "react";
import type { CalendarEvent } from "@/lib/calendar";

export type CalendarDef = { id: string; name: string; tone: number };

export const TONE_PILL = [
  "bg-accent-soft text-accent-ink",
  "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  "bg-rose-500/12 text-rose-700 dark:text-rose-300",
];

export const TONE_DOT = ["bg-accent", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

export const DEFAULT_CALENDARS: CalendarDef[] = [
  { id: "pro", name: "Pro", tone: 0 },
  { id: "perso", name: "Perso", tone: 2 },
  { id: "clients", name: "Clients", tone: 3 },
];

const STORAGE_KEY = "lavande.calendars.v1";

function parseCalendars(raw: unknown): CalendarDef[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter(
    (entry): entry is CalendarDef =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as CalendarDef).id === "string" &&
      typeof (entry as CalendarDef).name === "string" &&
      typeof (entry as CalendarDef).tone === "number",
  );
  return list.length > 0 ? list : null;
}

export function loadCalendars(): CalendarDef[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_CALENDARS;
    return parseCalendars(JSON.parse(raw)) ?? DEFAULT_CALENDARS;
  } catch {
    return DEFAULT_CALENDARS;
  }
}

export function saveCalendars(list: CalendarDef[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    return;
  }
}

export function useCalendars(): [CalendarDef[], (next: CalendarDef[]) => void] {
  const [calendars, setState] = useState<CalendarDef[]>(loadCalendars);

  useEffect(() => {
    const sync = () => setState(loadCalendars());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setCalendars = useCallback((next: CalendarDef[]) => {
    setState(next);
    saveCalendars(next);
  }, []);

  return [calendars, setCalendars];
}

export function toneOfEvent(event: { tone?: number; calendar?: string }, calendars: CalendarDef[]): number {
  const tone = event.tone ?? calendars.find((entry) => entry.name === event.calendar)?.tone ?? 0;
  return tone % TONE_PILL.length;
}

export function calendarsInUse(events: CalendarEvent[], calendars: CalendarDef[]): CalendarDef[] {
  const out = [...calendars];
  const names = new Set(out.map((entry) => entry.name));
  for (const event of events) {
    const name = event.calendar;
    if (!name || names.has(name)) continue;
    names.add(name);
    out.push({ id: slug(name) || name, name, tone: 0 });
  }
  return out;
}

export function calendarId(name: string, existing: CalendarDef[]): string {
  const base = slug(name) || "calendrier";
  if (!existing.some((entry) => entry.id === base)) return base;
  let index = 2;
  while (existing.some((entry) => entry.id === `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function slug(name: string) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
