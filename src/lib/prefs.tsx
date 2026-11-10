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
const DEFAULTS = { swipeLeft: "delete" as SwipeActionId, swipeRight: "reply" as SwipeActionId };

type PrefsContextValue = {
  swipeLeft: SwipeActionId;
  swipeRight: SwipeActionId;
  setSwipe: (side: "left" | "right", action: SwipeActionId) => void;
};

const PrefsContext = createContext<PrefsContextValue | null>(null);

type Stored = Partial<{ swipeLeft: SwipeActionId; swipeRight: SwipeActionId }>;

function read(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [swipeLeft, setSwipeLeft] = useState<SwipeActionId>(() => read().swipeLeft ?? DEFAULTS.swipeLeft);
  const [swipeRight, setSwipeRight] = useState<SwipeActionId>(() => read().swipeRight ?? DEFAULTS.swipeRight);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ swipeLeft, swipeRight }));
  }, [swipeLeft, swipeRight]);

  const setSwipe = useCallback((side: "left" | "right", action: SwipeActionId) => {
    if (side === "left") setSwipeLeft(action);
    else setSwipeRight(action);
  }, []);

  const value = useMemo(
    () => ({ swipeLeft, swipeRight, setSwipe }),
    [swipeLeft, swipeRight, setSwipe],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const context = useContext(PrefsContext);
  if (!context) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return context;
}
