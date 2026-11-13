import { useCallback, useEffect, useState } from "react";
import type { CalendarEvent } from "@/lib/calendar";
import { PERIMETER_EVENT, perimeterOf, storedPerimeters, type AccountPerimeter } from "@/lib/prefs";

export type CalendarSource =
  | { kind: "local" }
  | { kind: "ics"; url?: string }
  /** `sourceId` désigne la source rangée par le démon : ses identifiants n'existent pas ici. */
  | { kind: "caldav"; sourceId: string }
  /** Un calendrier d'un compte Google connecté, relu par le démon avec son refresh token. */
  | { kind: "google"; accountId: string; calendarId: string };

/** `source` absent : calendrier local, comme avant l'arrivée des sources ICS. */
export type CalendarDef = { id: string; name: string; tone: number; source?: CalendarSource };

export function isIcsCalendar(def: CalendarDef): boolean {
  return def.source?.kind === "ics";
}

export function isCaldavCalendar(def: CalendarDef): boolean {
  return def.source?.kind === "caldav";
}

export function isGoogleCalendar(def: CalendarDef): boolean {
  return def.source?.kind === "google";
}

/** Le compte et le calendrier Google visés par une source : jamais de jeton ici. */
export function googleRefOf(def: CalendarDef): { accountId: string; calendarId: string } | undefined {
  if (def.source?.kind !== "google") return undefined;
  return { accountId: def.source.accountId, calendarId: def.source.calendarId };
}

/** L'URL de l'abonnement ; un import fichier n'en a pas. */
export function icsUrlOf(def: CalendarDef): string | undefined {
  return def.source?.kind === "ics" ? def.source.url : undefined;
}

export function caldavSourceIdOf(def: CalendarDef): string | undefined {
  return def.source?.kind === "caldav" ? def.source.sourceId : undefined;
}

/** Un calendrier relu à sa source : jamais éditable dans l'agenda. */
export function isExternalCalendar(def: CalendarDef): boolean {
  return isIcsCalendar(def) || isCaldavCalendar(def) || isGoogleCalendar(def);
}

/** Le compte mail dont dépend un calendrier : seul Google en a un. */
export function calendarAccountId(def: CalendarDef): string | undefined {
  return def.source?.kind === "google" ? def.source.accountId : undefined;
}

/** Le type affiché à côté d'un calendrier. */
export function calendarSourceKind(def: CalendarDef): "local" | "ICS" | "CalDAV" | "Google" {
  if (isIcsCalendar(def)) return "ICS";
  if (isCaldavCalendar(def)) return "CalDAV";
  if (isGoogleCalendar(def)) return "Google";
  return "local";
}

/** Agenda coupé pour le compte d'une source Google : elle reste rangée, hors de l'agenda. */
export function calendarActivated(
  def: CalendarDef,
  perimeters: Record<string, AccountPerimeter> = storedPerimeters(),
): boolean {
  const accountId = calendarAccountId(def);
  return !accountId || perimeterOf(perimeters, accountId).calendar;
}

export function agendaCalendars(
  list: CalendarDef[],
  perimeters: Record<string, AccountPerimeter> = storedPerimeters(),
): CalendarDef[] {
  return list.filter((def) => calendarActivated(def, perimeters));
}

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

function parseSource(raw: unknown): CalendarSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { kind, url, sourceId, accountId, calendarId: googleId } = raw as {
    kind?: unknown;
    url?: unknown;
    sourceId?: unknown;
    accountId?: unknown;
    calendarId?: unknown;
  };
  if (kind === "local") return { kind: "local" };
  if (kind === "google") {
    return typeof accountId === "string" && accountId.trim() && typeof googleId === "string" && googleId.trim()
      ? { kind: "google", accountId: accountId.trim(), calendarId: googleId.trim() }
      : undefined;
  }
  if (kind === "caldav") {
    return typeof sourceId === "string" && sourceId.trim()
      ? { kind: "caldav", sourceId: sourceId.trim() }
      : undefined;
  }
  if (kind !== "ics") return undefined;
  return typeof url === "string" && url.trim() ? { kind: "ics", url: url.trim() } : { kind: "ics" };
}

function parseCalendars(raw: unknown): CalendarDef[] | null {
  if (!Array.isArray(raw)) return null;
  const list: CalendarDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, tone, source } = entry as CalendarDef;
    if (typeof id !== "string" || typeof name !== "string" || typeof tone !== "number") continue;
    const parsed = parseSource(source);
    list.push(parsed ? { id, name, tone, source: parsed } : { id, name, tone });
  }
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
  const [calendars, setState] = useState<CalendarDef[]>(() => agendaCalendars(loadCalendars()));

  useEffect(() => {
    const sync = () => setState(agendaCalendars(loadCalendars()));
    window.addEventListener("storage", sync);
    window.addEventListener(PERIMETER_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(PERIMETER_EVENT, sync);
    };
  }, []);

  const setCalendars = useCallback((next: CalendarDef[]) => {
    const merged = keepPaused(loadCalendars(), next);
    setState(agendaCalendars(merged));
    saveCalendars(merged);
  }, []);

  return [calendars, setCalendars];
}

/** Toutes les définitions, sources en pause comprises : la gestion des sources. */
export function useCalendarDefinitions(): [CalendarDef[], (next: CalendarDef[]) => void] {
  const [calendars, setState] = useState<CalendarDef[]>(loadCalendars);

  useEffect(() => {
    const sync = () => setState(loadCalendars());
    window.addEventListener("storage", sync);
    window.addEventListener(PERIMETER_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(PERIMETER_EVENT, sync);
    };
  }, []);

  const setCalendars = useCallback((next: CalendarDef[]) => {
    setState(next);
    saveCalendars(next);
  }, []);

  return [calendars, setCalendars];
}

/** Une écriture de l'agenda ne doit pas effacer les sources mises en pause. */
function keepPaused(stored: CalendarDef[], next: CalendarDef[]): CalendarDef[] {
  const pending = new Map(next.map((def) => [def.id, def]));
  const perimeters = storedPerimeters();
  const out: CalendarDef[] = [];
  for (const def of stored) {
    const written = pending.get(def.id);
    if (written) {
      out.push(written);
      pending.delete(def.id);
      continue;
    }
    if (!calendarActivated(def, perimeters)) out.push(def);
  }
  out.push(...pending.values());
  return out;
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
