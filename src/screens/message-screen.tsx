import { ArrowLeft, Archive, CornerUpLeft, CornerUpRight, Download, Lock, MoreHorizontal, Paperclip, ShieldCheck, Star, Trash2 } from "lucide-react";
import type { Mail } from "@/lib/mail";
import { cn } from "@/lib/utils";
import { Avatar, IconButton } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { MeshGlow } from "@/components/ui/backdrops";

export function MessageScreen({
  mail,
  onClose,
  onToggleStar,
  onReply,
}: {
  mail: Mail;
  onClose: () => void;
  onToggleStar: () => void;
  onReply: () => void;
}) {
  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <MeshGlow className="h-40" />

      <header className="relative z-10 flex items-center gap-1 px-2.5 pt-3 pb-1">
        <IconButton aria-label="Retour" onClick={onClose}>
          <ArrowLeft className="size-4.5" />
        </IconButton>
        <div className="ml-auto flex items-center">
          <IconButton aria-label="Archiver">
            <Archive className="size-4.5" />
          </IconButton>
          <IconButton aria-label="Supprimer">
            <Trash2 className="size-4.5" />
          </IconButton>
          <IconButton
            aria-label="Étoile"
            onClick={onToggleStar}
            className={mail.starred ? "text-amber-400" : undefined}
          >
            <Star className={cn("size-4.5", mail.starred && "fill-amber-400")} />
          </IconButton>
          <IconButton aria-label="Plus d'actions">
            <MoreHorizontal className="size-4.5" />
          </IconButton>
        </div>
      </header>

      <div className="relative flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        <BlurFade yOffset={6}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-bold text-accent-ink">
              Boîte de réception
            </span>
            {mail.attachments?.length ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[10.5px] font-semibold text-ink-soft">
                <Paperclip className="size-3" />
                {mail.attachments.length} pièce{mail.attachments.length > 1 ? "s" : ""} jointe
                {mail.attachments.length > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>

          <h1 className="mt-3 text-[22px] leading-[1.25] font-extrabold tracking-[-0.02em] text-ink">
            {mail.subject}
          </h1>
        </BlurFade>

        <BlurFade delay={0.06}>
          <div className="mt-4 flex items-center gap-3">
            <Avatar name={mail.name} tone={mail.tone} size={40} rounded="rounded-full" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-bold text-ink">{mail.name}</p>
              <p className="truncate text-[11.5px] font-medium text-ink-muted">
                à moi · {mail.time}
              </p>
            </div>
            <IconButton aria-label="Répondre" onClick={onReply} className="bg-accent-soft text-accent-ink">
              <CornerUpLeft className="size-4" />
            </IconButton>
          </div>
        </BlurFade>

        {mail.pgp !== "none" && (
          <BlurFade delay={0.09}>
            <div className="mt-3 flex items-center gap-2 rounded-2xl bg-accent-soft/80 px-3 py-2">
              {mail.pgp === "encrypted" ? (
                <Lock className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.6} />
              ) : (
                <ShieldCheck className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" strokeWidth={2.6} />
              )}
              <p className="text-[10.5px] leading-snug font-semibold text-accent-ink">
                {mail.pgp === "encrypted"
                  ? "Chiffré avec ta clé publique · déchiffré localement par le trousseau"
                  : "Signature PGP vérifiée sur la clé de l'expéditeur"}
              </p>
            </div>
          </BlurFade>
        )}

        <BlurFade delay={0.12}>
          <div className="mt-5 space-y-3.5">
            {mail.body.map((paragraph, index) => (
              <p
                key={index}
                className="text-[13.5px] leading-[1.7] font-medium whitespace-pre-line text-ink-soft"
              >
                {paragraph}
              </p>
            ))}
          </div>
        </BlurFade>

        {mail.attachments?.length ? (
          <BlurFade delay={0.18}>
            <div className="mt-6 space-y-2">
              {mail.attachments.map((file) => (
                <div
                  key={file.name}
                  className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2.5"
                >
                  <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                    <Paperclip className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-[12.5px] font-bold text-ink">{file.name}</p>
                    <p className="text-[11px] text-ink-muted">{file.size}</p>
                  </div>
                  <Download className="size-4 text-ink-muted" />
                </div>
              ))}
            </div>
          </BlurFade>
        ) : null}
      </div>

      <div className="relative border-t border-line/80 px-5 py-3 glass safe-bottom sm:pb-5">
        <div className="flex items-center gap-2">
          <ShimmerButton onClick={onReply} className="flex-1" shimmerDuration={4}>
            <CornerUpLeft className="size-4" />
            Répondre
          </ShimmerButton>
          <button
            type="button"
            className="grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
            aria-label="Transférer"
          >
            <CornerUpRight className="size-4.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
