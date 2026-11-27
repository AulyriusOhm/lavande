import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { shellLayout } from "@/lib/native";
import { isTauriShell } from "@/lib/open-external";
import { applySystemBars } from "@/lib/system-bars";

export const ACCENT_PRESETS = [
  { name: "Lavande", value: "#705ce8" },
  { name: "Iris", value: "#5550e6" },
  { name: "Lilas", value: "#9333ea" },
  { name: "Rose poudré", value: "#d92672" },
  { name: "Menthe", value: "#047857" },
  { name: "Océan", value: "#0369a1" },
  { name: "Ambre", value: "#b45309" },
  { name: "Corail", value: "#dc264c" },
  { name: "Graphite", value: "#54647a" },
];

/** Anciennes teintes pastel des préréglages : migrées vers leurs versions contrastées (texte blanc ≥ 4,5:1). */
const LEGACY_PRESET_MAP: Record<string, string> = {
  "#8b7cf6": "#705ce8",
  "#6366f1": "#5550e6",
  "#c084fc": "#9333ea",
  "#f472b6": "#d92672",
  "#34d399": "#047857",
  "#38bdf8": "#0369a1",
  "#f59e0b": "#b45309",
  "#fb7185": "#dc264c",
  "#64748b": "#54647a",
};

const DEFAULT_ACCENT = ACCENT_PRESETS[0].value;
const STORAGE_KEY = "lavande.theme";
const CONTRAST_LIGHT = "#ffffff";
const CONTRAST_DARK = "#1b1523";
const CONTRAST_FALLBACK = "#000000";
const CONTRAST_MIN = 4.5;
const THEME_INK = { light: "#1b1523", dark: "#f4f1fa" };
const TAG_TINT = 0.16;
const TAG_SURFACES = {
  light: ["#fbfaff", "#ffffff", "#f6f3fd"],
  dark: ["#0e0c13", "#16131f", "#1d1929"],
};
const THEME_COLOR = { light: "#fbfaff", dark: "#0e0c13" };

export type ThemeMode = "light" | "dark" | "auto";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

type ThemeContextValue = {
  accent: string;
  dark: boolean;
  mode: ThemeMode;
  brand: string;
  setAccent: (value: string) => void;
  setMode: (mode: ThemeMode) => void;
  setDark: (value: boolean) => void;
  reset: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

type Stored = { accent?: string; dark?: boolean; mode?: ThemeMode };

function readStored(): Stored {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Stored;
    if (typeof parsed.accent === "string") {
      const migrated = LEGACY_PRESET_MAP[parsed.accent.toLowerCase()];
      if (migrated) return { ...parsed, accent: migrated };
    }
    return parsed;
  } catch {
    return {};
  }
}

function channel(value: number) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function toChannels(hex: string) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((part) => part + part).join("") : clean;
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
}

function luminance(hex: string) {
  const [r, g, b] = toChannels(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function tinted(colour: string, alpha: number, background: string) {
  const foreground = toChannels(colour);
  const under = toChannels(background);
  const channels = foreground.map((value, index) => Math.round(value * alpha + under[index]! * (1 - alpha)));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function contrastRatio(a: string, b: string) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function accentContrast(accent: string) {
  const light = contrastRatio(accent, CONTRAST_LIGHT);
  const dark = contrastRatio(accent, CONTRAST_DARK);
  if (light >= dark) return CONTRAST_LIGHT;
  if (dark >= CONTRAST_MIN) return CONTRAST_DARK;
  const black = contrastRatio(accent, CONTRAST_FALLBACK);
  return black > light ? CONTRAST_FALLBACK : CONTRAST_LIGHT;
}

export function accountTint(colour: string) {
  return `color-mix(in oklab, ${colour} ${Math.round(TAG_TINT * 100)}%, transparent)`;
}

export function accountLabelInk(colour: string, dark: boolean) {
  const backgrounds = TAG_SURFACES[dark ? "dark" : "light"].map((surface) => tinted(colour, TAG_TINT, surface));
  const worst = (ink: string) => Math.min(...backgrounds.map((background) => contrastRatio(ink, background)));
  const preferred = THEME_INK[dark ? "dark" : "light"];
  if (worst(preferred) >= CONTRAST_MIN) return preferred;
  return worst(CONTRAST_FALLBACK) >= worst(CONTRAST_LIGHT) ? CONTRAST_FALLBACK : CONTRAST_LIGHT;
}

function storedMode(): ThemeMode {
  const stored = readStored();
  if (stored.mode === "light" || stored.mode === "dark" || stored.mode === "auto") return stored.mode;
  return stored.dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [accent, setAccentState] = useState(() => readStored().accent ?? DEFAULT_ACCENT);
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (mode !== "auto") return;
    if (isTauriShell() && shellLayout() === "desktop") {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void import("@tauri-apps/api/window")
        .then(async ({ getCurrentWindow }) => {
          const win = getCurrentWindow();
          const current = await win.theme();
          if (disposed) return;
          if (current) setSystemDark(current === "dark");
          unlisten = await win.onThemeChanged(({ payload }) => setSystemDark(payload === "dark"));
          if (disposed) unlisten();
        })
        .catch(() => {});
      return () => {
        disposed = true;
        unlisten?.();
      };
    }
    const query = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
    const sync = () => setSystemDark(query?.matches ?? false);
    sync();
    query?.addEventListener("change", sync);
    return () => query?.removeEventListener("change", sync);
  }, [mode]);

  const dark = mode === "auto" ? systemDark : mode === "dark";

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ accent, mode }));
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-contrast", accentContrast(accent));
    root.classList.toggle("dark", dark);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
    void applySystemBars(dark).catch(() => undefined);
  }, [accent, dark, mode]);

  const setAccent = useCallback((value: string) => setAccentState(value), []);
  const setMode = useCallback((value: ThemeMode) => setModeState(value), []);
  const setDark = useCallback((value: boolean) => setModeState(value ? "dark" : "light"), []);
  const reset = useCallback(() => {
    setAccentState(DEFAULT_ACCENT);
    setModeState("light");
  }, []);

  const value = useMemo(
    () => ({ accent, dark, mode, brand: dark ? "Orchidée" : "Lavande", setAccent, setMode, setDark, reset }),
    [accent, dark, mode, setAccent, setMode, setDark, reset],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
