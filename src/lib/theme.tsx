import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export const ACCENT_PRESETS = [
  { name: "Lavande", value: "#8b7cf6" },
  { name: "Iris", value: "#6366f1" },
  { name: "Lilas", value: "#c084fc" },
  { name: "Rose poudré", value: "#f472b6" },
  { name: "Menthe", value: "#34d399" },
  { name: "Océan", value: "#38bdf8" },
  { name: "Ambre", value: "#f59e0b" },
  { name: "Corail", value: "#fb7185" },
  { name: "Graphite", value: "#64748b" },
];

const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;
const STORAGE_KEY = "lavande.theme";

type ThemeContextValue = {
  accent: string;
  dark: boolean;
  brand: string;
  setAccent: (value: string) => void;
  setDark: (value: boolean) => void;
  reset: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

type Stored = { accent?: string; dark?: boolean };

function readStored(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccentState] = useState(() => readStored().accent ?? DEFAULT_ACCENT);
  const [dark, setDarkState] = useState(() => readStored().dark ?? false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ accent, dark }));
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.classList.toggle("dark", dark);
  }, [accent, dark]);

  const setAccent = useCallback((value: string) => setAccentState(value), []);
  const setDark = useCallback((value: boolean) => setDarkState(value), []);
  const reset = useCallback(() => {
    setAccentState(DEFAULT_ACCENT);
    setDarkState(false);
  }, []);

  const value = useMemo(
    () => ({ accent, dark, brand: dark ? "Orchidée" : "Lavande", setAccent, setDark, reset }),
    [accent, dark, setAccent, setDark, reset],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
