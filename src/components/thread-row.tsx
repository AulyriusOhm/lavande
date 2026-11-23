import { useCallback, useEffect, useRef } from "react";
import { Archive, CornerUpLeft, MailOpen, RotateCcw, ShieldCheck, Star, Trash2 } from "lucide-react";
import { useMailStore } from "@/lib/store";
import { haptic } from "@/lib/haptics";
import type { Thread } from "@/lib/threads";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { PgpBadge } from "@/components/ui/pgp-badge";
import { SwipeAction, type SwipeActionDef } from "@/components/ui/swipe-action";
import { usePrefs, type MailDensity, type SwipeActionId } from "@/lib/prefs";
import {
  DEFAULT_DECISION_THRESHOLDS,
  isPhishing,
  type CustomCategory,
  type DecisionThresholds,
  type MailDecision,
} from "@/lib/decision";
import { categoryColorStyle } from "@/components/category-manager-sheet";
import { accountLabelInk, accountTint, useTheme } from "@/lib/theme";

const ACCOUNT_CHIP_TIERS = [
  { max: 6, classes: "text-[10.5px] tracking-[0.08em]" },
  { max: 8, classes: "text-[9.5px] tracking-[0.05em]" },
  { max: 10, classes: "text-[8.5px] tracking-[0.03em]" },
] as const;

const ACCOUNT_CHIP_TIGHT = "text-[8px] tracking-[0.01em]";

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

export function accountChipFont(label: string) {
  const length = [...label.trim()].length;
  return ACCOUNT_CHIP_TIERS.find((tier) => length <= tier.max)?.classes ?? ACCOUNT_CHIP_TIGHT;
}

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
  onLongPress,
  delay = 0,
  showPreview = true,
  showAccount = false,
  density = "cozy",
  decision = null,
  decisionThresholds = DEFAULT_DECISION_THRESHOLDS,
  customCategories = [],
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
  onLongPress?: () => void;
  delay?: number;
  showPreview?: boolean;
  showAccount?: boolean;
  density?: MailDensity;
  decision?: MailDecision | null;
  decisionThresholds?: DecisionThresholds;
  customCategories?: readonly CustomCategory[];
}) {
  const mail = thread.primary;
  const { accountById } = useMailStore();
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
  const { dark } = useTheme();
  const tight = density === "compact";
  const avatarSize = tight ? 32 : 42;

  const decisionBadges: { label: string; className: string }[] = [];
  if (decision) {
    if (isPhishing(decision, decisionThresholds)) {
      decisionBadges.push({
        label: "Suspect",
        className: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
      });
    }
    if (decision.urgency >= 2.0) {
      decisionBadges.push({
        label: "Urgent",
        className: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
      });
    }
    if (decision.needsReply >= decisionThresholds.category && !mail.answered) {
      decisionBadges.push({
        label: "À répondre",
        className: "bg-accent-soft text-accent-ink",
      });
    }
    const customCat = customCategories.find(
      (cat) => decision.category === `custom:${cat.id}` || decision.category === cat.id,
    );
    if (customCat) {
      decisionBadges.push({
        label: customCat.name,
        className: categoryColorStyle(customCat.color).pill,
      });
    }
  }

  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const held = useRef(false);

  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  useEffect(() => {
    if (!onLongPress) return;
    const cancel = () => cancelPress();
    window.addEventListener("scroll", cancel, true);
    return () => window.removeEventListener("scroll", cancel, true);
  }, [onLongPress, cancelPress]);

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
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        onPointerDown={(event) => {
          held.current = false;
          cancelPress();
          if (!onLongPress || event.button !== 0) return;
          if ((event.target as HTMLElement).closest("button")) return;
          const { clientX: x, clientY: y } = event;
          const timer = window.setTimeout(() => {
            press.current = null;
            held.current = true;
            haptic("medium");
            onLongPress();
          }, LONG_PRESS_MS);
          press.current = { timer, x, y };
        }}
        onPointerMove={(event) => {
          const current = press.current;
          if (!current) return;
          const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y);
          if (moved > LONG_PRESS_SLOP) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        className={cn(
          "group relative flex cursor-pointer gap-3 rounded-[22px] px-3 transition-all duration-300",
          tight ? "py-2" : "py-3",
          unread
            ? "border border-accent-ring/60 bg-surface shadow-[0_10px_30px_-24px_var(--accent)] hover:border-accent-ring"
            : "border border-transparent hover:bg-surface-2/80",
        )}
      >
        <div className="flex w-[56px] shrink-0 flex-col items-start gap-1">
          {thread.count > 1 ? (
            <div className={cn("relative", tight ? "h-[32px] w-[44px]" : "h-[48px] w-[56px]")}>
              <span
                className={cn(
                  "absolute bottom-0 rounded-[14px] border border-line bg-surface-2/70",
                  tight ? "left-[6px] size-[26px]" : "left-[8px] size-[42px]",
                )}
              />
              <span
                className={cn(
                  "absolute bottom-0 rounded-[14px] border border-line bg-surface-2/70",
                  tight ? "left-[3px] size-[26px]" : "left-[4px] size-[42px]",
                )}
              />
              <Avatar
                name={displayName}
                tone={mail.tone}
                size={avatarSize}
                className="absolute bottom-0 left-0"
              />
              {unread && (
                <span className="absolute top-0 left-0 size-2.5 rounded-full border-2 border-surface bg-accent" />
              )}
            </div>
          ) : (
            <div className={cn("relative flex w-[56px] items-end", tight ? "h-[32px]" : "h-[48px]")}>
              <Avatar name={displayName} tone={mail.tone} size={avatarSize} className="relative" />
              {unread && (
                <span className="absolute top-[3px] left-0 size-2.5 rounded-full border-2 border-surface bg-accent" />
              )}
            </div>
          )}
          {showAccount && account ? (
            <span
              data-account-chip={account.id}
              title={account.label}
              className={cn(
                "-ml-1 inline-block max-w-[64px] overflow-hidden text-clip whitespace-nowrap rounded-full px-1.5 py-[3px] leading-none font-extrabold uppercase",
                accountChipFont(account.label),
              )}
              style={{
                backgroundColor: accountTint(account.color),
                color: accountLabelInk(account.color, dark),
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
              {mail.answered ? (
                <span
                  role="img"
                  aria-label="Répondu"
                  title="Répondu"
                  className="grid shrink-0 place-items-center text-ink-muted"
                >
                  <CornerUpLeft className="size-3.5" strokeWidth={2.4} />
                </span>
              ) : null}
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
                    thread.starred ? "fill-amber-400 text-amber-500" : "text-ink-muted group-hover:text-ink-soft",
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

          {showPreview && !tight && (
            <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.45] text-ink-muted">{thread.preview}</p>
          )}

          {(pillLabel || decisionBadges.length > 0 || mail.pgp !== "none") && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {pillLabel ? (
                <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                  <span className="truncate">{pillLabel}</span>
                </span>
              ) : null}
              {decisionBadges.map((badge) => (
                <span
                  key={badge.label}
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-bold",
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>
              ))}
              <PgpBadge state={mail.pgp} detail={mail.pgp_detail} compact className="ml-auto" />
            </div>
          )}
        </div>
      </div>
      </SwipeAction>
    </BlurFade>
  );
}
