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

export type Prefs = {
  swipeLeft: SwipeActionId;
  swipeRight: SwipeActionId;
  pgpEncrypt: boolean;
  pgpSign: boolean;
  attachPublicKey: boolean;
  mcpConfirmSend: boolean;
  mcpEnabled: Record<string, boolean>;
};

const DEFAULTS: Prefs = {
  swipeLeft: "delete",
  swipeRight: "reply",
  pgpEncrypt: true,
  pgpSign: true,
  attachPublicKey: false,
  mcpConfirmSend: true,
  mcpEnabled: {},
};

type PrefsContextValue = Prefs & {
  setSwipe: (side: "left" | "right", action: SwipeActionId) => void;
  setPgpEncrypt: (value: boolean) => void;
  setPgpSign: (value: boolean) => void;
  setAttachPublicKey: (value: boolean) => void;
  setMcpConfirmSend: (value: boolean) => void;
  setMcpEnabled: (serverId: string, value: boolean) => void;
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
    mcpEnabled: asFlags(stored.mcpEnabled),
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
  const setMcpEnabled = useCallback(
    (serverId: string, value: boolean) =>
      setPrefs((current) => ({
        ...current,
        mcpEnabled: { ...current.mcpEnabled, [serverId]: value },
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
      setMcpEnabled,
    }),
    [prefs, setSwipe, setPgpEncrypt, setPgpSign, setAttachPublicKey, setMcpConfirmSend, setMcpEnabled],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const context = useContext(PrefsContext);
  if (!context) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return context;
}
