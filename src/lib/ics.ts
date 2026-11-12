/**
 * Sources externes lues à leur serveur : les événements analysés par le démon
 * sont rangés à part des calendriers locaux, qui vivent dans le planning
 * synchronisé. Une source CalDAV s'écrit en plus par le démon, avec les
 * identifiants de son coffre ; ICS et Google restent en lecture seule.
 * Supprimer une source jette ses événements ; aucun événement externe ne
 * remonte dans le store de planification.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  errorText,
  mailApi,
  type CaldavEventInput,
  type ExternalEvent,
  type WrittenExternalEvent,
} from "@/lib/api";
import type { CalendarEvent } from "@/lib/calendar";
import {
  caldavSourceIdOf,
  googleRefOf,
  icsUrlOf,
  isCaldavCalendar,
  isExternalCalendar,
  isGoogleCalendar,
  type CalendarDef,
} from "@/lib/calendars";
import { GOOGLE_REFRESH_MS, googleWindow } from "@/lib/gcal";

export const ICS_STORAGE_KEY = "lavande.ics.v1";

/** Le cache a changé dans cet onglet : `storage` ne prévient que les autres. */
export const ICS_CHANGE_EVENT = "lavande:ics-changed";

/** Un abonnement se relit au plus toutes les six heures : jamais de boucle de fetch. */
export const ICS_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Un serveur CalDAV répond vite : son cache se périme plus tôt qu'un fichier ICS. */
export const CALDAV_REFRESH_MS = 15 * 60 * 1000;

/** Plafond de stockage local par calendrier : un fichier énorme ne remplit pas le localStorage. */
export const ICS_MAX_EVENTS = 2000;

export type ExternalKind = "ics" | "caldav" | "google";

export type IcsEvents = Record<string, CalendarEvent[]>;

export type IcsState = {
  events: IcsEvents;
  synced: Record<string, number>;
};

export const EMPTY_ICS_STATE: IcsState = { events: {}, synced: {} };

export function externalEventId(
  kind: ExternalKind,
  calendarId: string,
  event: ExternalEvent,
  index: number,
): string {
  return `${kind}:${calendarId}:${event.uid ?? `#${index}`}`;
}

export function icsEventId(calendarId: string, event: ExternalEvent, index: number): string {
  return externalEventId("ics", calendarId, event, index);
}

/** La famille d'un événement externe, portée par son identifiant : ni édition ni suppression. */
export function externalEventKind(event: { id: string }): ExternalKind {
  if (event.id.startsWith("google:")) return "google";
  return event.id.startsWith("caldav:") ? "caldav" : "ics";
}

