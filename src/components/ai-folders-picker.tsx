import { useEffect, useState } from "react";
import { FolderTree } from "lucide-react";
import { errorText, mailApi, type ApiFolder } from "@/lib/api";
import type { Account } from "@/lib/accounts";
import { isReceptionSelection, receptionPaths } from "@/lib/mail-backend";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const SHAPES = {
  desktop: "px-1.5 py-1 text-[11.5px]",
  mobile: "px-2.5 py-2 text-[12.5px]",
} as const;

/**
 * Dossiers dont les mails nourrissent le résumé, les suggestions de tâches et de
 * rendez-vous et le tri automatique. `null` = la réception (INBOX + dossiers
 * perso), `[]` = aucun : chaque changement part aussitôt au service.
 */
export function AiFoldersPicker({
  account,
  variant = "desktop",
}: {
  account: Account;
  variant?: "desktop" | "mobile";
}) {
  const { mode, notify, applyAiFolders } = useMailStore();
  const [folders, setFolders] = useState<ApiFolder[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "api") return;
    let cancelled = false;
    mailApi
      .folders(account.id)
      .then((found) => {
        if (!cancelled) setFolders(found);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [account.id, mode]);

  if (mode !== "api") return null;

  const list = folders ?? [];
  const chosen = account.aiFolders ?? null;
  const checked = chosen === null ? receptionPaths(list) : chosen;
  const scope =
    checked.length === 0
      ? "Aucun dossier analysé"
      : chosen === null
        ? "Réception (INBOX + dossiers perso)"
        : `${checked.length} dossier${checked.length > 1 ? "s" : ""} analysé${checked.length > 1 ? "s" : ""}`;

  const save = (next: string[]) => {
    setSaving(true);
    setError(null);
    mailApi
      .setAiFolders(account.id, isReceptionSelection(next, list) ? null : next)
      .then((summary) => {
        applyAiFolders(account.id, summary.ai_folders ?? null);
        notify(`Dossiers analysés par l'IA · ${account.label}`);
      })
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setSaving(false));
  };

  const togglePath = (path: string) => {
    const next = checked.includes(path)
      ? checked.filter((entry) => entry !== path)
      : [...checked, path];
    save(next);
  };

  return (
    <div className="pb-1.5">
      <div className="flex items-center gap-2 px-3.5 pt-1.5 pb-1">
        <FolderTree className="size-4 shrink-0 text-ink-muted" />
        <p className="min-w-0 flex-1 truncate text-[12px] font-bold text-ink">Dossiers analysés par l'IA</p>
        <p className="shrink-0 text-[11.5px] font-semibold text-ink-muted">{scope}</p>
      </div>
      {folders === null ? (
        <p className="px-3.5 py-1.5 text-[11px] font-semibold text-ink-muted">Dossiers…</p>
      ) : (
        <div className="mt-1 max-h-44 overflow-y-auto px-2">
          {list.map((folder) => (
            <label
              key={folder.path}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-xl font-semibold text-ink-soft hover:bg-surface-2",
                SHAPES[variant],
              )}
            >
              <input
                type="checkbox"
                aria-label={`Analyser ${folder.name}`}
                className="size-3.5 shrink-0 accent-[var(--accent)]"
                checked={checked.includes(folder.path)}
                disabled={saving}
                onChange={() => togglePath(folder.path)}
              />
              <span className="truncate">{folder.name}</span>
              <span className="ml-auto truncate text-[12px] font-medium text-ink-muted">
                {folder.path}
              </span>
            </label>
          ))}
        </div>
      )}
      {error ? (
        <p className="px-3.5 pt-1 text-[11.5px] font-semibold text-rose-700 dark:text-rose-300">{error}</p>
      ) : null}
    </div>
  );
}
