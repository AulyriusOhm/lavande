/**
 * Zimbra du compte mail : le démon lit son CalDAV (l'agenda, rangé comme source)
 * et son CardDAV (l'annuaire, rangé dans la liste des contacts), Basic avec le
 * mot de passe du compte. Le front ne connaît que l'identifiant de la source,
 * jamais un identifiant DAV.
 */

import { useEffect, useRef } from "react";
import { mailApi, type ApiAccount, type CaldavSource } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";
import { demoReadOnly } from "@/lib/mail-backend";

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

/** Garde locale du carnet : un compte lu une fois n'est pas relu à chaque démarrage. */
export const ZIMBRA_CONTACTS_KEY = "lavande.zimbra.contacts.v1";

function syncedAccounts(): Set<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(ZIMBRA_CONTACTS_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? (stored as string[]) : []);
  } catch {
    return new Set();
  }
}

function markSynced(accountId: string): void {
  const synced = syncedAccounts();
  synced.add(accountId);
  try {
    window.localStorage.setItem(ZIMBRA_CONTACTS_KEY, JSON.stringify([...synced]));
  } catch {
    /* stockage indisponible : le carnet sera relu au prochain démarrage */
  }
}

/** Le message d'une synchronisation réussie : le compte de contacts, et ce qui a été écarté. */
export function contactsReport(report: { count: number; skipped: number }): string {
  const found = report.count === 1 ? "1 contact" : `${report.count} contacts`;
  if (report.skipped === 0) return `Carnet synchronisé · ${found}`;
  const skipped = report.skipped === 1 ? "1 carte illisible" : `${report.skipped} cartes illisibles`;
  return `Carnet synchronisé · ${found} · ${skipped} ignorée${report.skipped > 1 ? "s" : ""}`;
}

/**
 * Lit le carnet CardDAV du compte dans la liste des contacts du démon. La garde
 * locale retient le compte : une synchronisation manuelle n'est pas rejouée.
 */
export async function syncAccountContacts(accountId: string): Promise<string> {
  const report = await mailApi.syncCarddav(accountId);
  markSynced(accountId);
  return contactsReport(report);
}

/**
 * Premier carnet lu à l'ouverture d'un compte : le démon découvre le CardDAV du
 * compte avec son mot de passe. Un échec (compte OAuth, serveur muet, pas de
 * DAV) reste silencieux et vaut un essai, comme l'agenda du compte.
 */
export function useZimbraContactsAutoSync(): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || demoReadOnly) return;
    done.current = true;
    let cancelled = false;
    void (async () => {
      let accounts: ApiAccount[];
      try {
        accounts = await mailApi.accounts();
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(accounts)) return;
      const synced = syncedAccounts();
      for (const account of accounts) {
        if (synced.has(account.id)) continue;
        try {
          await mailApi.syncCarddav(account.id);
        } catch {
          markSynced(account.id);
          continue;
        }
        if (cancelled) return;
        markSynced(account.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
