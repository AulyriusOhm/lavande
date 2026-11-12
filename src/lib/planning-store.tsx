import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { MAIL_SUGGESTIONS, TASKS, TASK_STATES, sortTasks, taskFromSuggestion } from "@/lib/tasks";
import { EVENTS, type CalendarEvent } from "@/lib/calendar";
import { mailMode } from "@/lib/mail-backend";
import { usePrefs } from "@/lib/prefs";
import type { MailSuggestion, Subtask, Task, TaskState } from "@/lib/tasks";
import { createClock, type Clock } from "@/lib/sync/clock";
import type { EntityKind } from "@/lib/sync/crypto";
import { createSyncEngine, type SyncEngine, type SyncStatus } from "@/lib/sync/engine";
import {
  applyOp,
  LOCAL_SCHEMA_VERSION,
  promotedTaskId,
  suggestionId,
  visibleDocs,
  type DecodedOp,
  type Doc,
} from "@/lib/sync/merge";
import { createLocalStorageSyncStorage, type SyncStorage, type SyncState } from "@/lib/sync/storage";

const TASK_FIELDS = [
  "title",
  "meta",
  "state",
  "due",
  "dueTone",
  "dueDate",
  "progress",
  "description",
  "subtasks",
  "mailId",
] as const;

const TASK_STATE_IDS: TaskState[] = TASK_STATES.map((entry) => entry.id);
const DUE_TONES: Task["dueTone"][] = ["late", "soon", "soft", "none"];
const SUGGESTION_PREFIX = "sg:";

export type PlanningValue = {
  tasks: Task[];
  suggestions: MailSuggestion[];
  events: CalendarEvent[];
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setEvents: Dispatch<SetStateAction<CalendarEvent[]>>;
  addSuggestion: (suggestion: MailSuggestion) => void;
  proposeSuggestion: (suggestion: MailSuggestion) => void;
  dismissSuggestion: (suggestion: MailSuggestion) => void;
  readOnlyIds: Set<string>;
  sync: SyncStatus;
  syncNow: () => Promise<void>;
  unpromote: (suggestion: MailSuggestion) => void;
  engine: SyncEngine;
};

const PlanningContext = createContext<PlanningValue | null>(null);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function projectSubtasks(value: unknown[]): Subtask[] {
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({ title: text(entry.title), done: entry.done === true }));
}

function projectTask(doc: Doc): Task {
  const raw = doc.raw;
  const task: Task = {
    id: doc.id,
    title: text(raw.title),
    meta: text(raw.meta),
    state: oneOf(TASK_STATE_IDS, raw.state, "todo"),
    due: text(raw.due),
    dueTone: oneOf(DUE_TONES, raw.dueTone, "none"),
  };
  if (typeof raw.dueDate === "string") task.dueDate = raw.dueDate;
  if (typeof raw.progress === "number") task.progress = raw.progress;
  if (typeof raw.description === "string") task.description = raw.description;
  if (Array.isArray(raw.subtasks)) task.subtasks = projectSubtasks(raw.subtasks);
  if (typeof raw.mailId === "string") task.mailId = raw.mailId;
  return task;
}

function projectSuggestion(doc: Doc): MailSuggestion | null {
  const raw = doc.raw;
  if (raw.status !== "pending") return null;
  const suggestion: MailSuggestion = {
    id: doc.id,
    mailId: text(raw.mailId),
    account: text(raw.account),
    from: text(raw.from),
    subject: text(raw.subject),
    proposal: text(raw.proposal),
    due: text(raw.due),
    dueTone: oneOf(DUE_TONES, raw.dueTone, "none"),
    tone: typeof raw.tone === "number" ? raw.tone : 0,
    description: text(raw.description),
  };
  if (raw.ai === true) suggestion.ai = true;
  if (typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)) {
    suggestion.timestamp = raw.timestamp;
  }
  return suggestion;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskPatch(previous: Task | undefined, next: Task): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of TASK_FIELDS) {
    const value = next[field];
    const before = previous?.[field];
    if (value === undefined) {
      if (before !== undefined) patch[field] = null;
      continue;
    }
    if (previous !== undefined && sameValue(before, value)) continue;
    patch[field] = value;
  }
  return patch;
}

