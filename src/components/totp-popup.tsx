import { useEffect, useState } from "react";
import { Check, CheckCheck, Copy, ExternalLink, KeyRound, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type TotpPopupAlert = {
  code: string;
  service: string;
  mailId: string;
  receivedAt: number;
};

export type TotpPopupProps = {
  alert: TotpPopupAlert | null;
  onDismiss: () => void;
  onOpenMail?: (mailId: string) => void;
  onMarkRead?: (mailId: string) => void;
};

const AUTO_DISMISS_MS = 90_000;
const COPIED_CLOSE_DELAY_MS = 900;

export function formatTotpCode(raw: string): string {
  const clean = raw.trim();
  if (/^\d{6}$/.test(clean)) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  if (/^\d{8}$/.test(clean)) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return clean;
}

export function TotpPopup({ alert, onDismiss, onOpenMail, onMarkRead }: TotpPopupProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
    if (!alert) return;
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [alert, onDismiss]);

  useEffect(() => {
    if (!copied || !alert) return;
    const timer = window.setTimeout(onDismiss, COPIED_CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [copied, alert, onDismiss]);

  if (!alert) return null;

  const formattedCode = formatTotpCode(alert.code);
  const serviceName = alert.service.trim() || "Vérification";

  const handleCopy = () => {
    try {
      void Promise.resolve(navigator.clipboard?.writeText(alert.code)).catch(() => {});
    } catch {
      // presse-papiers indisponible
    }
    setCopied(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Code de vérification ${serviceName}`}
      className={cn(
        "pointer-events-auto fixed top-3 right-3 left-3 z-[55] sm:top-5 sm:right-5 sm:left-auto sm:w-[360px]",
        "rounded-3xl border border-accent-ring bg-surface p-4 shadow-xl",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-ink">
          <KeyRound className="size-4.5" strokeWidth={2.2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-bold tracking-[0.14em] text-accent-ink uppercase">
            Code de vérification
          </p>
          <p className="truncate text-[14px] font-extrabold tracking-tight text-ink">
            {serviceName}
          </p>
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

      <div className="mt-3 rounded-2xl border border-line bg-surface-2/70 px-3.5 py-2.5 text-center">
        <span
          data-testid="totp-code-value"
          className="font-mono text-[26px] leading-none font-extrabold tracking-[0.22em] text-ink tabular-nums select-all"
        >
          {formattedCode}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "focus-ring inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-bold transition-all active:scale-95",
            copied
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-accent text-accent-contrast shadow-[0_8px_20px_-10px_var(--accent)] hover:brightness-105",
          )}
        >
          {copied ? <Check className="size-4" strokeWidth={2.5} /> : <Copy className="size-4" strokeWidth={2.2} />}
          <span>{copied ? "Copié !" : "Copier"}</span>
        </button>

        {onMarkRead ? (
          <button
            type="button"
            onClick={() => {
              onMarkRead(alert.mailId);
              onDismiss();
            }}
            aria-label="Marquer comme lu"
            className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-ink"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.2} />
            <span>Lu</span>
          </button>
        ) : null}

        {onOpenMail ? (
          <button
            type="button"
            onClick={() => {
              onOpenMail(alert.mailId);
              onDismiss();
            }}
            aria-label="Ouvrir le mail"
            className="focus-ring inline-flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-ink"
          >
            <ExternalLink className="size-3.5" strokeWidth={2.2} />
            <span>Ouvrir</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