export function toCalendarEvents(
  external: WrittenExternalEvent[],
  calendar: CalendarDef,
  kind: ExternalKind = "ics",
): CalendarEvent[] {
  const sourceId = kind === "caldav" ? caldavSourceIdOf(calendar) : undefined;
  return external.map((entry, index) => {
    const event: CalendarEvent = {
      id: externalEventId(kind, calendar.id, entry, index),
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
    if (sourceId && entry.uid) {
      event.caldav = { sourceId, uid: entry.uid, ...(entry.etag ? { etag: entry.etag } : {}) };
    }
    return event;
  });
}

/** Le nom porté par les événements suit le calendrier : un renommage se voit aussitôt. */
export function externalCalendarEvents(state: IcsState, calendars: CalendarDef[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const def of calendars) {
    if (!isExternalCalendar(def)) continue;
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

/** Le démon a écrit l'événement : le cache de la source prend sa version serveur. */
export function upsertIcsCalendarEvent(state: IcsState, id: string, event: CalendarEvent): IcsState {
  const list = state.events[id] ?? [];
  const known = list.some((entry) => entry.id === event.id);
  const events = known
    ? list.map((entry) => (entry.id === event.id ? event : entry))
    : [...list, event];
  return { ...state, events: { ...state.events, [id]: events.slice(0, ICS_MAX_EVENTS) } };
}

export function removeIcsCalendarEvent(state: IcsState, id: string, eventId: string): IcsState {
  const list = state.events[id];
  if (!list) return state;
  return { ...state, events: { ...state.events, [id]: list.filter((entry) => entry.id !== eventId) } };
}

/** Les sources relues à leur serveur dont le cache a expiré (ou qui n'ont jamais été lues). */
export function dueExternalSubscriptions(
  calendars: CalendarDef[],
  synced: Record<string, number>,
  now = Date.now(),
): CalendarDef[] {
  return calendars.filter((def) => {
    const ttl = externalTtl(def);
    return ttl !== null && now - (synced[def.id] ?? 0) >= ttl;
  });
}

/** Délai de relecture d'une source ; `null` pour un calendrier qui n'en a pas. */
function externalTtl(def: CalendarDef): number | null {
  if (isGoogleCalendar(def)) return GOOGLE_REFRESH_MS;
  if (isCaldavCalendar(def)) return CALDAV_REFRESH_MS;
  return icsUrlOf(def) ? ICS_REFRESH_MS : null;
}

export async function fetchIcsCalendar(def: CalendarDef): Promise<CalendarEvent[]> {
  const url = icsUrlOf(def);
  if (!url) throw new Error("abonnement ICS sans URL");
  return toCalendarEvents(await mailApi.importIcs({ url, source: def.name }), def);
}

/** Le démon relit la source avec les identifiants de son coffre : aucun ne passe ici. */
export async function fetchCaldavCalendar(def: CalendarDef): Promise<CalendarEvent[]> {
  const sourceId = caldavSourceIdOf(def);
  if (!sourceId) throw new Error("source CalDAV sans identifiant");
  return toCalendarEvents(await mailApi.caldavSourceEvents(sourceId), def, "caldav");
}

export async function fetchExternalCalendar(def: CalendarDef): Promise<CalendarEvent[]> {
  if (isGoogleCalendar(def)) return fetchGoogleCalendar(def);
  return isCaldavCalendar(def) ? fetchCaldavCalendar(def) : fetchIcsCalendar(def);
}

/** Relit la source et remplace son cache : la vérité du serveur après un conflit. */
export async function reloadCaldavSource(def: CalendarDef): Promise<IcsState> {
  return setIcsCalendarEvents(loadIcsState(), def.id, await fetchCaldavCalendar(def));
}

/** 409 ou 412 : la ressource a bougé chez le serveur depuis la dernière lecture. */
export function isCaldavConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 412);
}

export const CALDAV_CONFLICT_MESSAGE =
  "Événement modifié sur le serveur entre-temps : la source a été relue, réessayez.";

/** Message d'une écriture refusée ; un conflit relit la source pour repartir de son état. */
export async function caldavWriteFailure(def: CalendarDef, error: unknown): Promise<string> {
  if (!isCaldavConflict(error)) return `Calendrier CalDAV · ${errorText(error)}`;
  try {
    commitIcsState(await reloadCaldavSource(def));
  } catch (reloadError) {
    return `${CALDAV_CONFLICT_MESSAGE} Relecture impossible · ${errorText(reloadError)}`;
  }
  return CALDAV_CONFLICT_MESSAGE;
}

/** Le démon renvoie l'événement écrit (uid et etag) : le cache garde de quoi le réécrire. */
function writtenCaldavEvent(def: CalendarDef, written: WrittenExternalEvent): CalendarEvent {
  const [event] = toCalendarEvents([written], def, "caldav");
  if (!event) throw new Error("événement CalDAV illisible en réponse");
  return event;
}

/** Crée l'événement dans la source ; l'etag renvoyé servira à la mise à jour suivante. */
export async function createCaldavEvent(
  def: CalendarDef,
  input: CaldavEventInput,
): Promise<IcsState> {
  const sourceId = caldavSourceIdOf(def);
  if (!sourceId) throw new Error("source CalDAV sans identifiant");
  const written = await mailApi.caldavCreateEvent(sourceId, input);
  return upsertIcsCalendarEvent(loadIcsState(), def.id, writtenCaldavEvent(def, written));
}

/** Met à jour la ressource avec l'etag détenu : un serveur qui a bougé répond 409 ou 412. */
export async function updateCaldavEvent(
  def: CalendarDef,
  event: CalendarEvent,
  input: CaldavEventInput,
): Promise<IcsState> {
  const binding = event.caldav;
  if (!binding) throw new Error("événement CalDAV sans identifiant serveur");
  const written = await mailApi.caldavUpdateEvent(binding.sourceId, binding.uid, {
    ...input,
    ...(binding.etag ? { etag: binding.etag } : {}),
  });
  return upsertIcsCalendarEvent(loadIcsState(), def.id, writtenCaldavEvent(def, written));
}

export async function deleteCaldavEvent(
  def: CalendarDef,
  event: CalendarEvent,
): Promise<IcsState> {
  const binding = event.caldav;
  if (!binding) throw new Error("événement CalDAV sans identifiant serveur");
  await mailApi.caldavDeleteEvent(binding.sourceId, binding.uid, binding.etag);
  return removeIcsCalendarEvent(loadIcsState(), def.id, event.id);
}

/** Le démon relit l'agenda du compte avec son refresh token, sur une fenêtre bornée. */
export async function fetchGoogleCalendar(def: CalendarDef): Promise<CalendarEvent[]> {
  const ref = googleRefOf(def);
  if (!ref) throw new Error("source Google sans calendrier");
  const events = await mailApi.googleEvents(ref.accountId, {
    calendar_id: ref.calendarId,
    ...googleWindow(),
  });
  return toCalendarEvents(events, def, "google");
}

export async function importIcsContent(def: CalendarDef, content: string): Promise<CalendarEvent[]> {
  return toCalendarEvents(await mailApi.importIcs({ content, source: def.name }), def);
}

export function calendarUrlError(value: string): string | null {
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

export function icsNameFromUrl(value: string, fallback = "Calendrier ICS"): string {
  try {
    return new URL(value.trim()).hostname.replace(/^www\./, "") || fallback;
  } catch {
    return fallback;
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

/** Enregistre le cache puis prévient les vues du même onglet, que `storage` ne touche pas. */
export function commitIcsState(state: IcsState) {
  saveIcsState(state);
  window.dispatchEvent(new Event(ICS_CHANGE_EVENT));
}

export function useIcsState(): [IcsState, (next: IcsState) => void] {
  const [state, setState] = useState<IcsState>(loadIcsState);

  useEffect(() => {
    const sync = () => setState(loadIcsState());
    window.addEventListener("storage", sync);
    window.addEventListener(ICS_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(ICS_CHANGE_EVENT, sync);
    };
  }, []);

  const setIcsState = useCallback((next: IcsState) => {
    setState(next);
    saveIcsState(next);
  }, []);

  return [state, setIcsState];
}
