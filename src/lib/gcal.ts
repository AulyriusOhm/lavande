/**
 * Comptes Google connectés : le refresh token reste au démon, le front ne
 * connaît que des identifiants de calendrier. Reconnaître un compte Google se
 * fait sur sa configuration (OAuth2 Google, hôtes Gmail), jamais sur le seul
 * domaine de l'adresse.
 */

import type { ApiAccount, GoogleCalendar } from "@/lib/api";
import { googleRefOf, type CalendarDef } from "@/lib/calendars";

/** Un agenda Google répond vite : son cache se périme comme celui d'un serveur CalDAV. */
export const GOOGLE_REFRESH_MS = 15 * 60 * 1000;

/** Fenêtre relue : trois mois passés, un an à venir. */
export const GOOGLE_WINDOW_PAST_DAYS = 90;
export const GOOGLE_WINDOW_FUTURE_DAYS = 365;

const GOOGLE_HOSTS = ["gmail.com", "googlemail.com", "google.com"];

const GOOGLE_TOKEN_HOST = "googleapis.com";

/** Ce que la configuration d'un compte laisse voir : aucun secret n'en sort. */
export type GoogleAccountInfo = {
  email?: string;
  imap?: { host?: string };
  smtp?: { host?: string };
  auth?: { kind?: string; token_endpoint?: string };
};

function isGoogleHost(host: string | undefined): boolean {
  const name = host?.trim().toLowerCase() ?? "";
  if (!name) return false;
  return GOOGLE_HOSTS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

export function isGoogleAccount(account: GoogleAccountInfo): boolean {
  const endpoint = account.auth?.token_endpoint?.trim().toLowerCase() ?? "";
  if (account.auth?.kind === "oauth2" && endpoint.includes(GOOGLE_TOKEN_HOST)) return true;
  if (isGoogleHost(account.imap?.host) || isGoogleHost(account.smtp?.host)) return true;
  return /@(gmail|googlemail)\.com$/i.test(account.email?.trim() ?? "");
}

export function googleAccounts(accounts: ApiAccount[]): ApiAccount[] {
  return accounts.filter(isGoogleAccount);
}

export function googleWindow(now = new Date()): { time_min: string; time_max: string } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate() - GOOGLE_WINDOW_PAST_DAYS);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + GOOGLE_WINDOW_FUTURE_DAYS);
  return { time_min: start.toISOString(), time_max: end.toISOString() };
}

/**
 * Calendrier Google à attacher automatiquement quand un compte est connecté :
 * le principal (agenda par défaut), à défaut le premier. Rien si un calendrier
 * du compte est déjà dans l'agenda, si la liste est vide, ou si le nom entre en
 * conflit avec un calendrier existant. Pur : la décision se teste sans React.
 */
export function googleAutoAttachTarget(
  accountId: string,
  list: GoogleCalendar[],
  existing: CalendarDef[],
): GoogleCalendar | undefined {
  if (existing.some((entry) => googleRefOf(entry)?.accountId === accountId)) return undefined;
  const primary = list.find((calendar) => calendar.primary) ?? list[0];
  if (!primary) return undefined;
  const name = primary.summary.trim() || primary.id;
  if (!name) return undefined;
  if (existing.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) return undefined;
  return primary;
}
