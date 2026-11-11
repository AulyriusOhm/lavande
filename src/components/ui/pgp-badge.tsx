import { Lock, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { ApiPgpDetail } from "@/lib/api";
import type { PgpState } from "@/lib/mail";
import { messagePgpStatus, type PgpMessageStatus } from "@/lib/pgp";
import { cn } from "@/lib/utils";

/** Badge d'un message décrit par son statut PGP (`messagePgpStatus`). */
export function PgpStatusBadge({
  status,
  compact = false,
  className,
}: {
  status: PgpMessageStatus;
  compact?: boolean;
  className?: string;
}) {
  const invalid = status.verification === "invalid";
  const verified = status.verification === "verified";
  const encrypted = status.state === "encrypted";

  const tone = invalid
    ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
    : verified
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
      : encrypted
        ? "bg-accent-soft text-accent-ink"
        : "bg-surface-2 text-ink-soft";

  const label = invalid ? "Signature invalide" : encrypted ? "Chiffré" : "Signé";

  const title = invalid
    ? "La signature PGP ne correspond pas au contenu : message suspect"
    : encrypted
      ? "Chiffré de bout en bout (PGP)"
      : verified
        ? "Signature PGP vérifiée"
        : "Signature PGP présente, vérification indisponible";

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-bold",
        compact ? "size-5 justify-center" : "px-2 py-0.5 text-[10px]",
        tone,
        className,
      )}
    >
      {invalid ? (
        <ShieldAlert className="size-3" strokeWidth={2.6} />
      ) : encrypted ? (
        <Lock className="size-3" strokeWidth={2.6} />
      ) : verified ? (
        <ShieldCheck className={compact ? "size-3.5" : "size-3"} strokeWidth={2.6} />
      ) : (
        <ShieldQuestion className="size-3" strokeWidth={2.6} />
      )}
      {!compact && label}
    </span>
  );
}

/** Variante `state` + `detail` : seul `state` est nécessaire dans les listes. */
export function PgpBadge({
  state,
  detail,
  compact = false,
  className,
}: {
  state: PgpState;
  detail?: ApiPgpDetail | null;
  compact?: boolean;
  className?: string;
}) {
  const status = messagePgpStatus({ pgp: state, pgp_detail: detail });
  if (!status) return null;
  return <PgpStatusBadge status={status} compact={compact} className={className} />;
}

/** Bandeau de lecture : chiffrement, signature, signataire et erreur éventuelle. */
export function PgpNotice({ status, className }: { status: PgpMessageStatus; className?: string }) {
  const invalid = status.verification === "invalid";
  const encrypted = status.state === "encrypted";

  const lines: string[] = [];
  if (encrypted) {
    lines.push(
      status.verification === null
        ? "Chiffré avec ta clé publique · déchiffré localement"
        : status.decrypted
          ? "Chiffré avec ta clé publique · déchiffré localement"
          : "Chiffré de bout en bout · déchiffrement local impossible",
    );
  }
  if (invalid) {
    lines.push("Signature PGP invalide : le contenu ne correspond pas au signataire");
  } else if (status.verification === "verified") {
    lines.push(status.signer ? `Signature vérifiée · ${status.signer}` : "Signature PGP vérifiée");
  } else if (status.verification === "unverified") {
    lines.push(
      status.signer
        ? `Signature non vérifiée · ${status.signer}`
        : "Signature PGP : clé du signataire inconnue",
    );
  } else if (!encrypted) {
    lines.push("Message signé (PGP)");
  }

  return (
    <div
      className={cn(
        "mt-3 rounded-2xl px-3 py-2",
        invalid ? "bg-amber-500/12" : "bg-accent-soft/80",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {invalid ? (
          <ShieldAlert className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" strokeWidth={2.6} />
        ) : encrypted ? (
          <Lock className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.6} />
        ) : status.verification === "verified" ? (
          <ShieldCheck className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" strokeWidth={2.6} />
        ) : (
          <ShieldQuestion className="size-3.5 shrink-0 text-ink-soft" strokeWidth={2.6} />
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          {lines.map((line) => (
            <p
              key={line}
              className={cn(
                "text-[10.5px] leading-snug font-semibold",
                invalid ? "text-amber-700 dark:text-amber-300" : "text-accent-ink",
              )}
            >
              {line}
            </p>
          ))}
        </div>
      </div>
      {status.error ? (
        <p className="mt-1 px-5 text-[10px] leading-snug font-medium text-ink-muted">{status.error}</p>
      ) : null}
    </div>
  );
}
