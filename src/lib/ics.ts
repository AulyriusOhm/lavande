/**
 * Sources externes lues à leur serveur : les événements analysés par le démon
 * sont rangés à part des calendriers locaux, qui vivent dans le planning
 * synchronisé. Une source CalDAV s'écrit en plus par le démon, avec les
 * identifiants de son coffre ; ICS et Google restent en lecture seule.
 * Supprimer une source jette ses événements ; aucun événement externe ne
 * remonte dans le store de planification.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  errorText,
  mailApi,
  type ApiAccount,
  type CaldavCollection,
  type CaldavEventInput,
  type CaldavSource,
  type ExternalEvent,
  type GoogleCalendar,
  type WrittenExternalEvent,
} from "@/lib/api";
import type { CalendarEvent } from "@/lib/calendar";
import {
  caldavSourceIdOf,
  calendarAccountId,
  calendarActivated,
  calendarId,
  googleRefOf,
  icsUrlOf,
  isCaldavCalendar,
  isExternalCalendar,
  isGoogleCalendar,
  isIcsCalendar,
  loadCalendars,
  saveCalendars,
  useCalendarDefinitions,
  type CalendarDef,
} from "@/lib/calendars";
import { GOOGLE_REFRESH_MS, googleAccounts, googleAutoAttachTarget, googleWindow } from "@/lib/gcal";
import { accountCalendarAttached, sourceCalendarName } from "@/lib/zimbra";
import { storedPerimeters } from "@/lib/prefs";
import { READ_ONLY_NOTICE, demoReadOnly } from "@/lib/mail-backend";

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

/**
 * Identifiant d'une entrée externe : le `uid` de la série et, pour une occurrence
 * développée, son créneau — sans quoi toutes les occurrences se confondraient.
 */
export function externalEventId(
  kind: ExternalKind,
  calendarId: string,
  event: ExternalEvent,
  index: number,
): string {
  const uid = event.uid ?? `#${index}`;
  const occurrence = event.recurrence_id ? `@${event.recurrence_id}` : "";
  return `${kind}:${calendarId}:${uid}${occurrence}`;
}

export function icsEventId(calendarId: string, event: ExternalEvent, index: number): string {
  return externalEventId("ics", calendarId, event, index);
}

/** La famille d'un événement externe, portée par son identifiant : ni édition ni suppression. */
export function externalEventKind(event: { id: string }): ExternalKind {
  if (event.id.startsWith("google:")) return "google";
  return event.id.startsWith("caldav:") ? "caldav" : "ics";
}

