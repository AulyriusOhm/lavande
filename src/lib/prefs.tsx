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

export type AccountSignature = { html: string; enabled: boolean };

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
    ],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const context = useContext(PrefsContext);
  if (!context) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return context;
}
