import { RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ReauthPopupAlert = {
  accountId: string;
  label: string;
  email: string;
};

export type ReauthPopupProps = {
  alert: ReauthPopupAlert | null;
  onDismiss: () => void;
  onReconnect: (accountId: string) => void;
};

export function ReauthPopup({ alert, onDismiss, onReconnect }: ReauthPopupProps) {
  if (!alert) return null;

  const accountName = alert.label.trim() || alert.accountId;

  return (
    <div
      role="alert"
      aria-label={`Connexion expirée pour ${accountName}`}
      className={cn(
        "pointer-events-auto fixed top-3 right-3 left-3 z-[55] sm:top-5 sm:right-5 sm:left-auto sm:w-[360px]",
        "rounded-3xl border border-accent-ring bg-surface p-4 shadow-xl",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
          <RefreshCw className="size-4.5" strokeWidth={2.2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-bold tracking-[0.14em] text-accent-ink uppercase">
            Connexion expirée
          </p>
          <p className="truncate text-[14px] font-extrabold tracking-tight text-ink">{accountName}</p>
          {alert.email ? (
            <p className="truncate text-[11.5px] font-medium text-ink-muted">{alert.email}</p>
          ) : null}
        </div>

        <button
          type="button"
          aria-label="Fermer"
          onClick={onDismiss}
          className="focus-ring -mt-1 -mr-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-4" strokeWidth={2.2} />
        </button>
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed font-medium text-ink-muted">
        La connexion de ce compte a expiré. Reconnecte-toi pour reprendre la synchronisation.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onReconnect(alert.accountId)}
          className="focus-ring inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent px-3.5 text-[12.5px] font-bold text-accent-contrast shadow-[0_8px_20px_-10px_var(--accent)] transition-all hover:brightness-105 active:scale-95"
        >
          <RefreshCw className="size-4" strokeWidth={2.2} />
          <span>Se reconnecter</span>
        </button>
      </div>
    </div>
  );
}
