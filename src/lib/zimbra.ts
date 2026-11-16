/**
 * Agenda Zimbra : le démon lit le CalDAV du compte mail (`/dav/`, Basic avec le
 * mot de passe du compte) et range la source. Le front ne connaît que son
 * identifiant, jamais un identifiant CalDAV.
 */

import type { CaldavSource } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";

/** Un calendrier déjà lié à ce compte mail : son agenda n'est pas rattaché deux fois. */
export function accountCalendarAttached(accountId: string, existing: CalendarDef[]): boolean {
  return existing.some(
    (entry) => entry.source?.kind === "caldav" && entry.source.accountId === accountId,
  );
}

/** Nom d'une source : celui du démon (l'hôte), à défaut l'hôte de l'URL. */
export function sourceCalendarName(source: CaldavSource): string {
  const name = source.name?.trim();
  if (name) return name;
  try {
    return new URL(source.url).hostname || "Calendrier CalDAV";
  } catch {
    return "Calendrier CalDAV";
  }
}
