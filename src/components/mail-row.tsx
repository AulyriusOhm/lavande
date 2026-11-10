import { Archive, CornerUpLeft, MailOpen, Star, Trash2 } from "lucide-react";
import type { Mail } from "@/lib/mail";
import { accountById } from "@/lib/accounts";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { PgpBadge } from "@/components/ui/pgp-badge";
import { SwipeAction, type SwipeActionDef } from "@/components/ui/swipe-action";
import { usePrefs, type SwipeActionId } from "@/lib/prefs";

export function MailRow({
  mail,
  onOpen,
  onToggleStar,
  onDelete,
  onArchive,
  onReply,
  onToggleRead,
  delay = 0,
  showPreview = true,
  showAccount = false,
}: {
  mail: Mail;
  onOpen: () => void;
  onToggleStar: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onReply?: () => void;
  onToggleRead?: () => void;
  delay?: number;
  showPreview?: boolean;
  showAccount?: boolean;
}) {
  const account = accountById(mail.account);
  const { swipeLeft, swipeRight } = usePrefs();

  const build = (id: SwipeActionId): SwipeActionDef | null => {
    switch (id) {
      case "delete":
        return { label: "Supprimer", icon: Trash2, tone: "danger", run: () => onDelete?.() };
      case "archive":
        return { label: "Archiver", icon: Archive, tone: "neutral", run: () => onArchive?.() };
      case "reply":
        return { label: "Répondre", icon: CornerUpLeft, tone: "accent", run: () => onReply?.() };
      case "star":
        return {
          label: mail.starred ? "Sans étoile" : "Étoiler",
          icon: Star,
          tone: "accent",
          run: onToggleStar,
        };
      case "read":
        return {
          label: mail.unread ? "Marquer lu" : "Non lu",
          icon: MailOpen,
          tone: "neutral",
          run: () => onToggleRead?.(),
        };
      default:
        return null;
    }
  };

  return (
    <BlurFade delay={delay} yOffset={14}>
      <SwipeAction leading={build(swipeRight)} trailing={build(swipeLeft)}>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onOpen();
        }}
        className={cn(
          "group relative flex cursor-pointer gap-3 rounded-[22px] px-3 py-3 transition-all duration-300",
          mail.unread
            ? "border border-accent-ring/60 bg-surface shadow-[0_10px_30px_-24px_var(--accent)] hover:border-accent-ring"
            : "border border-transparent hover:bg-surface-2/80",
        )}
      >
        <div className="relative">
          <Avatar name={mail.name} tone={mail.tone} size={42} />
          {mail.unread && (
            <span className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full border-2 border-surface bg-accent" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <p
                className={cn(
                  "truncate text-[13.5px] leading-tight",
                  mail.unread ? "font-bold text-ink" : "font-semibold text-ink-soft",
                )}
              >
                {mail.name}
              </p>
              {showAccount && account ? (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[2px] text-[9px] font-extrabold",
                    mail.unread ? "bg-surface-2 text-ink-soft" : "bg-surface-2/70 text-ink-muted",
                  )}
                >
                  <span className="size-[5px] rounded-full" style={{ backgroundColor: account.color }} />
                  {account.label}
                </span>
              ) : null}
            </div>

            <span className="flex shrink-0 items-center gap-1.5">
              <PgpBadge state={mail.pgp} compact />
              <span className={cn("text-[11px]", mail.unread ? "font-semibold text-accent-ink" : "text-ink-muted")}>
                {mail.time}
              </span>
              <button
                type="button"
                aria-label={mail.starred ? "Retirer l'étoile" : "Marquer d'une étoile"}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStar();
                }}
                className="-mr-1 grid size-6 place-items-center rounded-full transition-colors hover:bg-surface-2"
              >
                <Star
                  className={cn(
                    "size-3.5 transition-colors",
                    mail.starred ? "fill-amber-400 text-amber-400" : "text-ink-muted/50 group-hover:text-ink-muted",
                  )}
                />
              </button>
            </span>
          </div>

          <p
            className={cn(
              "mt-0.5 truncate text-[13px]",
              mail.unread ? "font-semibold text-ink" : "font-medium text-ink-soft",
            )}
          >
            {mail.subject}
          </p>

          {showPreview && (
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-ink-muted">{mail.preview}</p>
          )}

          {mail.attachments?.length ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-ink">
              {mail.attachments.length} pièce{mail.attachments.length > 1 ? "s" : ""} jointe
              {mail.attachments.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      </div>
      </SwipeAction>
    </BlurFade>
  );
}
