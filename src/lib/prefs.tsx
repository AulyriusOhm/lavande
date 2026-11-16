import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type SwipeActionId = "none" | "delete" | "archive" | "reply" | "star" | "read";

export const SWIPE_ACTIONS: { id: SwipeActionId; label: string }[] = [
  { id: "delete", label: "Supprimer" },
  { id: "archive", label: "Archiver" },
  { id: "reply", label: "Répondre" },
  { id: "star", label: "Étoile" },
  { id: "read", label: "Lu / non lu" },
  { id: "none", label: "Aucune" },
];

const STORAGE_KEY = "lavande.prefs";

import { endpointHost, recordUsage } from "@/lib/ai-stats";
import { EMPTY_LLM, setUsageSink, type LlmConfig } from "@/lib/llm";
import { demoReadOnly } from "@/lib/mail-backend";
import { setMcpRights } from "@/lib/mcp";
import { DEFAULT_AI_TASKS, DEFAULT_SUMMARY, type AiTasksConfig, type SummaryConfig } from "@/lib/summary";

export type AccountSignature = { html: string; enabled: boolean };

/** Interrupteur PGP d'un compte : maître, chiffrement, signature. */
export type AccountPgp = { enabled: boolean; encrypt: boolean; sign: boolean };

/** Domaines dont la synchronisation peut être coupée indépendamment. */
export type SyncPrefs = {
  enabled: boolean;
  mails: boolean;
  calendar: boolean;
  kanban: boolean;
};

export const DEFAULT_SYNC: SyncPrefs = { enabled: true, mails: true, calendar: true, kanban: true };

/** Ce qu'un compte synchronise : mails, agenda, contacts. */
export type AccountPerimeter = { mails: boolean; calendar: boolean; contacts: boolean };

export const DEFAULT_PERIMETER: AccountPerimeter = { mails: true, calendar: true, contacts: false };

/** Les contacts n'ont pas encore de synchronisation : l'interrupteur est rangé, jamais ouvert. */
export const CONTACTS_PENDING = "Contacts : bientôt disponible";

/** Le périmètre a changé : les calendriers relisent la liste sans passer par le contexte. */
export const PERIMETER_EVENT = "lavande:perimeter-changed";

/** Notifications système : maître, un interrupteur par compte, rappels d'agenda. */
export type NotificationPrefs = {
  enabled: boolean;
  /** Un compte absent est notifié : seul `false` coupe ses notifications. */
  accounts: Record<string, boolean>;
  calendar: boolean;
  /** Délai du rappel avant le début d'un rendez-vous, en minutes. */
  calendarMinutes: number;
};

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  enabled: true,
  accounts: {},
  calendar: true,
  calendarMinutes: 10,
};

/** Délais de rappel proposés avant un rendez-vous, en minutes. */
export const CALENDAR_LEAD_MINUTES = [0, 5, 10, 15, 30] as const;



export type Prefs = {
  swipeLeft: SwipeActionId;
  swipeRight: SwipeActionId;
  pgpEncrypt: boolean;
  pgpSign: boolean;
  attachPublicKey: boolean;
  mcpConfirmSend: boolean;
  calendarEnabled: boolean;
  planningEnabled: boolean;
  mcpEnabled: Record<string, boolean>;
  /** Types d'action MCP dispensés de demande d'approbation. */
  mcpAlwaysAllow: Record<string, boolean>;
  signatures: Record<string, AccountSignature>;
  /** Réglages PGP explicites : un compte absent suit les défauts globaux. */
  pgpAccounts: Record<string, AccountPgp>;
  llm: LlmConfig;
  /** Suggestions de réponse générées par le LLM (sinon repli local). */
  aiReplyEnabled: boolean;
  summary: SummaryConfig;
  /** Suggestions de tâches extraites des mails récents par le LLM. */
  aiTasks: AiTasksConfig;
  /** Interrupteurs de synchronisation : maître + un par domaine. */
  sync: SyncPrefs;
  /** Dossiers personnalisés masqués de la liste, par compte (chemins IMAP). */
  hiddenFolders: Record<string, string[]>;
  /** Domaines synchronisés de chaque compte ; un compte absent suit les défauts. */
  perimeters: Record<string, AccountPerimeter>;
  /** Notifications système : nouveaux mails et rappels d'agenda. */
  notifications: NotificationPrefs;
};

