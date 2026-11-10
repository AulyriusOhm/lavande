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
const CONTRAST_LIGHT = "#ffffff";
const CONTRAST_DARK = "#1b1523";
const CONTRAST_FALLBACK = "#000000";
const CONTRAST_MIN = 4.5;
const THEME_COLOR = { light: "#fbfaff", dark: "#0e0c13" };

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

function channel(value: number) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((part) => part + part).join("") : clean;
  const [r, g, b] = [0, 2, 4].map((offset) => channel(parseInt(full.slice(offset, offset + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function accentContrast(accent: string) {
  const light = contrastRatio(accent, CONTRAST_LIGHT);
  const dark = contrastRatio(accent, CONTRAST_DARK);
  const best = light >= dark ? CONTRAST_LIGHT : CONTRAST_DARK;
  return Math.max(light, dark) >= CONTRAST_MIN ? best : CONTRAST_FALLBACK;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccentState] = useState(() => readStored().accent ?? DEFAULT_ACCENT);
  const [dark, setDarkState] = useState(() => readStored().dark ?? false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ accent, dark }));
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-contrast", accentContrast(accent));
    root.classList.toggle("dark", dark);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
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
