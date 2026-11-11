import { mailMode } from "@/lib/mail-backend";
import { RECENT_SEARCHES } from "@/lib/mail";

const RECENT_KEY = "lavande.recent-searches";

/** Historique local ; les exemples de la maquette ne servent qu'en mode démo. */
export function readRecentSearches(): string[] {
  const fallback = mailMode() === "demo" ? RECENT_SEARCHES : [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  } catch {
    return fallback;
  }
}

export function writeRecentSearches(next: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    return;
  }
}
