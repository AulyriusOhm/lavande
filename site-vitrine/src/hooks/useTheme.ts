import { useCallback, useEffect, useState } from "react";

const SITE_KEY = "lavande.site.theme";
const DEMO_KEY = "lavande.theme";

export type Theme = "dark" | "light";

function readSiteTheme(): Theme {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" ? "light" : "dark";
}

export function writeDemoTheme(theme: Theme) {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const current = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    localStorage.setItem(DEMO_KEY, JSON.stringify({ ...current, mode: theme }));
  } catch {
    /* stockage indisponible : la démo garde son thème par défaut */
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readSiteTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#fbfaff" : "#0e0c13");
    try {
      localStorage.setItem(SITE_KEY, theme);
    } catch {
      /* stockage indisponible : le thème reste valable pour la session */
    }
    writeDemoTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      writeDemoTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