function taskFields(task: Task): Record<string, unknown> {
  return taskPatch(undefined, task);
}

function suggestionDocId(suggestion: MailSuggestion): string {
  if (suggestion.id.startsWith(SUGGESTION_PREFIX)) return suggestion.id;
  return suggestionId(`${suggestion.account}:${suggestion.mailId}`, suggestion.proposal);
}

function suggestionFields(
  suggestion: MailSuggestion,
  status: "pending" | "accepted" | "dismissed",
  taskId?: string,
): Record<string, unknown> {
  return {
    status,
    ...(taskId === undefined ? {} : { taskId }),
    mailId: suggestion.mailId,
    account: suggestion.account,
    ...(suggestion.ai ? { ai: true } : {}),
    from: suggestion.from,
    subject: suggestion.subject,
    proposal: suggestion.proposal,
    due: suggestion.due,
    dueTone: suggestion.dueTone,
    tone: suggestion.tone,
    description: suggestion.description,
    ...(suggestion.timestamp === undefined ? {} : { timestamp: suggestion.timestamp }),
  };
}

export function readOnlyIdsOf(state: SyncState): Set<string> {
  return new Set(
    visibleDocs(state.docs, "task")
      .filter((doc) => doc.readOnly)
      .map((doc) => doc.id),
  );
}

export function projectTasks(state: SyncState): Task[] {
  return sortTasks(visibleDocs(state.docs, "task").map(projectTask));
}

export function projectSuggestions(state: SyncState): MailSuggestion[] {
  return visibleDocs(state.docs, "suggestion")
    .map(projectSuggestion)
    .filter((entry): entry is MailSuggestion => entry !== null);
}

const EVENT_FIELDS = [
  "date",
  "start",
  "end",
  "title",
  "location",
  "description",
  "tone",
  "fromMail",
  "mailId",
  "attendees",
  "calendar",
] as const;

function projectEvent(doc: Doc): CalendarEvent {
  const raw = doc.raw;
  const event: CalendarEvent = {
    id: doc.id,
    date: text(raw.date),
    start: text(raw.start),
    end: text(raw.end),
    title: text(raw.title),
    tone: typeof raw.tone === "number" ? raw.tone : undefined,
  };
  if (typeof raw.location === "string") event.location = raw.location;
  if (typeof raw.description === "string") event.description = raw.description;
  if (raw.fromMail === true) event.fromMail = true;
  if (typeof raw.mailId === "string") event.mailId = raw.mailId;
  if (Array.isArray(raw.attendees)) event.attendees = raw.attendees.filter((a): a is string => typeof a === "string");
  if (typeof raw.calendar === "string") event.calendar = raw.calendar;
  return event;
}

function eventPatch(previous: CalendarEvent | undefined, next: CalendarEvent): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of EVENT_FIELDS) {
    const value = next[field];
    const before = previous?.[field];
    if (value === undefined) {
      if (before !== undefined) patch[field] = null;
      continue;
    }
    if (previous !== undefined && sameValue(before, value)) continue;
    patch[field] = value;
  }
  return patch;
}

function eventFields(event: CalendarEvent): Record<string, unknown> {
  return eventPatch(undefined, event);
}

export function projectEvents(state: SyncState): CalendarEvent[] {
  return visibleDocs(state.docs, "event")
    .map(projectEvent)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

const LEGACY_EVENTS_KEY = "lavande.events.v1";

/**
 * Migration : reprend les événements déjà stockés localement. En mode api, un
 * planning vierge reste vierge : seules les données réelles sont reprises.
 */
function initialEvents(): CalendarEvent[] {
  try {
    const raw = window.localStorage.getItem(LEGACY_EVENTS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is CalendarEvent =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as CalendarEvent).id === "string" &&
            typeof (entry as CalendarEvent).date === "string" &&
            typeof (entry as CalendarEvent).title === "string",
        );
      }
    }
  } catch {
    // stockage corrompu : on repart d'un planning vide (ou de la démo)
  }
  return mailMode() === "demo" ? EVENTS : [];
}

/** Fenêtre par défaut du filtre d'affichage des suggestions issues des mails. */
export const DEFAULT_SUGGESTION_WINDOW_HOURS = 48;