/** Étiquette d'une source relue à son serveur : ICS, CalDAV ou Google. */
export function externalBadge(event: { id: string }): { tone: "sky" | "green" | "amber"; label: string } {
  const kind = externalEventKind(event);
  if (kind === "google") return { tone: "amber", label: "Google" };
  return kind === "caldav" ? { tone: "green", label: "CalDAV" } : { tone: "sky", label: "ICS" };
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
    if (entry.attendees?.length) event.attendees = entry.attendees;
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
  const perimeters = storedPerimeters();
  for (const def of calendars) {
    if (!isExternalCalendar(def) || !calendarActivated(def, perimeters)) continue;
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

/**
 * Le démon a écrit l'événement : le cache de la source prend sa version serveur.
 * Une écriture vise la SÉRIE : ses occurrences en cache sont périmées.
 */
export function upsertIcsCalendarEvent(state: IcsState, id: string, event: CalendarEvent): IcsState {
  const series = event.caldav?.uid;
  const list = (state.events[id] ?? []).filter(
    (entry) => entry.id !== event.id && !(series && entry.caldav?.uid === series),
  );
  const events = [...list, event];
  return { ...state, events: { ...state.events, [id]: events.slice(0, ICS_MAX_EVENTS) } };
}

/**
 * Retire un événement du cache ; une écriture CalDAV vise la série, dont toutes
 * les occurrences partent en même temps.
 */
export function removeIcsCalendarEvent(state: IcsState, id: string, eventId: string): IcsState {
  const list = state.events[id];
  if (!list) return state;
  const series = list.find((entry) => entry.id === eventId)?.caldav?.uid;
  const events = list.filter(
    (entry) => entry.id !== eventId && !(series && entry.caldav?.uid === series),
  );
  return { ...state, events: { ...state.events, [id]: events } };
}

/** Les sources relues à leur serveur dont le cache a expiré (ou qui n'ont jamais été lues). */
export function dueExternalSubscriptions(
  calendars: CalendarDef[],
  synced: Record<string, number>,
  now = Date.now(),
): CalendarDef[] {
  const perimeters = storedPerimeters();
  return calendars.filter((def) => {
    if (!calendarActivated(def, perimeters)) return false;
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
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
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
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
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
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
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

/** Relecture des sources dues : PC et mobile tournent la même boucle. */
export type ExternalCalendarRefresh = {
  ics: IcsState;
  setIcs: (next: IcsState) => void;
  syncing: boolean;
  refresh: (targets: CalendarDef[]) => Promise<void>;
};

const GOOGLE_AUTO_ATTACH_KEY = "lavande.gcal.autoattach.v1";
const ZIMBRA_AUTO_ATTACH_KEY = "lavande.zimbra.autoattach.v1";

function loadAutoAttached(key: string): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveAutoAttached(key: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* stockage indisponible : l'auto-ajout retentera au prochain démarrage */
  }
}

export function useExternalCalendarRefresh(
  calendars: CalendarDef[],
  notify: (message: string) => void,
): ExternalCalendarRefresh {
  const [ics, setIcs] = useIcsState();
  const [syncing, setSyncing] = useState(false);
  const current = useRef(ics);
  current.current = ics;
  const inFlight = useRef(new Set<string>());

  const refresh = useCallback(
    async (targets: CalendarDef[]) => {
      if (demoReadOnly) return;
      const queue = targets.filter((def) => !inFlight.current.has(def.id));
      if (queue.length === 0) return;
      for (const def of queue) inFlight.current.add(def.id);
      setSyncing(true);
      let next = current.current;
      const failures: string[] = [];
      for (const def of queue) {
        try {
          next = setIcsCalendarEvents(next, def.id, await fetchExternalCalendar(def));
        } catch (error) {
          next = markIcsSynced(next, def.id);
          failures.push(`${def.name} · ${errorText(error)}`);
        } finally {
          inFlight.current.delete(def.id);
        }
      }
      current.current = next;
      setIcs(next);
      setSyncing(false);
      if (failures.length > 0) notify(`Calendrier externe · ${failures.join(" ; ")}`);
    },
    [notify, setIcs],
  );

  useEffect(() => {
    const due = dueExternalSubscriptions(calendars, current.current.synced);
    if (due.length > 0) void refresh(due);
  }, [calendars, refresh]);

  return { ics, setIcs, syncing, refresh };
}

/**
 * Auto-ajout de l'agenda Google à la connexion d'un compte : au démarrage de la
 * coquille, attache le calendrier principal de chaque compte Google qui n'a aucun
 * calendrier dans l'agenda. Monté dans l'app (pas dans le refresh des sources,
 * testé séparément). Garde persistante par compte : pas de réajout après
 * suppression ; un échec de lecture n'est pas marqué (réessai au prochain démarrage).
 */
export function useGoogleCalendarAutoAttach(notify: (message: string) => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || demoReadOnly) return;
    done.current = true;
    let cancelled = false;
    void (async () => {
      let accounts: ApiAccount[];
      try {
        accounts = await mailApi.accounts();
      } catch {
        return;
      }
      if (cancelled) return;
      const google = googleAccounts(Array.isArray(accounts) ? accounts : []);
      if (google.length === 0) return;
      const processed = loadAutoAttached(GOOGLE_AUTO_ATTACH_KEY);
      let next = loadIcsState();
      let added = false;
      for (const account of google) {
        if (processed.has(account.id)) continue;
        let list: GoogleCalendar[];
        try {
          list = await mailApi.googleCalendars(account.id);
        } catch {
          continue;
        }
        if (cancelled) return;
        processed.add(account.id);
        const existing = loadCalendars();
        const primary = googleAutoAttachTarget(account.id, Array.isArray(list) ? list : [], existing);
        if (!primary) continue;
        const name = primary.summary.trim() || primary.id;
        const def: CalendarDef = {
          id: calendarId(name, existing),
          name,
          tone: 3,
          source: { kind: "google", accountId: account.id, calendarId: primary.id },
        };
        saveCalendars([...loadCalendars(), def]);
        added = true;
        try {
          next = setIcsCalendarEvents(next, def.id, await fetchGoogleCalendar(def));
        } catch {
          next = markIcsSynced(next, def.id);
        }
        if (cancelled) return;
        notify(`Calendrier Google ajouté · ${name}`);
      }
      saveAutoAttached(GOOGLE_AUTO_ATTACH_KEY, processed);
      if (added && !cancelled) {
        saveIcsState(next);
        window.dispatchEvent(new StorageEvent("storage"));
        window.dispatchEvent(new Event(ICS_CHANGE_EVENT));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);
}

/**
 * Auto-ajout de l'agenda Zimbra à la connexion d'un compte : le démon lit le
 * CalDAV du compte avec son mot de passe et range la source. Un échec (compte
 * OAuth, serveur muet, pas de DAV) reste silencieux et vaut un essai : le compte
 * est marqué comme Google, pour ne pas réessayer à chaque démarrage.
 */
export function useZimbraCalendarAutoAttach(notify: (message: string) => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || demoReadOnly) return;
    done.current = true;
    let cancelled = false;
    void (async () => {
      let accounts: ApiAccount[];
      try {
        accounts = await mailApi.accounts();
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(accounts)) return;
      const processed = loadAutoAttached(ZIMBRA_AUTO_ATTACH_KEY);
      let next = loadIcsState();
      let added = false;
      for (const account of accounts) {
        if (processed.has(account.id)) continue;
        if (accountCalendarAttached(account.id, loadCalendars())) {
          processed.add(account.id);
          continue;
        }
        let source: CaldavSource;
        try {
          source = await mailApi.addCaldavSourceFromAccount(account.id);
        } catch {
          processed.add(account.id);
          continue;
        }
        if (cancelled) return;
        processed.add(account.id);
        if (!source?.id) continue;
        const name = sourceCalendarName(source);
        const def: CalendarDef = {
          id: calendarId(name, loadCalendars()),
          name,
          tone: 3,
          source: { kind: "caldav", sourceId: source.id, accountId: account.id },
        };
        saveCalendars([...loadCalendars(), def]);
        added = true;
        try {
          next = setIcsCalendarEvents(next, def.id, await fetchCaldavCalendar(def));
        } catch {
          next = markIcsSynced(next, def.id);
        }
        if (cancelled) return;
        notify(`Calendrier ajouté · ${name}`);
      }
      saveAutoAttached(ZIMBRA_AUTO_ATTACH_KEY, processed);
      if (added && !cancelled) {
        saveIcsState(next);
        window.dispatchEvent(new StorageEvent("storage"));
        window.dispatchEvent(new Event(ICS_CHANGE_EVENT));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);
}

/** Gestion des sources partagée par les réglages PC et mobile : une seule implémentation. */
export type CalendarSourcesManager = {
  calendars: CalendarDef[];
  busy: boolean;
  refreshing: string | null;
  error: string | null;
  /** Comptes mail connectés : sélecteur de l'agenda d'un compte (Zimbra). */
  accounts: ApiAccount[];
  googleConnected: ApiAccount[];
  googleCalendars: Record<string, GoogleCalendar[]>;
  googleBusy: Record<string, boolean>;
  googleErrors: Record<string, string | null>;
  loadGoogleCalendars: (accountId: string) => Promise<void>;
  googleAttached: (accountId: string, calendarId: string) => boolean;
  caldavAttached: (accountId: string) => boolean;
  addCaldavFromAccount: (
    account: ApiAccount,
    input: { name: string; tone: number; calendarHref?: string },
  ) => Promise<boolean>;
  /** Collections d'un serveur CalDAV, avec des identifiants de passage. */
  discoverCollections: (input: {
    url: string;
    username: string;
    password: string;
  }) => Promise<CaldavCollection[] | null>;
  /** Collections du serveur d'un compte mail (mot de passe du coffre). */
  accountCollections: (accountId: string) => Promise<CaldavCollection[] | null>;
  /** Collections du serveur d'une source déjà rangée. */
  sourceCollections: (def: CalendarDef) => Promise<CaldavCollection[] | null>;
  /** Collection courante d'une source CalDAV, quand le démon la connaît. */
  collectionOf: (def: CalendarDef) => string | null;
  /** Change la collection d'une source et relit ses événements. */
  setCollection: (def: CalendarDef, href: string | null) => Promise<boolean>;
  countOf: (id: string) => number;
  detailOf: (def: CalendarDef) => string | undefined;
  paused: (def: CalendarDef) => boolean;
  addLocal: (input: { name: string; tone: number }) => boolean;
  addCaldav: (input: {
    url: string;
    username: string;
    password: string;
    name: string;
    tone: number;
    /** Collection choisie ; le démon découvre les autres quand elle manque. */
    calendarHref?: string;
  }) => Promise<boolean>;
  subscribeIcs: (input: { url: string; name: string; tone: number }) => Promise<boolean>;
  importIcsFile: (input: { file: File; name: string; tone: number }) => Promise<boolean>;
  addGoogle: (
    account: ApiAccount,
    calendar: GoogleCalendar,
    input: { name: string; tone: number },
  ) => Promise<boolean>;
  rename: (id: string, name: string) => boolean;
  setTone: (id: string, tone: number) => void;
  remove: (id: string) => Promise<boolean>;
  refresh: (def: CalendarDef) => Promise<boolean>;
};

export function useCalendarSources(notify: (message: string) => void): CalendarSourcesManager {
  const [calendars, setCalendars] = useCalendarDefinitions();
  const [ics, setIcs] = useIcsState();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caldavSources, setCaldavSources] = useState<Record<string, CaldavSource>>({});
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [googleConnected, setGoogleConnected] = useState<ApiAccount[]>([]);
  const [googleCalendars, setGoogleCalendars] = useState<Record<string, GoogleCalendar[]>>({});
  const [googleBusy, setGoogleBusy] = useState<Record<string, boolean>>({});
  const [googleErrors, setGoogleErrors] = useState<Record<string, string | null>>({});
  const googleInFlight = useRef(new Set<string>());
  const googleRequested = useRef(new Set<string>());

  /** Une liste indisponible ne bloque rien : seule l'URL des sources CalDAV manque. */
  useEffect(() => {
    let alive = true;
    mailApi
      .caldavSources()
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        setCaldavSources(Object.fromEntries(list.map((source) => [source.id, source])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /** Les comptes connectés disparaissent sans le démon : le bloc Google reste alors vide. */
  useEffect(() => {
    let alive = true;
    mailApi
      .accounts()
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        setAccounts(list);
        setGoogleConnected(googleAccounts(list));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /** Lecture des calendriers d'un compte : une seule requête en vol, jamais de boucle. */
  const loadGoogleCalendars = useCallback(async (accountId: string) => {
    if (googleInFlight.current.has(accountId)) return;
    googleInFlight.current.add(accountId);
    setGoogleBusy((current) => ({ ...current, [accountId]: true }));
    try {
      const list = await mailApi.googleCalendars(accountId);
      setGoogleCalendars((current) => ({ ...current, [accountId]: Array.isArray(list) ? list : [] }));
      setGoogleErrors((current) => ({ ...current, [accountId]: null }));
    } catch (failure) {
      setGoogleErrors((current) => ({
        ...current,
        [accountId]: `Google · ${errorText(failure)}`,
      }));
    } finally {
      googleInFlight.current.delete(accountId);
      setGoogleBusy((current) => ({ ...current, [accountId]: false }));
    }
  }, []);

  useEffect(() => {
    for (const account of googleConnected) {
      if (googleRequested.current.has(account.id)) continue;
      googleRequested.current.add(account.id);
      void loadGoogleCalendars(account.id);
    }
  }, [googleConnected, loadGoogleCalendars]);

  const fail = (message: string) => {
    setError(message);
    return false;
  };

  /** Le nom saisi décide ; à défaut l'URL, le fichier ou le calendrier fait foi. */
  const draftFor = (rawName: string, fallback: string, tone: number): CalendarDef | null => {
    const name = rawName.trim() || fallback;
    const list = loadCalendars();
    if (list.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      setError(`Calendrier déjà présent · ${name}`);
      return null;
    }
    return { id: calendarId(name, list), name, tone };
  };

  const addLocal = ({ name, tone }: { name: string; tone: number }) => {
    if (!name.trim()) return fail("Nom du calendrier requis");
    const def = draftFor(name, name, tone);
    if (!def) return false;
    setCalendars([...loadCalendars(), def]);
    setError(null);
    notify(`Calendrier ajouté · ${def.name}`);
    return true;
  };

  const addCaldav = async (input: {
    url: string;
    username: string;
    password: string;
    name: string;
    tone: number;
    calendarHref?: string;
  }) => {
    const url = input.url.trim();
    const problem = calendarUrlError(url);
    if (problem) return fail(problem);
    const username = input.username.trim();
    if (!username) return fail("Identifiant CalDAV requis");
    if (!input.password) return fail("Mot de passe CalDAV requis");
    const draft = draftFor(input.name, icsNameFromUrl(url, "Calendrier CalDAV"), input.tone);
    if (!draft) return false;
    setBusy(true);
    setError(null);
    try {
      const calendar_href = input.calendarHref?.trim() || undefined;
      const source = await mailApi.addCaldavSource({
        url,
        username,
        password: input.password,
        name: draft.name,
        ...(calendar_href ? { calendar_href } : {}),
      });
      const def: CalendarDef = { ...draft, source: { kind: "caldav", sourceId: source.id } };
      setCalendars([...loadCalendars(), def]);
      setCaldavSources((current) => ({ ...current, [source.id]: source }));
      notify(`Calendrier CalDAV ajouté · ${def.name}`);
      try {
        setIcs(setIcsCalendarEvents(loadIcsState(), def.id, await fetchCaldavCalendar(def)));
      } catch (failure) {
        setError(`Source ajoutée, événements non lus · ${errorText(failure)}`);
      }
      return true;
    } catch (failure) {
      const message = errorText(failure);
      notify(`Ajout CalDAV impossible · ${message}`);
      return fail(message);
    } finally {
      setBusy(false);
    }
  };

  /** L'agenda d'un compte mail (Zimbra) : le démon lit le CalDAV avec le mot de passe du compte. */
  const addCaldavFromAccount = async (
    account: ApiAccount,
    input: { name: string; tone: number; calendarHref?: string },
  ) => {
    if (accountCalendarAttached(account.id, loadCalendars())) {
      return fail(`Agenda déjà lié · ${account.email}`);
    }
    const fallback = account.imap?.host?.trim() || account.label;
    const draft = draftFor(input.name, fallback, input.tone);
    if (!draft) return false;
    setBusy(true);
    setError(null);
    try {
      const calendar_href = input.calendarHref?.trim() || undefined;
      const source = await mailApi.addCaldavSourceFromAccount(account.id, calendar_href);
      const def: CalendarDef = {
        ...draft,
        source: { kind: "caldav", sourceId: source.id, accountId: account.id },
      };
      setCalendars([...loadCalendars(), def]);
      setCaldavSources((current) => ({ ...current, [source.id]: source }));
      notify(`Calendrier ajouté · ${def.name}`);
      try {
        setIcs(setIcsCalendarEvents(loadIcsState(), def.id, await fetchCaldavCalendar(def)));
      } catch (failure) {
        setError(`Source ajoutée, événements non lus · ${errorText(failure)}`);
      }
      return true;
    } catch (failure) {
      const message = errorText(failure);
      notify(`Ajout de l'agenda impossible · ${message}`);
      return fail(message);
    } finally {
      setBusy(false);
    }
  };

  const loadCollections = async (
    call: () => Promise<CaldavCollection[]>,
  ): Promise<CaldavCollection[] | null> => {
    setError(null);
    try {
      const collections = await call();
      return Array.isArray(collections) ? collections : null;
    } catch (failure) {
      setError(`Calendriers non lus · ${errorText(failure)}`);
      return null;
    }
  };

  const discoverCollections = (input: { url: string; username: string; password: string }) => {
    const url = input.url.trim();
    const problem = calendarUrlError(url);
    const username = input.username.trim();
    if (problem || !username || !input.password) {
      setError(
        problem ?? "Identifiant et mot de passe requis pour lire les calendriers",
      );
      return Promise.resolve(null);
    }
    return loadCollections(() =>
      mailApi.caldavCollections({ url, username, password: input.password }),
    );
  };

  const accountCollections = (accountId: string) =>
    loadCollections(() => mailApi.accountCaldavCollections(accountId));

  const sourceCollections = (def: CalendarDef) => {
    const sourceId = def.source?.kind === "caldav" ? def.source.sourceId : null;
    if (!sourceId) return Promise.resolve(null);
    return loadCollections(() => mailApi.sourceCaldavCollections(sourceId));
  };

  const collectionOf = (def: CalendarDef): string | null => {
    const sourceId = def.source?.kind === "caldav" ? def.source.sourceId : null;
    if (!sourceId) return null;
    return caldavSources[sourceId]?.calendar_href ?? null;
  };

  const setCollection = async (def: CalendarDef, href: string | null) => {
    const sourceId = def.source?.kind === "caldav" ? def.source.sourceId : null;
    if (!sourceId) return fail("Cette source n'a pas de collection à changer");
    setBusy(true);
    setError(null);
    try {
      const source = await mailApi.updateCaldavSource(sourceId, { calendar_href: href });
      setCaldavSources((current) => ({ ...current, [source.id]: source }));
      try {
        setIcs(setIcsCalendarEvents(loadIcsState(), def.id, await fetchCaldavCalendar(def)));
      } catch (failure) {
        setError(`Collection changée, événements non lus · ${errorText(failure)}`);
      }
      notify(href ? `Collection de ${def.name} changée` : `${def.name} relit tous ses calendriers`);
      return true;
    } catch (failure) {
      const message = errorText(failure);
      notify(`Changement de collection impossible · ${message}`);
      return fail(message);
    } finally {
      setBusy(false);
    }
  };

  const subscribeIcs = async (input: { url: string; name: string; tone: number }) => {
    const url = input.url.trim();
    const problem = calendarUrlError(url);
    if (problem) return fail(problem);
    const draft = draftFor(input.name, icsNameFromUrl(url), input.tone);
    if (!draft) return false;
    const def: CalendarDef = { ...draft, source: { kind: "ics", url } };
    setBusy(true);
    setError(null);
    try {
      const events = await fetchIcsCalendar(def);
      setCalendars([...loadCalendars(), def]);
      setIcs(setIcsCalendarEvents(loadIcsState(), def.id, events));
      notify(`Calendrier ICS ajouté · ${def.name} · ${events.length} événement${events.length > 1 ? "s" : ""}`);
      return true;
    } catch (failure) {
      const message = errorText(failure);
      notify(`Import ICS impossible · ${message}`);
      return fail(message);
    } finally {
      setBusy(false);
    }
  };

  const importIcsFile = async (input: { file: File; name: string; tone: number }) => {
    const draft = draftFor(input.name, icsNameFromFile(input.file.name), input.tone);
    if (!draft) return false;
    const def: CalendarDef = { ...draft, source: { kind: "ics" } };
    setBusy(true);
    setError(null);
    try {
      const content = await input.file.text();
      if (!content.trim()) throw new Error("fichier vide");
      const events = await importIcsContent(def, content);
      setCalendars([...loadCalendars(), def]);
      setIcs(setIcsCalendarEvents(loadIcsState(), def.id, events));
      notify(`Calendrier ICS ajouté · ${def.name} · ${events.length} événement${events.length > 1 ? "s" : ""}`);
      return true;
    } catch (failure) {
      const message = errorText(failure);
      notify(`Import ICS impossible · ${message}`);
      return fail(message);
    } finally {
      setBusy(false);
    }
  };

  /** Le calendrier vit côté agenda du compte : seul un cache d'événements le complète. */
  const addGoogle = async (
    account: ApiAccount,
    calendar: GoogleCalendar,
    input: { name: string; tone: number },
  ) => {
    const draft = draftFor(input.name, calendar.summary.trim() || calendar.id, input.tone);
    if (!draft) return false;
    const def: CalendarDef = {
      ...draft,
      source: { kind: "google", accountId: account.id, calendarId: calendar.id },
    };
    setCalendars([...loadCalendars(), def]);
    setError(null);
    notify(`Calendrier Google ajouté · ${def.name}`);
    try {
      setIcs(setIcsCalendarEvents(loadIcsState(), def.id, await fetchGoogleCalendar(def)));
    } catch (failure) {
      setError(
        `Source ajoutée, événements non lus · ${failure instanceof ApiError ? failure.message : errorText(failure)}`,
      );
    }
    return true;
  };

  const rename = (id: string, rawName: string) => {
    const name = rawName.trim();
    if (!name) return fail("Nom du calendrier requis");
    const list = loadCalendars();
    if (list.some((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) {
      return fail(`Calendrier déjà présent · ${name}`);
    }
    setCalendars(list.map((entry) => (entry.id === id ? { ...entry, name } : entry)));
    setError(null);
    notify(`Calendrier renommé · ${name}`);
    return true;
  };

  const setTone = (id: string, tone: number) => {
    setCalendars(loadCalendars().map((entry) => (entry.id === id ? { ...entry, tone } : entry)));
  };

  /** Une source CalDAV part aussi du démon : sans lui, elle reviendrait au prochain ajout. */
  const remove = async (id: string) => {
    const list = loadCalendars();
    const target = list.find((entry) => entry.id === id);
    if (!target) return false;
    const sourceId = caldavSourceIdOf(target);
    if (sourceId) {
      try {
        await mailApi.removeCaldavSource(sourceId);
      } catch (failure) {
        const message = errorText(failure);
        notify(`Suppression CalDAV impossible · ${message}`);
        return fail(message);
      }
    }
    setCalendars(list.filter((entry) => entry.id !== id));
    if (isExternalCalendar(target)) setIcs(dropIcsCalendar(loadIcsState(), id));
    if (sourceId) {
      setCaldavSources((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
    }
    setError(null);
    notify(`Calendrier supprimé · ${target.name}`);
    return true;
  };

  const refresh = async (def: CalendarDef) => {
    if (!isExternalCalendar(def)) return fail("Calendrier local : rien à relire");
    if (isIcsCalendar(def) && !icsUrlOf(def)) return fail("Fichier importé : rien à relire");
    setRefreshing(def.id);
    setError(null);
    try {
      const events = await fetchExternalCalendar(def);
      setIcs(setIcsCalendarEvents(loadIcsState(), def.id, events));
      notify(`Calendrier relu · ${def.name} · ${events.length} événement${events.length > 1 ? "s" : ""}`);
      return true;
    } catch (failure) {
      const message = errorText(failure);
      notify(`Relecture impossible · ${message}`);
      return fail(message);
    } finally {
      setRefreshing(null);
    }
  };

  /** Ce qui situe une source dans la liste : URL, fichier importé ou compte de l'agenda. */
  const detailOf = (def: CalendarDef) => {
    if (isIcsCalendar(def)) return icsUrlOf(def) ?? "fichier importé";
    const ref = googleRefOf(def);
    if (ref) {
      const email = accounts.find((account) => account.id === ref.accountId)?.email;
      return `${email ?? ref.accountId} · ${ref.calendarId}`;
    }
    const sourceId = caldavSourceIdOf(def);
    const url = sourceId ? caldavSources[sourceId]?.url : undefined;
    const accountId = calendarAccountId(def);
    const email = accountId ? accounts.find((account) => account.id === accountId)?.email : undefined;
    if (url && email) return `${email} · ${url}`;
    return url ?? email;
  };

  return {
    calendars,
    busy,
    refreshing,
    error,
    accounts,
    googleConnected,
    googleCalendars,
    googleBusy,
    googleErrors,
    loadGoogleCalendars,
    googleAttached: (accountId, calendarIdValue) =>
      calendars.some((entry) => {
        const ref = googleRefOf(entry);
        return ref?.accountId === accountId && ref.calendarId === calendarIdValue;
      }),
    caldavAttached: (accountId) => accountCalendarAttached(accountId, calendars),
    countOf: (id) => (ics.events[id] ?? []).length,
    detailOf,
    paused: (def) => !calendarActivated(def),
    addLocal,
    addCaldav,
    addCaldavFromAccount,
    discoverCollections,
    accountCollections,
    sourceCollections,
    collectionOf,
    setCollection,
    subscribeIcs,
    importIcsFile,
    addGoogle,
    rename,
    setTone,
    remove,
    refresh,
  };
}