const DEFAULTS: Prefs = {
  swipeLeft: "delete",
  swipeRight: "reply",
  pgpEncrypt: true,
  pgpSign: true,
  attachPublicKey: false,
  mcpConfirmSend: true,
  calendarEnabled: true,
  planningEnabled: true,
  mcpEnabled: {},
  mcpAlwaysAllow: {},
  signatures: {},
  pgpAccounts: {},
  llm: EMPTY_LLM,
  aiReplyEnabled: true,
  summary: DEFAULT_SUMMARY,
  aiTasks: DEFAULT_AI_TASKS,
  sync: DEFAULT_SYNC,
  hiddenFolders: {},
  perimeters: {},
  notifications: DEFAULT_NOTIFICATIONS,
};

type PrefsContextValue = Prefs & {
  setSwipe: (side: "left" | "right", action: SwipeActionId) => void;
  setAttachPublicKey: (value: boolean) => void;
  setCalendarEnabled: (value: boolean) => void;
  setPlanningEnabled: (value: boolean) => void;
  setMcpEnabled: (serverId: string, value: boolean) => void;
  setMcpAlwaysAllow: (type: string, value: boolean) => void;
  resetMcpAllowances: () => void;
  setSignature: (accountId: string, patch: Partial<AccountSignature>) => void;
  setAccountPgp: (accountId: string, patch: Partial<AccountPgp>) => void;
  setLlm: (patch: Partial<LlmConfig>) => void;
  setAiReplyEnabled: (value: boolean) => void;
  setSummary: (patch: Partial<SummaryConfig>) => void;
  setAiTasks: (patch: Partial<AiTasksConfig>) => void;
  setSync: (patch: Partial<SyncPrefs>) => void;
  setFolderHidden: (accountId: string, path: string, hidden: boolean) => void;
  setAccountPerimeter: (accountId: string, patch: Partial<AccountPerimeter>) => void;
  setNotifications: (patch: Partial<NotificationPrefs>) => void;
  setAccountNotification: (accountId: string, value: boolean) => void;
};

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function mergeFlags(defaults: Record<string, boolean>, stored: Record<string, boolean>) {
  return { ...defaults, ...stored };
}

const asSwipe = (value: unknown, fallback: SwipeActionId): SwipeActionId =>
  SWIPE_ACTIONS.some((action) => action.id === value) ? (value as SwipeActionId) : fallback;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asFlags = (value: unknown): Record<string, boolean> =>
  value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean"))
    : {};

const asSignatures = (value: unknown): Record<string, AccountSignature> => {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, AccountSignature> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { html, enabled } = entry as { html?: unknown; enabled?: unknown };
    if (typeof html !== "string") continue;
    out[id] = { html, enabled: typeof enabled === "boolean" ? enabled : true };
  }
  return out;
};

export const asPgpAccounts = (
  value: unknown,
  fallback: { encrypt: boolean; sign: boolean },
): Record<string, AccountPgp> => {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, AccountPgp> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { enabled, encrypt, sign } = entry as {
      enabled?: unknown;
      encrypt?: unknown;
      sign?: unknown;
    };
    if (typeof enabled !== "boolean" && typeof encrypt !== "boolean" && typeof sign !== "boolean") {
      continue;
    }
    out[id] = {
      enabled: asBoolean(enabled, true),
      encrypt: asBoolean(encrypt, fallback.encrypt),
      sign: asBoolean(sign, fallback.sign),
    };
  }
  return out;
};

const asLlm = (value: unknown): LlmConfig => {
  if (!value || typeof value !== "object") return EMPTY_LLM;
  const { endpoint, apiKey, model } = value as Record<string, unknown>;
  return {
    endpoint: typeof endpoint === "string" ? endpoint : "",
    apiKey: typeof apiKey === "string" ? apiKey : "",
    model: typeof model === "string" ? model : "",
  };
};

const hour = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback;

const asSummary = (value: unknown): SummaryConfig => {
  if (!value || typeof value !== "object") return { ...DEFAULT_SUMMARY };
  const { enabled, llmConsent, morningStart, middayStart, eveningStart, lookbackHours } =
    value as Record<string, unknown>;
  return {
    enabled: asBoolean(enabled, DEFAULT_SUMMARY.enabled),
    llmConsent: asBoolean(llmConsent, DEFAULT_SUMMARY.llmConsent),
    morningStart: hour(morningStart, DEFAULT_SUMMARY.morningStart),
    middayStart: hour(middayStart, DEFAULT_SUMMARY.middayStart),
    eveningStart: hour(eveningStart, DEFAULT_SUMMARY.eveningStart),
    lookbackHours:
      typeof lookbackHours === "number" && Number.isFinite(lookbackHours) && lookbackHours > 0
        ? Math.min(72, Math.round(lookbackHours))
        : DEFAULT_SUMMARY.lookbackHours,
  };
};

const asAccountIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id !== ""))]
    : [];

const asAiTasks = (value: unknown): AiTasksConfig => {
  if (!value || typeof value !== "object") return { ...DEFAULT_AI_TASKS };
  const { enabled, windowHours, excludedAccounts, events } = value as Record<string, unknown>;
  return {
    enabled: asBoolean(enabled, DEFAULT_AI_TASKS.enabled),
    windowHours:
      typeof windowHours === "number" && Number.isFinite(windowHours) && windowHours >= 1
        ? Math.min(168, Math.round(windowHours))
        : DEFAULT_AI_TASKS.windowHours,
    excludedAccounts: asAccountIds(excludedAccounts),
    events: asBoolean(events, DEFAULT_AI_TASKS.events),
  };
};

export const asSync = (value: unknown): SyncPrefs => {
  if (!value || typeof value !== "object") return { ...DEFAULT_SYNC };
  const { enabled, mails, calendar, kanban } = value as Record<string, unknown>;
  return {
    enabled: asBoolean(enabled, DEFAULT_SYNC.enabled),
    mails: asBoolean(mails, DEFAULT_SYNC.mails),
    calendar: asBoolean(calendar, DEFAULT_SYNC.calendar),
    kanban: asBoolean(kanban, DEFAULT_SYNC.kanban),
  };
};

export const asNotifications = (value: unknown): NotificationPrefs => {
  if (!value || typeof value !== "object") return { ...DEFAULT_NOTIFICATIONS, accounts: {} };
  const { enabled, accounts, calendar, calendarMinutes } = value as Record<string, unknown>;
  return {
    enabled: asBoolean(enabled, DEFAULT_NOTIFICATIONS.enabled),
    accounts: asFlags(accounts),
    calendar: asBoolean(calendar, DEFAULT_NOTIFICATIONS.calendar),
    calendarMinutes:
      typeof calendarMinutes === "number" && Number.isFinite(calendarMinutes) && calendarMinutes >= 0
        ? Math.min(120, Math.round(calendarMinutes))
        : DEFAULT_NOTIFICATIONS.calendarMinutes,
  };
};

/** Un compte ne reçoit de notification que si le maître et son propre interrupteur sont ouverts. */
export function notificationsForAccount(
  notifications: NotificationPrefs,
  accountId: string | null | undefined,
): boolean {
  if (!notifications.enabled) return false;
  return accountId ? notifications.accounts[accountId] !== false : true;
}

export const asPerimeters = (value: unknown): Record<string, AccountPerimeter> => {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, AccountPerimeter> = {};
  for (const [accountId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { mails, calendar, contacts } = entry as Record<string, unknown>;
    if (typeof mails !== "boolean" && typeof calendar !== "boolean" && typeof contacts !== "boolean") {
      continue;
    }
    out[accountId] = {
      mails: asBoolean(mails, DEFAULT_PERIMETER.mails),
      calendar: asBoolean(calendar, DEFAULT_PERIMETER.calendar),
      contacts: asBoolean(contacts, DEFAULT_PERIMETER.contacts),
    };
  }
  return out;
};

/** Périmètre d'un compte ; un compte jamais réglé suit les défauts (migration douce). */
export function perimeterOf(
  perimeters: Record<string, AccountPerimeter>,
  accountId: string | null | undefined,
): AccountPerimeter {
  return (accountId && perimeters[accountId]) || { ...DEFAULT_PERIMETER };
}

export const asHiddenFolders = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [accountId, paths] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(paths)) continue;
    const kept = paths.filter((path): path is string => typeof path === "string" && path !== "");
    if (kept.length > 0) out[accountId] = kept;
  }
  return out;
};

/** Un dossier masqué l'est pour un compte et un chemin IMAP précis. */
export function isFolderHidden(
  hiddenFolders: Record<string, string[]>,
  accountId: string,
  path: string,
): boolean {
  return (hiddenFolders[accountId] ?? []).includes(path);
}

export function activeSignature(
  signatures: Record<string, AccountSignature>,
  accountId: string,
): string | null {
  const entry = signatures[accountId];
  if (!entry || !entry.enabled || !entry.html.trim()) return null;
  return entry.html;
}

