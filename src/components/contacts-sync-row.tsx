/**
 * Ligne « Contacts » d'un compte dans les réglages : le carnet CardDAV (annuaire
 * Zimbra) se lit à la demande, et les adresses remontent par la liste de
 * contacts que la saisie interroge déjà. Rien à régler ici, un bouton et une
 * notice honnête sur ce qui a été lu.
 */

import { useState } from "react";
import { RefreshCw, Users } from "lucide-react";
import { errorText } from "@/lib/api";
import { CONTACTS_HINT } from "@/lib/prefs";
import { syncAccountContacts } from "@/lib/zimbra";
import { cn } from "@/lib/utils";

export function ContactsSyncRow({
  accountId,
  variant = "desktop",
  readOnly = false,
}: {
  accountId: string;
  variant?: "desktop" | "mobile";
  readOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const sync = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    setNotice(null);
    setFailed(false);
    try {
      setNotice(await syncAccountContacts(accountId));
    } catch (error) {
      setFailed(true);
      setNotice(`Synchronisation impossible · ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const hint = variant === "mobile" ? "text-[11px]" : "text-[10.5px]";

  return (
    <div data-testid={`contacts-sync-${accountId}`} className="px-3.5 py-3">
      <div className="flex w-full items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
          <Users className="size-4" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block text-[12.5px] font-bold text-ink">Contacts</span>
          <span className={cn("block font-medium text-ink-muted", hint)}>{CONTACTS_HINT}</span>
        </span>
        {readOnly ? null : (
          <button
            type="button"
            onClick={() => void sync()}
            disabled={busy}
            aria-busy={busy}
            aria-label="Synchroniser les contacts"
            className="focus-ring inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[11px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink disabled:opacity-60"
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} strokeWidth={2.4} />
            {busy ? "Synchronisation…" : "Synchroniser"}
          </button>
        )}
      </div>
      {notice ? (
        <p
          role={failed ? "alert" : "status"}
          aria-live="polite"
          className={cn(
            "mt-1.5 pl-11 text-[11px] font-semibold",
            failed ? "text-red-700 dark:text-red-300" : "text-ink-muted",
          )}
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