/**
 * Une suggestion issue d'un mail reste affichée tant que ce mail est dans la
 * fenêtre. Les suggestions sans horodatage (démo, saisie manuelle) sont gardées.
 */
export function suggestionInWindow(
  suggestion: MailSuggestion,
  windowHours = DEFAULT_SUGGESTION_WINDOW_HOURS,
  now = Date.now(),
): boolean {
  if (typeof suggestion.timestamp !== "number" || !Number.isFinite(suggestion.timestamp)) return true;
  const hours =
    typeof windowHours === "number" && Number.isFinite(windowHours) && windowHours > 0
      ? windowHours
      : DEFAULT_SUGGESTION_WINDOW_HOURS;
  return suggestion.timestamp >= now - hours * 3_600_000;
}

export function suggestionsInWindow(
  suggestions: MailSuggestion[],
  windowHours = DEFAULT_SUGGESTION_WINDOW_HOURS,
  now = Date.now(),
): MailSuggestion[] {
  return suggestions.filter((suggestion) => suggestionInWindow(suggestion, windowHours, now));
}

function hasPlanningDocs(state: SyncState): boolean {
  return Object.values(state.docs).some((doc) => doc.kind === "task" || doc.kind === "suggestion");
}

export function PlanningProvider({ children, storage }: { children: ReactNode; storage?: SyncStorage }) {
  const { sync: syncPrefs } = usePrefs();
  const kanbanSync = syncPrefs.enabled && syncPrefs.kanban;
  const calendarSync = syncPrefs.enabled && syncPrefs.calendar;
  const syncStorage = useMemo(() => storage ?? createLocalStorageSyncStorage(), [storage]);
  const engine = useMemo(() => createSyncEngine(syncStorage), [syncStorage]);
  const clock = useMemo<Clock>(() => createClock(syncStorage.read().device.id), [syncStorage]);

  const versionRef = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const bump = () => {
        versionRef.current += 1;
        onChange();
      };
      const stopEngine = engine.subscribe(bump);
      const stopStorage = syncStorage.subscribe(bump);
      return () => {
        stopEngine();
        stopStorage();
      };
    },
    [engine, syncStorage],
  );
  const getVersion = useCallback(() => versionRef.current, []);
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);

  const state = useMemo(() => engine.getState(), [engine, version]);

  const applyLocal = useCallback(
    (kind: EntityKind, id: string, patch: Record<string, unknown>, op: "upsert" | "delete") => {
      const current = syncStorage.read();
      const decoded: DecodedOp = {
        kind,
        entityRef: `${kind}:${id}`,
        hlc: clock.tick(),
        schemaVersion: LOCAL_SCHEMA_VERSION,
        payload: { id, kind, v: LOCAL_SCHEMA_VERSION, op, ...(op === "delete" ? {} : { patch }) },
      };
      const applied = applyOp(current.docs, current.refs, decoded);
      if (!applied.changed) return;
      syncStorage.write({ ...current, docs: applied.docs, refs: applied.refs });
    },
    [clock, syncStorage],
  );

  const emit = useCallback(
    (kind: EntityKind, id: string, patch: Record<string, unknown>, op: "upsert" | "delete" = "upsert") => {
      if (!engine.canEmit()) {
        applyLocal(kind, id, patch, op);
        return;
      }
      engine.emitLocal(kind, id, patch, op);
    },
    [applyLocal, engine],
  );

  useEffect(() => {
    const kinds: EntityKind[] = [];
    if (kanbanSync) kinds.push("task", "suggestion");
    if (calendarSync) kinds.push("event");
    engine.setEnabledKinds(kinds);
    const anySync = kanbanSync || calendarSync;
    engine.setPaused(!anySync);
    if (!anySync) return;
    return engine.start();
  }, [engine, kanbanSync, calendarSync]);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    // Les fixtures de la maquette ne sont semées qu'en mode démo : en api le
    // planning démarre vide et ne contient que les données de l'utilisateur.
    if (mailMode() !== "demo") return;
    const initial = syncStorage.read();
    if (!hasPlanningDocs(initial)) {
      for (const task of TASKS) emit("task", task.id, taskFields(task));
      for (const suggestion of MAIL_SUGGESTIONS) {
        emit("suggestion", suggestionDocId(suggestion), suggestionFields(suggestion, "pending"));
      }
    }
    if (visibleDocs(initial.docs, "event").length === 0) {
      for (const event of initialEvents()) emit("event", event.id, eventFields(event));
    }
  }, [emit, syncStorage]);

  const tasks = useMemo(() => projectTasks(state), [state]);
  const suggestions = useMemo(() => projectSuggestions(state), [state]);
  const events = useMemo(() => projectEvents(state), [state]);
  const readOnlyIds = useMemo(() => readOnlyIdsOf(state), [state]);

  const latest = useRef({ tasks, readOnlyIds });
  latest.current = { tasks, readOnlyIds };

  const setTasks = useCallback<Dispatch<SetStateAction<Task[]>>>(
    (action) => {
      const previous = latest.current.tasks;
      const readOnly = latest.current.readOnlyIds;
      const next = typeof action === "function" ? action(previous) : action;
      const previousById = new Map(previous.map((task) => [task.id, task]));
      const nextIds = new Set(next.map((task) => task.id));
      for (const task of next) {
        if (readOnly.has(task.id)) continue;
        const patch = taskPatch(previousById.get(task.id), task);
        if (Object.keys(patch).length === 0) continue;
        emit("task", task.id, patch);
      }
      for (const task of previous) {
        if (nextIds.has(task.id) || readOnly.has(task.id)) continue;
        emit("task", task.id, {}, "delete");
      }
      const fresh = syncStorage.read();
      latest.current = { tasks: projectTasks(fresh), readOnlyIds: readOnlyIdsOf(fresh) };
    },
    [emit, syncStorage],
  );

  const latestEvents = useRef(events);
  latestEvents.current = events;

  const setEvents = useCallback<Dispatch<SetStateAction<CalendarEvent[]>>>(
    (action) => {
      const previous = latestEvents.current;
      const next = typeof action === "function" ? action(previous) : action;
      const previousById = new Map(previous.map((event) => [event.id, event]));
      const nextIds = new Set(next.map((event) => event.id));
      for (const event of next) {
        if (engine.readOnly("event", event.id)) continue;
        const patch = eventPatch(previousById.get(event.id), event);
        if (Object.keys(patch).length === 0) continue;
        emit("event", event.id, patch);
      }
      for (const event of previous) {
        if (nextIds.has(event.id) || engine.readOnly("event", event.id)) continue;
        emit("event", event.id, {}, "delete");
      }
      latestEvents.current = projectEvents(syncStorage.read());
    },
    [emit, engine, syncStorage],
  );

  const addSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      const id = suggestionDocId(suggestion);
      const taskId = promotedTaskId(id);
      emit("suggestion", id, { status: "accepted", taskId });
      emit("task", taskId, taskFields(taskFromSuggestion(suggestion, taskId)));
    },
    [emit],
  );

  const proposeSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      const id = suggestionDocId(suggestion);
      const known = visibleDocs(syncStorage.read().docs, "suggestion");
      if (known.some((doc) => doc.id === id)) return;
      emit("suggestion", id, suggestionFields(suggestion, "pending"));
    },
    [emit, syncStorage],
  );

  const dismissSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      emit("suggestion", suggestionDocId(suggestion), { status: "dismissed" });
    },
    [emit],
  );

  const syncNow = useCallback(() => engine.syncNow(), [engine]);

  const unpromote = useCallback(
    (suggestion: MailSuggestion) => {
      const id = suggestionDocId(suggestion);
      emit("task", promotedTaskId(id), {}, "delete");
      emit("suggestion", id, { status: "pending" });
    },
    [emit],
  );

  const value = useMemo<PlanningValue>(
    () => ({
      tasks,
      suggestions,
      events,
      setTasks,
      setEvents,
      addSuggestion,
      proposeSuggestion,
      dismissSuggestion,
      readOnlyIds,
      sync: engine.getStatus(),
      syncNow,
      unpromote,
      engine,
    }),
    [addSuggestion, proposeSuggestion, dismissSuggestion, engine, events, readOnlyIds, setEvents, setTasks, suggestions, syncNow, tasks, unpromote, state],
  );

  return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningValue {
  const value = useContext(PlanningContext);
  if (value === null) throw new Error("usePlanning doit être utilisé dans un PlanningProvider");
  return value;
}
