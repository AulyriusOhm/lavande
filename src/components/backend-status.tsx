import { AlertTriangle, Loader2, Lock, RefreshCw, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useMailStore } from "@/lib/store";
import { useEscapeLayer } from "@/desktop/escape";
import { cn } from "@/lib/utils";

const SPRING = { type: "spring", stiffness: 320, damping: 32 } as const;

export function BackendBanner({ variant = "mobile" }: { variant?: "mobile" | "desktop" }) {
  const { phase, backendError, retryBackend, useDemo, mode } = useMailStore();
  if (mode !== "api" || phase !== "offline") return null;

  return (
    <div
      role="alert"
      className={cn(
        "relative z-[60] flex flex-col gap-2 border-b border-rose-200 bg-rose-500/10 px-4 py-3 text-rose-700 dark:border-rose-500/30 dark:text-rose-200",
        variant === "desktop" ? "sm:flex-row sm:items-center sm:gap-3" : "",
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
        <div className="min-w-0 leading-snug">
          <p className="text-[12px] font-bold">
            Le service mail local ne répond pas. Démarre-le avec{" "}
            <code className="rounded bg-rose-500/15 px-1 py-0.5 font-mono text-[11px]">
              scripts/mail-service.sh start
            </code>
            .
          </p>
          {backendError ? (
            <p className="mt-0.5 truncate text-[10.5px] font-semibold opacity-80">{backendError}</p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 self-start sm:ml-auto sm:self-auto">
        <button
          type="button"
          onClick={retryBackend}
          className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border border-rose-300 bg-surface px-3 text-[12px] font-bold text-rose-700 transition-colors hover:bg-rose-500/10 dark:border-rose-500/40 dark:text-rose-200"
        >
          <RefreshCw className="size-3.5" />
          Réessayer
        </button>
        {import.meta.env.VITE_DISTRIBUTION === "1" ? null : (
          <button
            type="button"
            onClick={useDemo}
            className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[12px] font-bold text-accent-ink transition-colors hover:bg-accent-ring/40"
          >
            Voir la démo
          </button>
        )}
      </div>
    </div>
  );
}

export function AccountRemoveDialog({ variant = "sheet" }: { variant?: "sheet" | "dialog" }) {
  const { removeTarget, cancelRemoveAccount, confirmRemoveAccount } = useMailStore();
  useEscapeLayer(variant === "dialog" && Boolean(removeTarget), cancelRemoveAccount);
  if (!removeTarget) return null;

  const body = (
    <>
      <div className="flex items-start gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rose-500/12 text-rose-700 dark:text-rose-300">
          <Trash2 className="size-4" />
        </span>
        <div className="min-w-0 leading-tight">
          <p className="text-[14px] font-extrabold tracking-tight text-ink">
            Retirer « {removeTarget.label} » ?
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed font-medium text-ink-muted">
            Le compte et sa copie locale des messages sont supprimés. Rien n'est effacé sur le
            serveur : tu pourras le reconnecter plus tard.
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={cancelRemoveAccount}
          className="focus-ring inline-flex min-h-11 items-center rounded-full px-4 text-[12px] font-bold text-ink-soft transition-colors hover:bg-surface-2"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={confirmRemoveAccount}
          className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border border-rose-300 bg-rose-500/10 px-4 text-[12px] font-bold text-rose-700 transition-colors hover:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300"
        >
          <Trash2 className="size-3.5" />
          Retirer le compte
        </button>
      </div>
    </>
  );

  if (variant === "dialog") {
    return (
      <div className="absolute inset-0 z-[70] grid place-items-center px-6">
        <button
          type="button"
          aria-label="Annuler le retrait du compte"
          onClick={cancelRemoveAccount}
          className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
        />
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={`Retirer le compte ${removeTarget.label}`}
          initial={{ opacity: 0, y: 10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="relative w-[420px] max-w-full rounded-[26px] border border-line bg-surface p-5 shadow-[0_44px_96px_-48px_var(--accent)]"
        >
          {body}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-[70]">
      <button
        type="button"
        aria-label="Annuler le retrait du compte"
        onClick={cancelRemoveAccount}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Retirer le compte ${removeTarget.label}`}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        transition={SPRING}
        className="absolute inset-x-0 bottom-0 rounded-t-[32px] border-t border-line bg-canvas px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
        {body}
      </motion.div>
    </div>
  );
}

export function BackendLoading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-[12.5px] font-semibold text-ink-muted">
      <Loader2 className="size-4 animate-spin" />
      Connexion au service mail local…
    </div>
  );
}

/** Démo vitrine : la coquille est navigable, rien ne s'écrit, rien ne part. */
export function ReadOnlyBanner({ variant = "mobile" }: { variant?: "mobile" | "desktop" }) {
  const { readOnly } = useMailStore();
  if (!readOnly) return null;

  return (
    <div
      role="status"
      data-demo-readonly
      className={cn(
        "relative z-[60] flex items-center gap-2 border-b border-accent-ring/40 bg-accent-soft px-4 py-1.5 text-accent-ink",
        variant === "desktop" && "justify-center",
      )}
    >
      <Lock className="size-3.5 shrink-0" strokeWidth={2.4} />
      <p className="text-[11.5px] font-bold tracking-tight">
        Démo · lecture seule
        <span className="ml-1.5 font-semibold opacity-70">
          données d'exemple, aucune action enregistrée
        </span>
      </p>
    </div>
  );
}
