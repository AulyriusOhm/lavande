import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CloudOff, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { errorText, mailApi, type ApiFolder, type ApiFolderRole } from "@/lib/api";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge, DButton, SectionLabel, Surface } from "@/desktop/ui";

const ROLE_LABEL: Record<ApiFolderRole, string> = {
  inbox: "Réception",
  sent: "Envoyés",
  drafts: "Brouillons",
  archive: "Archives",
  trash: "Corbeille",
  spam: "Indésirables",
  other: "Autre",
};

const WHEN = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

const lastSync = (value: string | null) => {
  if (!value) return "jamais";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "jamais" : WHEN.format(date);
};

const keyOf = (accountId: string, path: string) => `${accountId}\u0000${path}`;

export function MailSyncPanel() {
  const { accounts, mode, notify } = useMailStore();
  const [folders, setFolders] = useState<ApiFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (mode !== "api") {
        setFolders([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const lists = await Promise.all(accounts.map((entry) => mailApi.folders(entry.id)));
        if (!signal?.aborted) setFolders(lists.flat());
      } catch (failure) {
        if (signal?.aborted || (failure instanceof DOMException && failure.name === "AbortError")) return;
        setFolders([]);
        setError(errorText(failure));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [accounts, mode],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const desync = async (accountId: string, folder: ApiFolder) => {
    setBusy(keyOf(accountId, folder.path));
    setError(null);
    try {
      await mailApi.desyncFolder(accountId, folder.path);
      setConfirming(null);
      notify(`« ${folder.name} » désynchronisé · le prochain sync le relira`);
      await load();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  if (mode !== "api") {
    return (
      <Surface className="p-4">
        <p className="text-[12px] font-semibold leading-relaxed text-ink-soft">
          La synchronisation des mails est pilotée par le service mail local. Lance l'application de
          bureau pour voir les dossiers réellement mis en cache.
        </p>
      </Surface>
    );
  }

  return (
    <div className="space-y-3">
      <Surface className="flex flex-wrap items-center gap-2 px-3.5 py-2">
        <SectionLabel>Cache local</SectionLabel>
        <span className="text-[10.5px] font-semibold text-ink-muted">
          {folders === null
            ? "chargement…"
            : `${folders.length} dossier${folders.length > 1 ? "s" : ""} suivi${folders.length > 1 ? "s" : ""}`}
        </span>
        <DButton
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Rafraîchir
        </DButton>
      </Surface>

      {error ? (
        <Surface className="border-amber-500/40 bg-amber-500/[0.06] px-3.5 py-2.5">
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed font-semibold text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        </Surface>
      ) : null}

      {folders !== null && folders.length === 0 ? (
        <Surface className="px-3.5 py-3">
          <p className="text-[11.5px] font-medium text-ink-muted">
            Aucun dossier synchronisé pour le moment.
          </p>
        </Surface>
      ) : null}

      {accounts.map((account) => {
        const owned = (folders ?? []).filter((folder) => folder.account_id === account.id);
        if (folders === null || owned.length === 0) return null;
        return (
          <Surface key={account.id} className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: account.color }}
              />
              <p className="truncate text-[12px] font-bold text-ink">{account.label}</p>
              <span className="truncate text-[10.5px] font-medium text-ink-muted">{account.email}</span>
            </div>
            <div className="divide-y divide-line">
              {owned.map((folder) => {
                const key = keyOf(account.id, folder.path);
                const pending = confirming === key;
                const working = busy === key;
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[12px] font-bold text-ink">{folder.name}</p>
                        <Badge tone={folder.role === "inbox" ? "accent" : "neutral"}>
                          {ROLE_LABEL[folder.role]}
                        </Badge>
                      </div>
                      <p className="truncate font-mono text-[10px] font-medium text-ink-muted">
                        {folder.path} · uidnext {folder.uidnext}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted">
                      {lastSync(folder.last_sync_at)}
                    </span>
                    {pending ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="text-[10.5px] font-semibold text-ink-soft">
                          Purger le cache local ?
                        </span>
                        <DButton
                          variant="plain"
                          size="sm"
                          disabled={working}
                          onClick={() => setConfirming(null)}
                        >
                          <X className="size-3.5" />
                          Annuler
                        </DButton>
                        <DButton
                          variant="danger"
                          size="sm"
                          aria-label={`Confirmer la désynchronisation de ${folder.name}`}
                          disabled={working}
                          onClick={() => void desync(account.id, folder)}
                        >
                          {working ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          Désync
                        </DButton>
                      </span>
                    ) : (
                      <DButton
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        aria-label={`Désynchroniser ${folder.name}`}
                        disabled={working}
                        onClick={() => setConfirming(key)}
                      >
                        {working ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <CloudOff className="size-3.5" />
                        )}
                        Désync
                      </DButton>
                    )}
                  </div>
                );
              })}
            </div>
          </Surface>
        );
      })}
    </div>
  );
}