/** Réglage PGP explicite d'un compte, sinon les défauts globaux (migration douce). */
export function accountPgp(
  prefs: Pick<Prefs, "pgpEncrypt" | "pgpSign" | "pgpAccounts">,
  accountId: string | null | undefined,
): AccountPgp {
  const entry = accountId ? prefs.pgpAccounts[accountId] : undefined;
  if (entry) return { ...entry };
  return { enabled: true, encrypt: prefs.pgpEncrypt, sign: prefs.pgpSign };
}

/**
 * PGP effectif d'un compte : l'interrupteur maître coupe chiffrement, signature
 * et déchiffrement. Point de passage unique de la composition et de la réception.
 */
export function resolvePgp(
  prefs: Pick<Prefs, "pgpEncrypt" | "pgpSign" | "pgpAccounts">,
  accountId: string | null | undefined,
): AccountPgp {
  const entry = accountPgp(prefs, accountId);
  return {
    enabled: entry.enabled,
    encrypt: entry.enabled && entry.encrypt,
    sign: entry.enabled && entry.sign,
  };
}

function read(): Prefs {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const pgpEncrypt = asBoolean(stored.pgpEncrypt, DEFAULTS.pgpEncrypt);
  const pgpSign = asBoolean(stored.pgpSign, DEFAULTS.pgpSign);
  return {
    swipeLeft: asSwipe(stored.swipeLeft, DEFAULTS.swipeLeft),
    swipeRight: asSwipe(stored.swipeRight, DEFAULTS.swipeRight),
    pgpEncrypt,
    pgpSign,
    attachPublicKey: asBoolean(stored.attachPublicKey, DEFAULTS.attachPublicKey),
    mcpConfirmSend: asBoolean(stored.mcpConfirmSend, DEFAULTS.mcpConfirmSend),
    calendarEnabled: asBoolean(stored.calendarEnabled, DEFAULTS.calendarEnabled),
    planningEnabled: asBoolean(stored.planningEnabled, DEFAULTS.planningEnabled),
    mcpEnabled: asFlags(stored.mcpEnabled),
    mcpAlwaysAllow: asFlags(stored.mcpAlwaysAllow),
    signatures: asSignatures(stored.signatures),
    pgpAccounts: asPgpAccounts(stored.pgpAccounts, { encrypt: pgpEncrypt, sign: pgpSign }),
    llm: asLlm(stored.llm),
    aiReplyEnabled: asBoolean(stored.aiReplyEnabled, DEFAULTS.aiReplyEnabled),
    summary: asSummary(stored.summary),
    aiTasks: asAiTasks(stored.aiTasks),
    sync: asSync(stored.sync),
    hiddenFolders: asHiddenFolders(stored.hiddenFolders),
    perimeters: asPerimeters(stored.perimeters),
    notifications: asNotifications(stored.notifications),
  };
}

