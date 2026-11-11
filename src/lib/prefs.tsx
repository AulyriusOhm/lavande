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

import { EMPTY_LLM, type LlmConfig } from "@/lib/llm";
import { DEFAULT_AI_TASKS, DEFAULT_SUMMARY, type AiTasksConfig, type SummaryConfig } from "@/lib/summary";

export type AccountSignature = { html: string; enabled: boolean };

/** Domaines dont la synchronisation peut être coupée indépendamment. */
export type SyncPrefs = {
  enabled: boolean;
  mails: boolean;
  calendar: boolean;
  kanban: boolean;
};

export const DEFAULT_SYNC: SyncPrefs = { enabled: true, mails: true, calendar: true, kanban: true };


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
  signatures: Record<string, AccountSignature>;
  llm: LlmConfig;
  /** Suggestions de réponse générées par le LLM (sinon repli local). */
  aiReplyEnabled: boolean;
  summary: SummaryConfig;
  /** Suggestions de tâches extraites des mails récents par le LLM. */
  aiTasks: AiTasksConfig;
  /** Interrupteurs de synchronisation : maître + un par domaine. */
  sync: SyncPrefs;
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
  signatures: {},
  llm: EMPTY_LLM,
  aiReplyEnabled: true,
  summary: DEFAULT_SUMMARY,
  aiTasks: DEFAULT_AI_TASKS,
  sync: DEFAULT_SYNC,
};

type PrefsContextValue = Prefs & {
  setSwipe: (side: "left" | "right", action: SwipeActionId) => void;
  setPgpEncrypt: (value: boolean) => void;
  setPgpSign: (value: boolean) => void;
  setAttachPublicKey: (value: boolean) => void;
  setMcpConfirmSend: (value: boolean) => void;
  setCalendarEnabled: (value: boolean) => void;
  setPlanningEnabled: (value: boolean) => void;
  setMcpEnabled: (serverId: string, value: boolean) => void;
  setSignature: (accountId: string, patch: Partial<AccountSignature>) => void;
  setLlm: (patch: Partial<LlmConfig>) => void;
  setAiReplyEnabled: (value: boolean) => void;
  setSummary: (patch: Partial<SummaryConfig>) => void;
  setAiTasks: (patch: Partial<AiTasksConfig>) => void;
  setSync: (patch: Partial<SyncPrefs>) => void;
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

const asAiTasks = (value: unknown): AiTasksConfig => {
  if (!value || typeof value !== "object") return { ...DEFAULT_AI_TASKS };
  const { enabled, windowHours } = value as Record<string, unknown>;
  return {
    enabled: asBoolean(enabled, DEFAULT_AI_TASKS.enabled),
    windowHours:
      typeof windowHours === "number" && Number.isFinite(windowHours) && windowHours >= 1
        ? Math.min(168, Math.round(windowHours))
        : DEFAULT_AI_TASKS.windowHours,
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

export function activeSignature(
  signatures: Record<string, AccountSignature>,
  accountId: string,
): string | null {
  const entry = signatures[accountId];
  if (!entry || !entry.enabled || !entry.html.trim()) return null;
  return entry.html;
}

function read(): Prefs {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    stored = {};
  }
  return {
    swipeLeft: asSwipe(stored.swipeLeft, DEFAULTS.swipeLeft),
    swipeRight: asSwipe(stored.swipeRight, DEFAULTS.swipeRight),
    pgpEncrypt: asBoolean(stored.pgpEncrypt, DEFAULTS.pgpEncrypt),
    pgpSign: asBoolean(stored.pgpSign, DEFAULTS.pgpSign),
    attachPublicKey: asBoolean(stored.attachPublicKey, DEFAULTS.attachPublicKey),
    mcpConfirmSend: asBoolean(stored.mcpConfirmSend, DEFAULTS.mcpConfirmSend),
    calendarEnabled: asBoolean(stored.calendarEnabled, DEFAULTS.calendarEnabled),
    planningEnabled: asBoolean(stored.planningEnabled, DEFAULTS.planningEnabled),
    mcpEnabled: asFlags(stored.mcpEnabled),
    signatures: asSignatures(stored.signatures),
    llm: asLlm(stored.llm),
    aiReplyEnabled: asBoolean(stored.aiReplyEnabled, DEFAULTS.aiReplyEnabled),
    summary: asSummary(stored.summary),
    aiTasks: asAiTasks(stored.aiTasks),
    sync: asSync(stored.sync),
  };
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(read);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const patch = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }));
  }, []);

  const setSwipe = useCallback(
    (side: "left" | "right", action: SwipeActionId) =>
      patch(side === "left" ? "swipeLeft" : "swipeRight", action),
    [patch],
  );
  const setPgpEncrypt = useCallback((value: boolean) => patch("pgpEncrypt", value), [patch]);
  const setPgpSign = useCallback((value: boolean) => patch("pgpSign", value), [patch]);
  const setAttachPublicKey = useCallback((value: boolean) => patch("attachPublicKey", value), [patch]);
  const setMcpConfirmSend = useCallback((value: boolean) => patch("mcpConfirmSend", value), [patch]);
  const setCalendarEnabled = useCallback((value: boolean) => patch("calendarEnabled", value), [patch]);
  const setPlanningEnabled = useCallback((value: boolean) => patch("planningEnabled", value), [patch]);
  const setMcpEnabled = useCallback(
    (serverId: string, value: boolean) =>
      setPrefs((current) => ({
        ...current,
        mcpEnabled: { ...current.mcpEnabled, [serverId]: value },
      })),
    [],
  );
  const setSignature = useCallback(
    (accountId: string, patch: Partial<AccountSignature>) =>
      setPrefs((current) => ({
        ...current,
        signatures: {
          ...current.signatures,
          [accountId]: { ...(current.signatures[accountId] ?? { html: "", enabled: true }), ...patch },
        },
      })),
    [],
  );

  const setLlm = useCallback(
    (patch: Partial<LlmConfig>) =>
      setPrefs((current) => ({ ...current, llm: { ...current.llm, ...patch } })),
    [],
  );

  const setAiReplyEnabled = useCallback((value: boolean) => patch("aiReplyEnabled", value), [patch]);

  const setSummary = useCallback(
    (patch: Partial<SummaryConfig>) =>
      setPrefs((current) => ({ ...current, summary: { ...current.summary, ...patch } })),
    [],
  );

  const setAiTasks = useCallback(
    (patch: Partial<AiTasksConfig>) =>
      setPrefs((current) => ({ ...current, aiTasks: { ...current.aiTasks, ...patch } })),
    [],
  );

  const setSync = useCallback(
    (patch: Partial<SyncPrefs>) =>
      setPrefs((current) => ({ ...current, sync: { ...current.sync, ...patch } })),
    [],
  );

  const value = useMemo<PrefsContextValue>(
    () => ({
      ...prefs,
      setSwipe,
      setPgpEncrypt,
      setPgpSign,
      setAttachPublicKey,
      setMcpConfirmSend,
      setCalendarEnabled,
      setPlanningEnabled,
      setMcpEnabled,
      setSignature,
      setLlm,
      setAiReplyEnabled,
      setSummary,
      setAiTasks,
      setSync,
    }),
    [
      prefs,
      setSwipe,
      setPgpEncrypt,
      setPgpSign,
      setAttachPublicKey,
      setMcpConfirmSend,
      setCalendarEnabled,
      setPlanningEnabled,
      setMcpEnabled,
      setSignature,
      setLlm,
      setAiReplyEnabled,
      setSummary,
      setAiTasks,
      setSync,
    ],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const context = useContext(PrefsContext);
  if (!context) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return context;
}
