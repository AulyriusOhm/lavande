import { Archive, CornerUpLeft, MailOpen, RotateCcw, ShieldCheck, Star, Trash2 } from "lucide-react";
import { accountById } from "@/lib/accounts";
import type { Thread } from "@/lib/threads";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { PgpBadge } from "@/components/ui/pgp-badge";
import { SwipeAction, type SwipeActionDef } from "@/components/ui/swipe-action";
import { usePrefs, type SwipeActionId } from "@/lib/prefs";

export function ThreadRow({
  thread,
  onOpen,
  onToggleStar,
  onDelete,
  onArchive,
  onReply,
  onToggleRead,
  onNotSpam,
  onRestore,
  delay = 0,
  showPreview = true,
  showAccount = false,
}: {
  thread: Thread;
  onOpen: () => void;
  onToggleStar: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onReply?: () => void;
  onToggleRead?: () => void;
  onNotSpam?: () => void;
  onRestore?: () => void;
  delay?: number;
  showPreview?: boolean;
  showAccount?: boolean;
}) {
  const mail = thread.primary;
  const account = accountById(mail.account);
  const senderName = mail.folder === "sent" && mail.to ? `À ${mail.to}` : mail.name;
  const displayName =
    thread.count > 1 && thread.participants.length
      ? `${thread.participants.slice(0, 2).join(", ")}${
          thread.participants.length > 2 ? ` +${thread.participants.length - 2}` : ""
        }`
      : senderName;
  const unread = thread.unread > 0;
  const pieces = `${thread.attachments} pièce${thread.attachments > 1 ? "s" : ""} jointe${
    thread.attachments > 1 ? "s" : ""
  }`;
  const pillLabel =
    thread.count > 1
      ? `${thread.count} messages${thread.attachments > 0 ? ` · ${pieces}` : ""}`
      : thread.attachments > 0
        ? pieces
        : "";
  const { swipeLeft, swipeRight } = usePrefs();

  const build = (id: SwipeActionId): SwipeActionDef | null => {
    switch (id) {
      case "delete":
        return { label: "Supprimer", icon: Trash2, tone: "danger", run: () => onDelete?.() };
      case "archive":
        if (mail.folder === "archive" && onRestore) {
          return { label: "Désarchiver", icon: Archive, tone: "neutral", run: onRestore };
        }
        return { label: "Archiver", icon: Archive, tone: "neutral", run: () => onArchive?.() };
      case "reply":
        return { label: "Répondre", icon: CornerUpLeft, tone: "accent", run: () => onReply?.() };
      case "star":
        return {
          label: thread.starred ? "Sans étoile" : "Étoiler",
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

  const special = mail.folder === "spam" || mail.folder === "trash";

  const leading = (): SwipeActionDef | null => {
    if (mail.folder === "trash") {
      return onDelete
        ? { label: "Supprimer définitivement", icon: Trash2, tone: "danger", run: onDelete }
        : null;
    }
    if (mail.folder === "spam") {
      return onDelete ? { label: "Supprimer", icon: Trash2, tone: "danger", run: onDelete } : null;
    }
    const action = build(swipeRight);
    if (mail.folder === "archive" && action?.label === "Désarchiver") return null;
    return action;
  };

  const trailing = (): SwipeActionDef | null => {
    if (mail.folder === "spam" && onNotSpam) {
      return { label: "Non spam", icon: ShieldCheck, tone: "accent", run: onNotSpam };
    }
    if (mail.folder === "trash" && onRestore) {
      return { label: "Restaurer", icon: RotateCcw, tone: "neutral", run: onRestore };
    }
    if (mail.folder === "archive" && onRestore) {
      return { label: "Désarchiver", icon: Archive, tone: "neutral", run: onRestore };
    }
    return special ? null : build(swipeLeft);
  };

  return (
    <BlurFade delay={delay} yOffset={14}>
      <SwipeAction leading={leading()} trailing={trailing()}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${displayName} — ${thread.subject}${thread.count > 1 ? ` · ${thread.count} messages` : ""}${
          unread ? " · non lu" : ""
        }${thread.starred ? " · étoilé" : ""}`}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        className={cn(
          "group relative flex cursor-pointer gap-3 rounded-[22px] px-3 py-3 transition-all duration-300",
          unread
            ? "border border-accent-ring/60 bg-surface shadow-[0_10px_30px_-24px_var(--accent)] hover:border-accent-ring"
            : "border border-transparent hover:bg-surface-2/80",
        )}
      >
        <div className="flex w-[56px] shrink-0 flex-col items-start gap-1">
          {thread.count > 1 ? (
            <div className="relative h-[48px] w-[56px]">
              <span className="absolute bottom-0 left-[8px] size-[42px] rounded-[14px] border border-line bg-surface-2/70" />
              <span className="absolute bottom-0 left-[4px] size-[42px] rounded-[14px] border border-line bg-surface-2/70" />
              <Avatar name={displayName} tone={mail.tone} size={42} className="absolute bottom-0 left-0" />
              {unread && (
                <span className="absolute top-0 left-0 size-2.5 rounded-full border-2 border-surface bg-accent" />
              )}
            </div>
          ) : (
            <div className="relative flex h-[48px] w-[56px] items-end">
              <Avatar name={displayName} tone={mail.tone} size={42} className="relative" />
              {unread && (
                <span className="absolute top-[3px] left-0 size-2.5 rounded-full border-2 border-surface bg-accent" />
              )}
            </div>
          )}
          {showAccount && account ? (
            <span
              className="inline-block max-w-[56px] truncate rounded-full px-1.5 py-[3px] text-[8.5px] leading-none font-extrabold tracking-[0.08em] uppercase"
              style={{
                backgroundColor: `color-mix(in oklab, ${account.color} 16%, transparent)`,
                color: `color-mix(in oklab, ${account.color} 62%, #241b3a)`,
              }}
            >
              {account.label}
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <p
                className={cn(
                  "truncate text-[13.5px] leading-tight",
                  unread ? "font-bold text-ink" : "font-semibold text-ink-soft",
                )}
              >
                {displayName}
              </p>
            </div>

            <span className="flex shrink-0 items-center gap-1.5">
              <span className={cn("text-[11px]", unread ? "font-semibold text-accent-ink" : "text-ink-muted")}>
                {thread.time}
              </span>
              <button
                type="button"
                aria-label={thread.starred ? "Retirer l'étoile" : "Marquer d'une étoile"}
                aria-pressed={thread.starred}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStar();
                }}
                className="relative -mr-1 grid size-6 place-items-center rounded-full transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:bg-surface-2"
              >
                <Star
                  className={cn(
                    "size-3.5 transition-colors",
                    thread.starred ? "fill-amber-400 text-amber-400" : "text-ink-muted/50 group-hover:text-ink-muted",
                  )}
                />
              </button>
            </span>
          </div>

          <p
            className={cn(
              "mt-0.5 truncate text-[13px]",
              unread ? "font-semibold text-ink" : "font-medium text-ink-soft",
            )}
          >
            {thread.subject}
          </p>

          {showPreview && (
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-ink-muted">{thread.preview}</p>
          )}

          {(pillLabel || mail.pgp !== "none") && (
            <div className="mt-1.5 flex items-center gap-2">
              {pillLabel ? (
                <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                  <span className="truncate">{pillLabel}</span>
                </span>
              ) : null}
              <PgpBadge state={mail.pgp} compact className="ml-auto" />
            </div>
          )}
        </div>
      </div>
      </SwipeAction>
    </BlurFade>
  );
}