/** Périmètres rangés, lisibles hors React par les sources de l'agenda. */
export function storedPerimeters(): Record<string, AccountPerimeter> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return asPerimeters((parsed as Record<string, unknown>).perimeters);
  } catch {
    return {};
  }
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(read);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    setMcpRights({
      enabled: prefs.mcpEnabled,
      alwaysAllow: prefs.mcpAlwaysAllow,
      confirmSend: prefs.mcpConfirmSend,
    });
  }, [prefs.mcpEnabled, prefs.mcpAlwaysAllow, prefs.mcpConfirmSend]);

  useEffect(() => {
    setUsageSink((usage) => recordUsage(prefs.llm.model, endpointHost(prefs.llm.endpoint), usage));
    return () => setUsageSink(null);
  }, [prefs.llm.model, prefs.llm.endpoint]);

  /** Démo vitrine : les réglages s'affichent mais ne s'écrivent pas. */
  const write = useCallback((update: (current: Prefs) => Prefs) => {
    if (demoReadOnly) return;
    setPrefs(update);
  }, []);

  const patch = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => write((current) => ({ ...current, [key]: value })),
    [write],
  );

  const setSwipe = useCallback(
    (side: "left" | "right", action: SwipeActionId) =>
      patch(side === "left" ? "swipeLeft" : "swipeRight", action),
    [patch],
  );
  const setAttachPublicKey = useCallback((value: boolean) => patch("attachPublicKey", value), [patch]);
  const setCalendarEnabled = useCallback((value: boolean) => patch("calendarEnabled", value), [patch]);
  const setPlanningEnabled = useCallback((value: boolean) => patch("planningEnabled", value), [patch]);
  const setMcpEnabled = useCallback(
    (serverId: string, value: boolean) =>
      write((current) => ({
        ...current,
        mcpEnabled: { ...current.mcpEnabled, [serverId]: value },
      })),
    [],
  );
  const setMcpAlwaysAllow = useCallback(
    (type: string, value: boolean) =>
      write((current) => ({
        ...current,
        mcpAlwaysAllow: { ...current.mcpAlwaysAllow, [type]: value },
      })),
    [],
  );
  const resetMcpAllowances = useCallback(
    () => write((current) => ({ ...current, mcpAlwaysAllow: {}, mcpConfirmSend: DEFAULTS.mcpConfirmSend })),
    [],
  );
  const setSignature = useCallback(
    (accountId: string, patch: Partial<AccountSignature>) =>
      write((current) => ({
        ...current,
        signatures: {
          ...current.signatures,
          [accountId]: { ...(current.signatures[accountId] ?? { html: "", enabled: true }), ...patch },
        },
      })),
    [],
  );

  const setAccountPgp = useCallback(
    (accountId: string, patch: Partial<AccountPgp>) =>
      write((current) => ({
        ...current,
        pgpAccounts: {
          ...current.pgpAccounts,
          [accountId]: { ...accountPgp(current, accountId), ...patch },
        },
      })),
    [],
  );

  const setLlm = useCallback(
    (patch: Partial<LlmConfig>) =>
      write((current) => ({ ...current, llm: { ...current.llm, ...patch } })),
    [],
  );

  const setAiReplyEnabled = useCallback((value: boolean) => patch("aiReplyEnabled", value), [patch]);

  const setSummary = useCallback(
    (patch: Partial<SummaryConfig>) =>
      write((current) => ({ ...current, summary: { ...current.summary, ...patch } })),
    [],
  );

  const setAiTasks = useCallback(
    (patch: Partial<AiTasksConfig>) =>
      write((current) => ({ ...current, aiTasks: { ...current.aiTasks, ...patch } })),
    [],
  );

  const setSync = useCallback(
    (patch: Partial<SyncPrefs>) =>
      write((current) => ({ ...current, sync: { ...current.sync, ...patch } })),
    [],
  );

  const setFolderHidden = useCallback(
    (accountId: string, path: string, hidden: boolean) =>
      write((current) => {
        const own = current.hiddenFolders[accountId] ?? [];
        const next = hidden
          ? own.includes(path)
            ? own
            : [...own, path]
          : own.filter((entry) => entry !== path);
        const hiddenFolders = { ...current.hiddenFolders };
        if (next.length === 0) delete hiddenFolders[accountId];
        else hiddenFolders[accountId] = next;
        return { ...current, hiddenFolders };
      }),
    [],
  );

  const setAccountPerimeter = useCallback(
    (accountId: string, patch: Partial<AccountPerimeter>) =>
      write((current) => ({
        ...current,
        perimeters: {
          ...current.perimeters,
          [accountId]: { ...perimeterOf(current.perimeters, accountId), ...patch },
        },
      })),
    [],
  );

  useEffect(() => {
    window.dispatchEvent(new Event(PERIMETER_EVENT));
  }, [prefs.perimeters]);

  const setNotifications = useCallback(
    (patch: Partial<NotificationPrefs>) =>
      write((current) => ({ ...current, notifications: { ...current.notifications, ...patch } })),
    [],
  );

  const setAccountNotification = useCallback(
    (accountId: string, value: boolean) =>
      write((current) => ({
        ...current,
        notifications: {
          ...current.notifications,
          accounts: { ...current.notifications.accounts, [accountId]: value },
        },
      })),
    [],
  );


  const value = useMemo<PrefsContextValue>(
    () => ({
      ...prefs,
      setSwipe,
      setAttachPublicKey,
      setCalendarEnabled,
      setPlanningEnabled,
      setMcpEnabled,
      setMcpAlwaysAllow,
      resetMcpAllowances,
      setSignature,
      setAccountPgp,
      setLlm,
      setAiReplyEnabled,
      setSummary,
      setAiTasks,
      setSync,
      setFolderHidden,
      setAccountPerimeter,
      setNotifications,
      setAccountNotification,
    }),
    [
      prefs,
      setSwipe,
      setAttachPublicKey,
      setCalendarEnabled,
      setPlanningEnabled,
      setMcpEnabled,
      setMcpAlwaysAllow,
      resetMcpAllowances,
      setSignature,
      setAccountPgp,
      setLlm,
      setAiReplyEnabled,
      setSummary,
      setAiTasks,
      setSync,
      setFolderHidden,
      setAccountPerimeter,
      setNotifications,
      setAccountNotification,
    ],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const context = useContext(PrefsContext);
  if (!context) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return context;
}
