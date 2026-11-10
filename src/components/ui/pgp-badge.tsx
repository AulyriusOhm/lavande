import { Lock, ShieldCheck } from "lucide-react";
import type { PgpState } from "@/lib/mail";
import { cn } from "@/lib/utils";

export function PgpBadge({
  state,
  compact = false,
  className,
}: {
  state: PgpState;
  compact?: boolean;
  className?: string;
}) {
  if (state === "none") return null;

  const encrypted = state === "encrypted";

  return (
    <span
      title={encrypted ? "Chiffré de bout en bout (PGP)" : "Signature PGP vérifiée"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-bold",
        compact ? "size-5 justify-center" : "px-2 py-0.5 text-[10px]",
        encrypted ? "bg-accent-soft text-accent-ink" : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        className,
      )}
    >
      {encrypted ? (
        <Lock className={compact ? "size-3" : "size-3"} strokeWidth={2.6} />
      ) : (
        <ShieldCheck className={compact ? "size-3.5" : "size-3"} strokeWidth={2.6} />
      )}
      {!compact && (encrypted ? "Chiffré" : "Signé")}
    </span>
  );
}
