/**
 * Sources ICS en lecture seule : les événements analysés par le démon sont
 * rangés à part des calendriers locaux (qui vivent dans le planning
 * synchronisé). Supprimer une source jette ses événements ; aucun événement
 * externe ne remonte dans le store de planification.
 */

import { useCallback, useEffect, useState } from "react";
import { mailApi, type ExternalEvent } from "@/lib/api";
import type { CalendarEvent } from "@/lib/calendar";
import { icsUrlOf, isIcsCalendar, type CalendarDef } from "@/lib/calendars";

export const ICS_STORAGE_KEY = "lavande.ics.v1";

/** Un abonnement se relit au plus toutes les six heures : jamais de boucle de fetch. */
export const ICS_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Plafond de stockage local par calendrier : un fichier énorme ne remplit pas le localStorage. */
export const ICS_MAX_EVENTS = 2000;

export type IcsEvents = Record<string, CalendarEvent[]>;

export type IcsState = {
  events: IcsEvents;
  synced: Record<string, number>;
};

export const EMPTY_ICS_STATE: IcsState = { events: {}, synced: {} };

export function icsEventId(calendarId: string, event: ExternalEvent, index: number): string {
  return `ics:${calendarId}:${event.uid ?? `#${index}`}`;
}

export function toCalendarEvents(
  external: ExternalEvent[],
  calendar: { id: string; name: string },
): CalendarEvent[] {
  return external.map((entry, index) => {
    const event: CalendarEvent = {
      id: icsEventId(calendar.id, entry, index),
      date: entry.date,
      start: entry.start ?? "",
      end: entry.end ?? "",
      title: entry.title,
      calendar: calendar.name,
      external: true,
    };
    if (entry.location) event.location = entry.location;
    if (entry.description) event.description = entry.description;
    if (entry.recurring) event.recurring = true;
    return event;
  });
}

/** Le nom porté par les événements suit le calendrier : un renommage se voit aussitôt. */
export function icsCalendarEvents(state: IcsState, calendars: CalendarDef[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const def of calendars) {
    if (!isIcsCalendar(def)) continue;
    for (const event of state.events[def.id] ?? []) out.push({ ...event, calendar: def.name });
  }
  return out;
}

export function setIcsCalendarEvents(
  state: IcsState,
  id: string,
  events: CalendarEvent[],
  now = Date.now(),
): IcsState {
  return {
    events: { ...state.events, [id]: events.slice(0, ICS_MAX_EVENTS) },
    synced: { ...state.synced, [id]: now },
  };
}

/** Une tentative ratée compte comme une synchronisation : l'URL n'est pas martelée. */
export function markIcsSynced(state: IcsState, id: string, now = Date.now()): IcsState {
  return { ...state, synced: { ...state.synced, [id]: now } };
}

export function dropIcsCalendar(state: IcsState, id: string): IcsState {
  const events = { ...state.events };
  const synced = { ...state.synced };
  delete events[id];
  delete synced[id];
  return { events, synced };
}

/** Les abonnements dont le cache a expiré (ou qui n'ont jamais été lus). */
export function dueIcsSubscriptions(
  calendars: CalendarDef[],
  synced: Record<string, number>,
  now = Date.now(),
): CalendarDef[] {
  return calendars.filter((def) => {
    if (!icsUrlOf(def)) return false;
    return now - (synced[def.id] ?? 0) >= ICS_REFRESH_MS;
  });
}

export async function fetchIcsCalendar(def: CalendarDef): Promise<CalendarEvent[]> {
  const url = icsUrlOf(def);
  if (!url) throw new Error("abonnement ICS sans URL");
  return toCalendarEvents(await mailApi.importIcs({ url, source: def.name }), def);
}

export async function importIcsContent(def: CalendarDef, content: string): Promise<CalendarEvent[]> {
  return toCalendarEvents(await mailApi.importIcs({ content, source: def.name }), def);
}

export function icsUrlError(value: string): string | null {
  const url = value.trim();
  if (!url) return "URL du calendrier requise";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL invalide";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "L'URL doit commencer par http:// ou https://";
  }
  return null;
}

export function icsNameFromUrl(value: string): string {
  try {
    return new URL(value.trim()).hostname.replace(/^www\./, "") || "Calendrier ICS";
  } catch {
    return "Calendrier ICS";
  }
}

export function icsNameFromFile(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim() || "Calendrier ICS";
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as CalendarEvent;
  return typeof event.id === "string" && typeof event.date === "string" && typeof event.title === "string";
}

export function parseIcsState(raw: unknown): IcsState {
  if (!raw || typeof raw !== "object") return EMPTY_ICS_STATE;
  const { events, synced } = raw as { events?: unknown; synced?: unknown };
  const parsedEvents: IcsEvents = {};
  if (events && typeof events === "object") {
    for (const [id, list] of Object.entries(events as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      parsedEvents[id] = list.filter(isCalendarEvent).slice(0, ICS_MAX_EVENTS);
    }
  }
  const parsedSynced: Record<string, number> = {};
  if (synced && typeof synced === "object") {
    for (const [id, stamp] of Object.entries(synced as Record<string, unknown>)) {
      if (typeof stamp === "number" && Number.isFinite(stamp)) parsedSynced[id] = stamp;
    }
  }
  return { events: parsedEvents, synced: parsedSynced };
}

export function loadIcsState(): IcsState {
  try {
    const raw = window.localStorage.getItem(ICS_STORAGE_KEY);
    if (raw === null) return EMPTY_ICS_STATE;
    return parseIcsState(JSON.parse(raw));
  } catch {
    return EMPTY_ICS_STATE;
  }
}

export function saveIcsState(state: IcsState) {
  try {
    window.localStorage.setItem(ICS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

export function useIcsState(): [IcsState, (next: IcsState) => void] {
  const [state, setState] = useState<IcsState>(loadIcsState);

  useEffect(() => {
    const sync = () => setState(loadIcsState());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setIcsState = useCallback((next: IcsState) => {
    setState(next);
    saveIcsState(next);
  }, []);

  return [state, setIcsState];
}
