import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CornerUpLeft,
  CornerUpRight,
  Download,
  Forward,
  Inbox,
  Layers,
  Loader2,
  Lock,
  Mail as MailIcon,
  MailOpen,
  Moon,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Star,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { FolderId, Mail, MailAttachment } from "@/lib/mail";
import { folderLabel } from "@/lib/mail";
import { ISO_DAY, type SummaryRef, type SummaryResult } from "@/lib/summary";
import { dueToneFor, formatDueDate } from "@/lib/tasks";
import { downloadAttachment } from "@/lib/attachments";
import type { Thread } from "@/lib/threads";
import { threadsInFolder } from "@/lib/threads";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { FolderOption } from "@/lib/mail-backend";
import { PGP_STATE, formatKeyDate, keyLabel, keyState, shortFingerprint, type PgpKey } from "@/lib/pgp";
import { listKeys } from "@/lib/pgp-api";
import { useMailStore, type BulkKind } from "@/lib/store";
import { DEFAULT_INBOX_PANES, resolvePgp, usePrefs } from "@/lib/prefs";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { useEscapeLayer } from "@/desktop/escape";
import { PaneSplitter } from "@/desktop/pane-splitter";
import { SelectionBar } from "@/desktop/selection-bar";
import { useTheme } from "@/lib/theme";
import { clockOf, cn, initials } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { BorderBeam } from "@/components/ui/border-beam";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { MailBody, MailBodyLoading } from "@/components/mail-body";
import { MailRecipients } from "@/components/mail-recipients";
import { MailContextMenu } from "@/components/mail-context-menu";
import { AnalysePanel } from "@/components/analyse-panel";
import { FolderContextMenu } from "@/desktop/folder-context-menu";
import { EmptyTrashButton } from "@/components/empty-trash";
import { HiddenFoldersRail } from "@/components/folder-row";
import { useFolderTree } from "@/components/folder-tree";
import { moveFolderPath } from "@/lib/folder-tree";
import {
  Badge,
  DButton,
  DChip,
  DIconButton,
  EmptyState,
  Kbd,
  PaneTitle,
  SectionLabel,
} from "@/desktop/ui";

type Filter = "all" | "unread" | "starred" | "encrypted" | "attachments";

const SUMMARY_DUE_TONE: Record<ReturnType<typeof dueToneFor>, "rose" | "amber" | "green"> = {
  late: "rose",
  soon: "amber",
  soft: "green",
  none: "green",
};

const SUMMARY_CHIP =
  "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[10.5px] font-bold text-ink-soft transition-colors duration-200 hover:border-accent-ring hover:text-ink";
const SUMMARY_CHIP_FILLED =
  "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent px-2.5 text-[10.5px] font-bold text-accent-contrast transition-colors duration-200 hover:bg-accent-ink";
const SUMMARY_CHIP_DONE =
  "inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-accent-ring/60 bg-accent-soft px-2.5 text-[10.5px] font-bold text-accent-ink";
const SUMMARY_SUBJECT =
  "focus-ring block max-w-full truncate text-left text-[12.5px] leading-[1.4] font-bold text-accent-ink underline decoration-[1.5px] underline-offset-2 transition-colors duration-200 hover:text-accent";

/** Heure courte d'un mail résumé : horodatage réel, sinon libellé déjà formaté. */
function summaryClock(mail: Mail): string {
  return typeof mail.timestamp === "number" ? clockOf(mail.timestamp) : mail.time;
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "unread", label: "Non lus" },
  { id: "starred", label: "Étoilés" },
  { id: "encrypted", label: "Chiffrés" },
  { id: "attachments", label: "Fichiers" },
];

const FILTER_MATCH: Record<Filter, (thread: Thread) => boolean> = {
  all: () => true,
  unread: (thread) => thread.unread > 0,
  starred: (thread) => thread.starred,
  encrypted: (thread) => thread.encrypted > 0,
  attachments: (thread) => thread.attachments > 0,
};

const NARROW_MAX = 859;
const MEDIUM_MAX = 1099;
const NARROW_QUERY = `(max-width: ${NARROW_MAX}px)`;
const MEDIUM_QUERY = `(max-width: ${MEDIUM_MAX}px)`;

/** Bornes des colonnes dossiers et liste, et largeur minimale gardée au lecteur. */
const SPLITTER_WIDTH = 8;
const RAIL_MIN = 200;
const RAIL_MAX = 360;
const LIST_MIN = 320;
const LIST_MAX = 640;
const READER_MIN = 320;

type InboxTier = "wide" | "medium" | "narrow";

function currentTier(): InboxTier {
  if (typeof window.matchMedia !== "function") return "wide";
  if (window.matchMedia(NARROW_QUERY).matches) return "narrow";
  if (window.matchMedia(MEDIUM_QUERY).matches) return "medium";
  return "wide";
}

function useInboxTier(): InboxTier {
  const [tier, setTier] = useState<InboxTier>(currentTier);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const queries = [window.matchMedia(NARROW_QUERY), window.matchMedia(MEDIUM_QUERY)];
    const sync = () => setTier(currentTier());
    sync();
    for (const query of queries) query.addEventListener?.("change", sync);
    return () => {
      for (const query of queries) query.removeEventListener?.("change", sync);
    };
  }, []);

  return tier;
}

const FOLDER_ICONS: Record<FolderId, LucideIcon> = {
  inbox: Inbox,
  unified: Layers,
  sent: Forward,
  drafts: PenLine,
  archive: Archive,
  spam: ShieldCheck,
  trash: Trash2,
  other: Inbox,
};

const ACCOUNT_TONE: Record<string, "accent" | "sky" | "rose"> = {
  perso: "accent",
  pro: "sky",
  gmail: "rose",
};

const accountTone = (id: string): "accent" | "sky" | "rose" => ACCOUNT_TONE[id] ?? "accent";

const TO_DO = 3;

type QuickAction = { label: string; icon: LucideIcon; filled?: boolean; run: () => void };

function ActionIcon({ action, size }: { action: QuickAction; size: string }) {
  return <action.icon className={cn(size, action.filled && "fill-amber-400 text-amber-400")} />;
}

function RailItem({
  active,
  icon,
  label,
  count,
  onClick,
  depth = 0,
  expanded,
  onToggle,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  onClick?: () => void;
  depth?: number;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const row = onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cn(
        "focus-ring flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[11px] px-2.5 text-[12.5px] font-semibold transition-colors duration-200",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-soft hover:bg-surface-2 hover:text-ink",
      )}
    >
      <span className="grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="truncate">{label}</span>
      {count > 0 ? (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums",
            active ? "bg-surface text-accent-ink" : "bg-surface-2 text-ink-muted",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  ) : (
    <span className="flex h-9 min-w-0 flex-1 items-center gap-2.5 truncate rounded-[11px] px-2.5 text-[12.5px] font-semibold text-ink-muted">
      <span className="grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );

  if (!depth && !onToggle) return row;

  return (
    <div className="flex items-center" style={depth ? { paddingLeft: depth * 14 } : undefined}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Replier" : "Déplier"} ${label}`}
          className="focus-ring grid size-5 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <ChevronDown
            className={cn("size-3 transition-transform duration-200", !expanded && "-rotate-90")}
          />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      {row}
    </div>
  );
}

type SummaryRow = { ref: SummaryRef; mail: Mail };

function SummaryGroupTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-bold tracking-[0.16em] text-ink-muted uppercase">
      <span>{label}</span>
      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold tracking-normal text-ink-soft tabular-nums">
        {count}
      </span>
    </div>
  );
}

export function MorningSummary({
  open,
  unread,
  attachments,
  encrypted,
  demo,
  summary,
  mails,
  loading,
  onToggle,
  onOpen,
  onRefresh,
  onReply,
  onPropose,
}: {
  open: boolean;
  unread: number;
  attachments: number;
  encrypted: number;
  demo: boolean;
  summary: SummaryResult | null;
  /** Mails réellement analysés : index vivant des lignes du briefing. */
  mails: Mail[];
  loading: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onReply: (mail: Mail) => void;
  onPropose: (ref: SummaryRef) => "added" | "existing";
}) {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [proposed, setProposed] = useState<Record<string, "added" | "existing">>({});
  const label = summary?.period.label ?? "Résumé du matin";
  const source = summary ? (summary.source === "llm" ? "IA" : "local") : null;
  const byId = useMemo(() => new Map(mails.map((mail) => [mail.id, mail])), [mails]);
  const generatedClock = summary ? clockOf(summary.generatedAt) : "";
  const rowsOf = (refs: SummaryRef[]): SummaryRow[] =>
    refs.flatMap((ref) => {
      const mail = byId.get(ref.mailId);
      return mail ? [{ ref, mail }] : [];
    });
  const actions = summary ? rowsOf(summary.groups.actions) : [];
  const infos = summary ? rowsOf(summary.groups.infos) : [];
  const notifications = summary ? rowsOf(summary.groups.notifications) : [];
  const senders = [...new Set(notifications.map((row) => row.mail.name))];
  const notified = senders
    .slice(0, 2)
    .map((name) => {
      const count = notifications.filter((row) => row.mail.name === name).length;
      return count > 1 ? `${name} ×${count}` : name;
    })
    .join(", ");

  const infoRow = ({ ref, mail }: SummaryRow) => (
    <div
      key={ref.mailId}
      className="flex items-center gap-2 rounded-[10px] px-1 py-1.5 transition-colors duration-200 hover:bg-surface/70"
    >
      <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-surface-2 text-[9px] font-bold text-ink-soft">
        {initials(mail.name)}
      </span>
      <button
        type="button"
        onClick={() => onOpen(mail.id)}
        className="focus-ring min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-ink transition-colors duration-200 hover:text-accent-ink hover:underline"
      >
        {mail.subject}
      </button>
      <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted tabular-nums">
        {summaryClock(mail)}
      </span>
    </div>
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Déplier le ${label.toLowerCase()}`}
        className="focus-ring flex h-[52px] w-full items-center gap-2 rounded-full border border-accent-ring/60 bg-accent-soft px-4 text-[11.5px] font-bold text-accent-ink transition-colors duration-200 hover:border-accent-ring"
      >
        <Sparkles className="size-4 shrink-0" strokeWidth={2.4} />
        <span className="truncate">
          {label}
          {summary
            ? ` · ${summary.mailCount} mail${summary.mailCount > 1 ? "s" : ""}`
            : demo
              ? ` · ${TO_DO} à traiter`
              : ` · ${unread} non lus`}
        </span>
        <ChevronDown className="ml-auto size-4 shrink-0" />
      </button>
    );
  }

  return (
    <div
      data-testid="morning-summary"
      className="relative overflow-hidden rounded-[20px] border border-accent-ring/60 bg-[linear-gradient(105deg,var(--surface),var(--accent-soft))]"
    >
      <BorderBeam duration={9} />

      <div className="relative px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-accent text-accent-contrast">
            <Sparkles className="size-4" strokeWidth={2.4} />
          </span>
          <p className="min-w-0 truncate text-[11px] font-bold tracking-[0.16em] text-accent-ink uppercase">
            {label}
          </p>
          <span className="shrink-0 text-[11px] font-semibold text-ink-muted">
            <NumberTicker value={unread} /> non lus
          </span>
          <span
            data-testid={source ? "summary-source" : "summary-badge"}
            className="ml-auto shrink-0 rounded-full border border-accent-ring/60 bg-surface/80 px-2 py-0.5 text-[10px] font-bold text-accent-ink"
          >
            {source ?? (demo ? `${TO_DO} à traiter` : `${attachments} fichiers`)}
          </span>
          {summary ? (
            <DIconButton
              label="Régénérer le résumé"
              onClick={onRefresh}
              className="size-7"
              disabled={loading}
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </DIconButton>
          ) : null}
          <DIconButton label={`Replier le ${label.toLowerCase()}`} onClick={onToggle} className="size-7">
            <ChevronUp className="size-4" />
          </DIconButton>
        </div>

        {summary ? (
          <>
            <p className="mt-1 text-[12.5px] leading-[1.55] font-medium text-ink-soft">{summary.headline}</p>
            <div
              data-testid="summary-attachments"
              className="mt-2 max-h-[min(42vh,360px)] space-y-2.5 overflow-y-auto pr-1"
            >
              {actions.length > 0 ? (
                <section>
                  <SummaryGroupTitle label="À traiter" count={actions.length} />
                  <div className="space-y-1">
                    {actions.map(({ ref, mail }) => {
                      const due = ref.due && ISO_DAY.test(ref.due) ? ref.due : null;
                      return (
                        <article
                          key={ref.mailId}
                          className="flex gap-2.5 rounded-[14px] border border-line bg-surface px-2.5 py-2"
                        >
                          <span className="grid size-[26px] shrink-0 place-items-center rounded-[10px] border border-accent-ring bg-accent-soft text-[10.5px] font-bold text-accent-ink">
                            {initials(mail.name)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-1.5">
                              <span className="min-w-0 truncate text-[11.5px] font-bold text-ink">{mail.name}</span>
                              <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted tabular-nums">
                                {summaryClock(mail)}
                              </span>
                            </div>
                            <button type="button" onClick={() => onOpen(mail.id)} className={SUMMARY_SUBJECT}>
                              {mail.subject}
                            </button>
                            {ref.reason ? (
                              <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.5] font-medium text-ink-soft">
                                {ref.reason}
                              </p>
                            ) : null}
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {proposed[ref.mailId] ? (
                                <button type="button" disabled className={SUMMARY_CHIP_DONE}>
                                  <Check className="size-3 shrink-0" strokeWidth={2.8} />
                                  {proposed[ref.mailId] === "added" ? "Ajouté" : "Déjà proposé"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const outcome = onPropose(ref);
                                    setProposed((current) => ({ ...current, [ref.mailId]: outcome }));
                                  }}
                                  className={SUMMARY_CHIP_FILLED}
                                >
                                  <Plus className="size-3" strokeWidth={2.8} />
                                  Planification
                                </button>
                              )}
                              <button type="button" onClick={() => onReply(mail)} className={SUMMARY_CHIP}>
                                <CornerUpLeft className="size-3" strokeWidth={2.4} />
                                Répondre
                              </button>
                              <button type="button" onClick={() => onOpen(mail.id)} className={SUMMARY_CHIP}>
                                Voir le mail
                              </button>
                              {due ? (
                                <Badge tone={SUMMARY_DUE_TONE[dueToneFor(due)]}>{formatDueDate(due)}</Badge>
                              ) : null}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {infos.length > 0 ? (
                <section>
                  <SummaryGroupTitle label="Pour info" count={infos.length} />
                  <div className="divide-y divide-accent-ring/20">{infos.map(infoRow)}</div>
                </section>
              ) : null}

              {notifications.length > 0 ? (
                <section>
                  <button
                    type="button"
                    onClick={() => setNotificationsOpen(!notificationsOpen)}
                    aria-expanded={notificationsOpen}
                    className="focus-ring flex w-full items-center gap-2 rounded-[12px] border border-dashed border-accent-ring/70 bg-surface/55 px-2.5 py-1.5 text-left transition-colors duration-200 hover:border-accent-ring"
                  >
                    <span className="shrink-0 text-[10.5px] font-bold tracking-[0.04em] text-accent-ink">
                      Notifications &amp; listes · {notifications.length}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-ink-muted">
                      {notified}
                      {senders.length > 2 ? "…" : ""}
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-3.5 shrink-0 text-accent-ink transition-transform duration-200",
                        notificationsOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {notificationsOpen ? (
                    <div className="mt-1 divide-y divide-accent-ring/20">{notifications.map(infoRow)}</div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </>
        ) : (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.55] font-medium text-ink-soft">
            <span className="font-bold text-ink">{unread} conversations non lues</span>, {attachments} avec des pièces
            jointes, {encrypted} chiffrées.
            {demo ? " Camille attend un retour sur la v3 avant vendredi." : ""}
          </p>
        )}

      </div>

      {summary ? (
        <div className="relative flex items-center gap-1.5 border-t border-accent-ring/25 px-4 py-2 text-[10.5px] font-bold text-ink-muted">
          <span>Généré à {generatedClock}</span>
          <span aria-hidden className="size-[3px] rounded-full bg-accent-ring" />
          <span>{summary.source === "llm" ? "mis en cache" : "local"}</span>
          <span aria-hidden className="size-[3px] rounded-full bg-accent-ring" />
          <span className="tabular-nums">{summary.mailCount} mails analysés</span>
        </div>
      ) : null}
    </div>
  );
}

function ThreadRow({
  thread,
  selected,
  checked,
  delay,
  onOpen,
  onStar,
  onRead,
  onArchive,
  onDelete,
  onRestore,
  onNotSpam,
  onMenu,
}: {
  thread: Thread;
  selected: boolean;
  checked: boolean;
  delay: number;
  onOpen: (event: React.MouseEvent | null) => void;
  onStar: () => void;
  onRead: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onNotSpam: () => void;
  onMenu: (ancre: { x: number; y: number }) => void;
}) {
  const mail = thread.primary;
  const { accountById } = useMailStore();
  const account = accountById(mail.account);
  const sender = mail.folder === "sent" && mail.to ? `À ${mail.to}` : mail.name;
  const name =
    thread.count > 1 && thread.participants.length
      ? `${thread.participants.slice(0, 2).join(", ")}${
          thread.participants.length > 2 ? ` +${thread.participants.length - 2}` : ""
        }`
      : sender;
  const unread = thread.unread > 0;

  const quick: QuickAction[] = [
    {
      label: thread.starred ? "Retirer l'étoile" : "Marquer d'une étoile",
      icon: Star,
      filled: thread.starred,
      run: onStar,
    },
    {
      label: unread ? "Marquer comme lu" : "Marquer comme non lu",
      icon: unread ? MailOpen : MailIcon,
      run: onRead,
    },
    mail.folder === "spam"
      ? { label: "Non spam", icon: ShieldCheck, run: onNotSpam }
      : mail.folder === "trash" || mail.folder === "archive"
        ? { label: "Restaurer", icon: RotateCcw, run: onRestore }
        : { label: "Archiver", icon: Archive, run: onArchive },
    {
      label: mail.folder === "trash" ? "Supprimer définitivement" : "Supprimer",
      icon: Trash2,
      run: onDelete,
    },
  ];

  return (
    <BlurFade delay={delay} yOffset={10}>
      <div
        className={cn(
          "group relative rounded-[16px] border transition-colors duration-200",
          selected || checked
            ? "border-transparent bg-accent-soft ring-1 ring-accent-ring"
            : unread
              ? "border-accent-ring/60 bg-surface shadow-[0_10px_30px_-24px_var(--accent)] hover:border-accent-ring"
              : "border-transparent hover:bg-surface-2",
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <button
          type="button"
          onClick={(event) => onOpen(event)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onOpen(null);
          }}
          aria-current={selected}
          aria-pressed={checked}
          data-mail-row={thread.id}
          aria-label={`${name} — ${thread.subject}${thread.count > 1 ? ` · ${thread.count} messages` : ""}${
            unread ? " · non lu" : ""
          }${checked ? " · sélectionné" : ""}`}
          className="focus-row absolute inset-0 rounded-[16px]"
        />

        <div className="pointer-events-none relative flex gap-3 px-3 py-3.5">
          <div className="relative shrink-0">
            <Avatar name={name} tone={mail.tone} size={40} rounded="rounded-full" />
            {checked ? (
              <span className="absolute -top-1 -left-1 grid size-4 place-items-center rounded-full border-2 border-surface bg-accent text-accent-contrast">
                <Check className="size-2.5" strokeWidth={3.5} />
              </span>
            ) : unread ? (
              <span className="absolute top-0 left-0 size-2.5 rounded-full border-2 border-surface bg-accent" />
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p
                className={cn(
                  "min-w-0 truncate text-[13px] leading-tight",
                  unread ? "font-extrabold text-ink" : "font-semibold text-ink-soft",
                )}
              >
                {name}
              </p>
              {account ? <Badge tone={accountTone(mail.account)}>{account.label}</Badge> : null}
              {mail.pgp === "encrypted" ? (
                <Lock className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" strokeWidth={2.6} />
              ) : mail.pgp === "signed" ? (
                <ShieldCheck className="size-3.5 shrink-0 text-sky-700 dark:text-sky-300" strokeWidth={2.6} />
              ) : null}
              <span className="ml-auto shrink-0 text-[11px] font-bold tabular-nums text-ink-muted">{thread.time}</span>
            </div>

            <p
              className={cn(
                "mt-1 truncate text-[13px] text-ink",
                unread ? "font-bold" : "font-semibold",
              )}
            >
              {thread.subject}
            </p>

            <p className="mt-1 line-clamp-3 text-[12.5px] leading-[1.5] text-ink-muted">{thread.preview}</p>

            {thread.count > 1 || thread.attachments > 0 ? (
              <div className="mt-1.5 flex items-center gap-1">
                {thread.count > 1 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
                    {thread.count} messages
                  </span>
                ) : null}
                {thread.attachments > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
                    <Paperclip className="size-2.5" />
                    {thread.attachments}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "glass absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full p-0.5",
            "pointer-events-none opacity-0 transition-opacity duration-200",
            "group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
          )}
        >
          {quick.map((action) => (
            <DIconButton key={action.label} label={action.label} onClick={action.run} className="size-6">
              <ActionIcon action={action} size="size-3.5" />
            </DIconButton>
          ))}
        </div>
      </div>
    </BlurFade>
  );
}

export function DesktopInbox({
  onOpenSearch,
  navigationRef,
  onOpenPgp,
}: {
  onOpenSearch: () => void;
  navigationRef?: React.RefObject<MailNavigation | null>;
  onOpenPgp?: () => void;
}) {
  const {
    mails,
    account,
    mailAccounts,
    mode,
    readOnly,
    syncing,
    syncFolder,
    folderOptions,
    folderPath,
    accountById,
    folder,
    openMail,
    openThread,
    threadsLoading,
    hasMore,
    loadMore,
    setAccount,
    setFolder,
    toggleStar,
    mailAction,
    bulkMailAction,
    moveToInbox,
    restoreMail,
    emptyTrash,
    openMessage,
    closeMessage,
    replyTo,
    forwardMail,
    resumeDraft,
    analyse,
    runAnalyse,
    closeAnalyse,
    acceptAnalyseTask,
    acceptAnalyseEvent,
    openReplyWithBody,
    folderStats,
    accountUnread,
    summary,
    summaryLoading,
    summaryMails,
    refreshSummary,
    proposeSummaryAction,
    bodyFetching,
    fetchBody,
    hiddenFolderOptions,
    folderOrder,
    setFolderOrder,
  } = useMailStore();
  const { dark, setDark } = useTheme();
  const prefs = usePrefs();
  const [filter, setFilter] = useState<Filter>("all");
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [collapsedPrevious, setCollapsedPrevious] = useState<string[]>([]);
  const [pgpKeys, setPgpKeys] = useState<PgpKey[] | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ mail: Mail; x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ entry: FolderOption; x: number; y: number } | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const tier = useInboxTier();
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(() => window.innerWidth);
  const [draggingPane, setDraggingPane] = useState(false);
  const [panes, setPanes] = useState(prefs.inboxPanes);
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<"reader" | "list" | null>(null);

  const setInboxPanes = prefs.setInboxPanes;

  useEffect(() => {
    setPanes(prefs.inboxPanes);
  }, [prefs.inboxPanes]);

  useEffect(() => {
    const measure = () => {
      const width = gridRef.current?.getBoundingClientRect().width ?? 0;
      setGridWidth(width > 0 ? width : window.innerWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tier]);

  const railWidth = Math.min(Math.max(panes.rail, RAIL_MIN), RAIL_MAX);
  const listCeiling = Math.min(
    LIST_MAX,
    Math.max(LIST_MIN, gridWidth - railWidth - READER_MIN - 2 * SPLITTER_WIDTH),
  );
  const listWidth = Math.min(Math.max(panes.list, LIST_MIN), listCeiling);

  const focusRow = useCallback((id: string | null) => {
    if (!id || !listRef.current) return;
    const row = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-mail-row]")).find(
      (element) => element.dataset.mailRow === id,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  }, []);

  const listFocused = useCallback(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    return listRef.current?.contains(active) ?? false;
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    selectionAnchor.current = null;
  }, []);


  const runDownload = async (mail: Mail, file: MailAttachment) => {
    const key = `${mail.id}:${file.name}`;
    setDownloading(key);
    setDownloadNotice(`Téléchargement de « ${file.name} »…`);
    setDownloadNotice(await downloadAttachment(mail, file));
    setDownloading(null);
  };

  const threads = threadsInFolder(mails, folder, account);
  const folderRows = useFolderTree(folderOptions, folderOrder);
  const reorderable = mode === "api" && account !== ALL_ACCOUNTS && !readOnly;
  const [dragged, setDragged] = useState<{ path: string; depth: number; parentPath: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ path: string; after: boolean } | null>(null);

  const siblingsAt = (depth: number, parentPath: string | null) =>
    folderRows
      .filter((row) => row.depth === depth && row.parentPath === parentPath)
      .map((row) => row.node.path);

  const dropOn = (path: string, depth: number, parentPath: string | null, after: boolean) => {
    if (
      !dragged ||
      dragged.depth !== depth ||
      dragged.parentPath !== parentPath ||
      dragged.path === path
    )
      return;
    setFolderOrder(
      moveFolderPath(folderOrder, siblingsAt(depth, parentPath), dragged.path, path, after),
    );
    setDragged(null);
    setDropTarget(null);
  };
  const heading =
    folderOptions.find(
      (entry) => entry.id === folder && (entry.id !== "other" || entry.path === folderPath),
    )?.label ?? folderLabel(folder);
  const reception = folder === "inbox" || folder === "unified";
  const visible = threads.filter(FILTER_MATCH[filter]);
  const selectedMails = visible.filter((thread) => selectedIds.has(thread.id)).map((thread) => thread.primary);
  const selection = useRef({ ids: selectedIds, mails: selectedMails });
  selection.current = { ids: selectedIds, mails: selectedMails };

  const selectThread = (thread: Thread, index: number, event: React.MouseEvent | null) => {
    if (event && (event.ctrlKey || event.metaKey)) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(thread.id)) next.delete(thread.id);
        else next.add(thread.id);
        return next;
      });
      selectionAnchor.current = thread.id;
      return;
    }
    if (event && event.shiftKey && selectionAnchor.current) {
      const anchorIndex = visible.findIndex((entry) => entry.id === selectionAnchor.current);
      if (anchorIndex >= 0) {
        const from = Math.min(anchorIndex, index);
        const to = Math.max(anchorIndex, index);
        setSelectedIds((current) => {
          const next = new Set(current);
          for (let step = from; step <= to; step += 1) next.add(visible[step].id);
          return next;
        });
        return;
      }
    }
    clearSelection();
    setCursor(index);
    openMessage(thread.primary);
  };
  const unreadThreads = threads.filter((thread) => thread.unread > 0).length;
  const attachmentThreads = threads.filter((thread) => thread.attachments > 0).length;
  const encryptedThreads = threads.filter((thread) => thread.encrypted > 0).length;

  useEffect(() => {
    setFilter("all");
  }, [folder, folderPath, account]);

  useEffect(() => {
    const controller = new AbortController();
    listKeys(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setPgpKeys(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPgpKeys([]);
      });
    return () => controller.abort();
  }, []);

  const openById = (id: string) => {
    const mail = mails.find((entry) => entry.id === id);
    if (mail) openMessage(mail);
  };

  const myKey = pgpKeys?.find((key) => key.has_secret) ?? null;
  const pgpState = myKey ? keyState(myKey) : null;
  const pgpTone: "green" | "amber" | "rose" =
    pgpState === "expired" ? "amber" : pgpState === "revoked" ? "rose" : "green";

  const mail = openMail;
  const bodyLoading = Boolean(mail && bodyFetching === mail.id);
  const pgpLocked = Boolean(
    mail && mail.pgp === "encrypted" && !mail.bodyFetched && !resolvePgp(prefs, mail.account).enabled,
  );

  const currentIndex = useMemo(() => {
    if (mail) {
      const index = visible.findIndex((thread) => thread.messages.some((message) => message.id === mail.id));
      if (index >= 0) return index;
    }
    return cursor;
  }, [mail, visible, cursor]);
  const selectedThreadId = currentIndex === null ? null : (visible[currentIndex]?.id ?? null);
  const navState = useRef({ visible, currentIndex, mail });
  navState.current = { visible, currentIndex, mail };

  useEffect(() => {
    setCursor(null);
    setSelectedIds(new Set());
    selectionAnchor.current = null;
  }, [filter, folder, folderPath, account]);

  useEscapeLayer(Boolean(mail), () => {
    setCursor(currentIndex);
    pendingFocus.current = "list";
    closeMessage();
  });

  useEscapeLayer(selectedIds.size > 0, clearSelection);

  useEffect(() => {
    if (!navigationRef) return;

    const selected = () => {
      const state = navState.current;
      if (state.mail) return state.mail;
      if (state.currentIndex === null) return null;
      return state.visible[state.currentIndex]?.primary ?? null;
    };

    const threadIdOf = (mail: Mail) =>
      navState.current.visible.find((thread) =>
        thread.messages.some((message) => message.id === mail.id),
      )?.id ?? null;

    const advance = (removed: string | null) => {
      const state = navState.current;
      const index = state.currentIndex ?? 0;
      const remaining = state.visible.filter((thread) => thread.id !== removed).length;
      setCursor(remaining === 0 ? null : Math.min(index, remaining - 1));
      pendingFocus.current = "list";
      if (state.mail) closeMessage();
    };

    const guarded = (run: (mail: Mail) => void) => {
      const mail = selected();
      if (!mail) return null;
      run(mail);
      return mail;
    };

    const bulk = (kind: BulkKind) => {
      const current = selection.current;
      if (current.ids.size === 0) return false;
      bulkMailAction(kind, current.mails);
      clearSelection();
      return true;
    };

    const move = (step: number) => {
      const state = navState.current;
      if (state.visible.length === 0) return;
      const base = state.currentIndex ?? (step > 0 ? -1 : state.visible.length);
      const index = Math.min(state.visible.length - 1, Math.max(0, base + step));
      const thread = state.visible[index];
      if (!thread) return;
      setCursor(index);
      if (state.mail) {
        openMessage(thread.primary);
        pendingFocus.current = "reader";
        return;
      }
      focusRow(thread.id);
    };

    navigationRef.current = {
      canMove: () => navState.current.visible.length > 0,
      canOpen: () => navState.current.visible.length > 0 && listFocused(),
      canAct: () => selected() !== null,
      current: selected,
      next: () => move(1),
      previous: () => move(-1),
      open: () => {
        const state = navState.current;
        const index = state.currentIndex ?? 0;
        const thread = state.visible[index];
        if (!thread) return;
        setCursor(index);
        openMessage(thread.primary);
        pendingFocus.current = "reader";
      },
      selectAll: () => setSelectedIds(new Set(navState.current.visible.map((thread) => thread.id))),
      deleteSelected: () => {
        if (bulk("delete")) return;
        const mail = guarded((entry) => mailAction("delete", entry));
        if (mail) advance(threadIdOf(mail));
      },
      archiveSelected: () => {
        if (bulk("archive")) return;
        const mail = guarded((entry) => mailAction("archive", entry));
        if (mail) advance(threadIdOf(mail));
      },
      toggleStarSelected: () => {
        if (bulk(selection.current.mails.every((entry) => entry.starred) ? "unstar" : "star")) return;
        guarded((entry) => toggleStar(entry.id));
      },
      toggleReadSelected: () => {
        if (bulk(selection.current.mails.some((entry) => entry.unread) ? "read" : "unread")) return;
        guarded((entry) => mailAction("read", entry));
      },
      replySelected: () => {
        guarded(replyTo);
      },
      forwardSelected: () => {
        guarded(forwardMail);
      },
    };

    return () => {
      navigationRef.current = null;
    };
  }, [
    navigationRef,
    openMessage,
    closeMessage,
    mailAction,
    bulkMailAction,
    toggleStar,
    replyTo,
    forwardMail,
    focusRow,
    listFocused,
    clearSelection,
  ]);

  useEffect(() => {
    if (pendingFocus.current === "reader" && mail) {
      pendingFocus.current = null;
      readerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (pendingFocus.current === "list" && !mail) {
      pendingFocus.current = null;
      focusRow(selectedThreadId);
    }
  }, [mail, selectedThreadId, focusRow]);

  const previous = openThread && mail ? openThread.messages.filter((message) => message.id !== mail.id) : [];
  const allExpanded = previous.every((message) => !collapsedPrevious.includes(message.id));

  const togglePrevious = (id: string) =>
    setCollapsedPrevious((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  const toggleAllPrevious = () =>
    setCollapsedPrevious(allExpanded ? previous.map((message) => message.id) : []);

  // Les antérieurs sont dépliés par défaut : leur corps se lit dès qu'ils sont
  // visibles. La clé est la liste des corps manquants, pas `previous` (nouveau
  // tableau à chaque rendu) : une lecture ratée n'est pas rejouée en boucle.
  const pendingBodies = previous
    .filter((message) => !collapsedPrevious.includes(message.id) && !message.bodyFetched)
    .map((message) => message.id)
    .join(",");
  useEffect(() => {
    for (const id of pendingBodies.split(",").filter(Boolean)) {
      const message = previous.find((entry) => entry.id === id);
      if (message) fetchBody(message);
    }
  }, [pendingBodies]);

  const readerActions: QuickAction[] = mail && !readOnly
    ? [
        {
          label: mail.starred ? "Retirer l'étoile" : "Marquer d'une étoile",
          icon: Star,
          filled: mail.starred,
          run: () => toggleStar(mail.id),
        },
        mail.folder === "spam"
          ? {
              label: "Non spam",
              icon: ShieldCheck,
              run: () => {
                moveToInbox(mail);
                closeMessage();
              },
            }
          : mail.folder === "archive" || mail.folder === "trash"
            ? {
                label: "Restaurer",
                icon: RotateCcw,
                run: () => {
                  restoreMail(mail);
                  closeMessage();
                },
              }
            : {
                label: "Archiver",
                icon: Archive,
                run: () => {
                  mailAction("archive", mail);
                  closeMessage();
                },
              },
        {
          label: mail.folder === "trash" ? "Supprimer définitivement" : "Supprimer",
          icon: Trash2,
          run: () => {
            mailAction("delete", mail);
            closeMessage();
          },
        },
      ]
    : [];

  const renderAction = (action: QuickAction) => (
    <DIconButton key={action.label} label={action.label} onClick={action.run}>
      <ActionIcon action={action} size="size-4" />
    </DIconButton>
  );

  return (
    <>
      <div
        ref={gridRef}
        className={cn(
          "relative grid h-full min-h-0",
          tier === "wide" && draggingPane && "select-none",
          tier === "medium" && "grid-cols-[minmax(0,360px)_minmax(0,1fr)]",
          tier === "narrow" && "grid-cols-[minmax(0,1fr)]",
        )}
        style={
          tier === "wide"
            ? {
                gridTemplateColumns: `${railWidth}px ${SPLITTER_WIDTH}px ${listWidth}px ${SPLITTER_WIDTH}px minmax(0,1fr)`,
              }
            : undefined
        }
        data-testid="desktop-inbox"
        data-tier={tier}
        data-panes={tier === "wide" ? `${railWidth},${listWidth}` : undefined}
      >
        <aside className={cn("flex min-h-0 flex-col border-r border-line", tier !== "wide" && "hidden")}>
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2.5 pt-4 pb-2">
            <div className="flex min-h-full flex-col">
              <div className="flex items-center gap-2 px-1.5">
                <span
                  aria-hidden
                  className="size-[22px] rounded-[8px] bg-gradient-to-br from-accent-ring to-accent shadow-[0_7px_16px_-7px_var(--accent)]"
                />
                <p className="text-[15px] font-extrabold tracking-[-0.035em] text-ink">Lavande</p>
                <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink">PC</span>
                <DIconButton
                  label={dark ? "Passer en thème clair" : "Passer en thème sombre"}
                  onClick={() => setDark(!dark)}
                  className="ml-auto size-7"
                >
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </DIconButton>
              </div>

              <SectionLabel className="mt-4 mb-1.5 px-2.5">Comptes</SectionLabel>
              <div className="space-y-0.5">
                {(mailAccounts.length > 1) && (
                  <RailItem
                    active={account === ALL_ACCOUNTS}
                    onClick={() => setAccount(ALL_ACCOUNTS)}
                    label="Tous les comptes"
                    count={accountUnread(ALL_ACCOUNTS)}
                    icon={<span className="size-2 rounded-full bg-accent" />}
                  />
                )}
                {mailAccounts.map((entry) => (
                  <RailItem
                    key={entry.id}
                    active={account === entry.id}
                    onClick={() => setAccount(entry.id)}
                    label={entry.label}
                    count={accountUnread(entry.id)}
                    icon={<span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />}
                  />
                ))}
              </div>

              <SectionLabel className="mt-4 mb-1.5 px-2.5">Dossiers</SectionLabel>
              <div className="space-y-0.5">
                {folderRows.map((row) => {
                  const entry = row.node.item;
                  const stats = entry ? folderStats(entry.id, entry.path) : null;
                  const count =
                    !entry || !stats
                      ? 0
                      : entry.id === "sent"
                        ? 0
                        : entry.id === "drafts" || entry.id === "trash"
                          ? stats.total
                          : stats.unread;
                  const Icon = entry ? FOLDER_ICONS[entry.id] : FOLDER_ICONS.other;
                  const dragging = dragged?.path === row.node.path;
                  const marked = dropTarget?.path === row.node.path ? dropTarget : null;
                  return (
                    <div
                      key={row.node.path}
                      data-folder-row={row.node.path}
                      draggable={reorderable && entry !== null}
                      onContextMenu={(event) => {
                        if (!entry) return;
                        event.preventDefault();
                        setFolderMenu({ entry, x: event.clientX, y: event.clientY });
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer?.setData("text/plain", row.node.path);
                        setDragged({ path: row.node.path, depth: row.depth, parentPath: row.parentPath });
                      }}
                      onDragOver={(event) => {
                        if (
                          !dragged ||
                          dragged.depth !== row.depth ||
                          dragged.parentPath !== row.parentPath ||
                          dragged.path === row.node.path
                        )
                          return;
                        event.preventDefault();
                        const box = event.currentTarget.getBoundingClientRect();
                        setDropTarget({
                          path: row.node.path,
                          after: event.clientY > box.top + box.height / 2,
                        });
                      }}
                      onDragLeave={() =>
                        setDropTarget((current) =>
                          current?.path === row.node.path ? null : current,
                        )
                      }
                      onDrop={(event) => {
                        event.preventDefault();
                        const box = event.currentTarget.getBoundingClientRect();
                        dropOn(
                          row.node.path,
                          row.depth,
                          row.parentPath,
                          event.clientY > box.top + box.height / 2,
                        );
                      }}
                      onDragEnd={() => {
                        setDragged(null);
                        setDropTarget(null);
                      }}
                      className={cn("relative", dragging && "opacity-40")}
                    >
                      {marked && !marked.after ? (
                        <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-accent" />
                      ) : null}
                      <RailItem
                        active={
                          entry !== null &&
                          folder === entry.id &&
                          (entry.id !== "other" || row.node.path === folderPath)
                        }
                        onClick={
                          entry
                            ? () => setFolder(entry.id, entry.id === "other" ? entry.path : null)
                            : undefined
                        }
                        label={entry?.label ?? row.node.name}
                        count={count}
                        icon={<Icon className="size-4" />}
                        depth={row.depth}
                        expanded={row.expanded}
                        onToggle={row.hasChildren ? row.toggle : undefined}
                      />
                      {marked && marked.after ? (
                        <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />
                      ) : null}
                    </div>
                  );
                })}
                <HiddenFoldersRail count={hiddenFolderOptions.length}>
                  {hiddenFolderOptions.map((entry) => (
                    <RailItem
                      key={entry.path}
                      active={folder === "other" && folderPath === entry.path}
                      onClick={() => setFolder("other", entry.path)}
                      label={entry.label}
                      count={folderStats("other", entry.path).unread}
                      icon={<FOLDER_ICONS.other className="size-4" />}
                    />
                  ))}
                </HiddenFoldersRail>
                {folder === "trash" && (
                  <div className="pt-1">
                    <EmptyTrashButton
                      count={folderStats("trash").total}
                      onConfirm={emptyTrash}
                      variant="desktop"
                    />
                  </div>
                )}
              </div>

            </div>
          </div>
          <div className="shrink-0 px-2.5 pb-4 pt-2">
            <div className="rounded-[16px] border border-line bg-surface-2/60 p-2.5">
              <div className="flex items-center gap-1.5">
                <Lock className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.6} />
                <p className="text-[11px] font-bold text-ink">PGP</p>
                {myKey && pgpState ? (
                  <Badge tone={pgpTone} className="ml-auto">
                    {PGP_STATE[pgpState].label}
                  </Badge>
                ) : (
                  <span className="ml-auto text-[11px] font-semibold text-ink-muted">
                    {pgpKeys === null ? "chargement…" : "aucune clé"}
                  </span>
                )}
              </div>
              {myKey && pgpState ? (
                <>
                  <p className="mt-1.5 truncate text-[11px] font-semibold text-ink-muted">
                    {keyLabel(myKey)} ·{" "}
                    <span className="tabular-nums">{shortFingerprint(myKey.fingerprint)}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] font-medium text-ink-muted">
                    {myKey.expires_at ? `Expire le ${formatKeyDate(myKey.expires_at)}` : "Sans expiration"}
                  </p>
                  {pgpState !== "valid" ? (
                    <p
                      className={cn(
                        "mt-1.5 text-[11px] font-semibold",
                        pgpTone === "amber"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-rose-700 dark:text-rose-300",
                      )}
                    >
                      {PGP_STATE[pgpState].hint}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="mt-1.5 text-[11px] font-medium text-ink-muted">
                  {pgpKeys === null ? "Chargement de la clé…" : "Aucune clé PGP"}
                </p>
              )}
            </div>
          </div>
        </aside>

        {tier === "wide" ? (
          <PaneSplitter
            label="Largeur du rail de dossiers"
            value={railWidth}
            min={RAIL_MIN}
            max={RAIL_MAX}
            onChange={(rail) => setPanes((current) => ({ ...current, rail }))}
            onCommit={(rail) => setInboxPanes({ rail })}
            onReset={() => setInboxPanes({ rail: DEFAULT_INBOX_PANES.rail })}
            onDraggingChange={setDraggingPane}
          />
        ) : null}

        <section className="relative flex min-h-0 flex-col border-r border-line">
          <div className="shrink-0 px-4 pt-4 pb-2">
            <div className="flex items-center gap-2">
              <PaneTitle
                hint={
                  reception ? (
                    <>
                      <NumberTicker value={unreadThreads} /> non lus
                    </>
                  ) : (
                    `${visible.length} conversation${visible.length > 1 ? "s" : ""}`
                  )
                }
              >
                {heading}
              </PaneTitle>
              <DIconButton
                label={syncing ? "Synchronisation en cours" : "Synchroniser le dossier"}
                onClick={syncFolder}
                disabled={syncing}
                className="ml-auto"
              >
                <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
              </DIconButton>
            </div>

            <button
              type="button"
              onClick={onOpenSearch}
              aria-label="Ouvrir la recherche globale"
              className="focus-ring mt-3 flex h-9 w-full items-center gap-2 rounded-full border border-line bg-surface-2 px-3 text-[12px] font-semibold text-ink-muted transition-colors duration-200 hover:border-accent-ring hover:text-ink-soft"
            >
              <Search className="size-3.5 shrink-0" />
              <span className="truncate">Rechercher dans tous les mails…</span>
              <span className="ml-auto shrink-0">
                <Kbd>⌘K</Kbd>
              </span>
            </button>

            {tier !== "wide" ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5" data-testid="inbox-scope">
                <select
                  aria-label="Dossier"
                  value={`${folder}:${folderPath ?? ""}`}
                  onChange={(event) => {
                    const [id, path] = event.target.value.split(":");
                    setFolder(id as FolderId, id === "other" ? (path ?? null) : null);
                  }}
                  className="focus-ring h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[12px] font-semibold text-ink"
                >
                  {folderOptions.map((entry) => (
                    <option key={`${entry.id}:${entry.path}`} value={`${entry.id}:${entry.path}`}>
                      {entry.id === "other" ? entry.path : entry.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Compte"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  className="focus-ring h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-3 text-[12px] font-semibold text-ink"
                >
                  {mailAccounts.length > 1 ? (
                    <option value={ALL_ACCOUNTS}>Tous les comptes</option>
                  ) : null}
                  {mailAccounts.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                {myKey && pgpState ? (
                  <Badge tone={pgpTone} className="self-center">
                    PGP · {PGP_STATE[pgpState].label}
                  </Badge>
                ) : null}
              </div>
            ) : null}

            <div className="mt-2.5 flex flex-wrap gap-1.5 pb-1">
              {FILTERS.map((entry) => (
                <DChip key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
                  {entry.label}
                </DChip>
              ))}
            </div>
          </div>

          {reception ? (
            <div className="shrink-0 px-4">
              <MorningSummary
                open={summaryOpen}
                unread={unreadThreads}
                attachments={attachmentThreads}
                encrypted={encryptedThreads}
                demo={mode === "demo"}
                summary={summary}
                mails={summaryMails}
                loading={summaryLoading}
                onToggle={() => setSummaryOpen(!summaryOpen)}
                onOpen={openById}
                onRefresh={() => void refreshSummary(true)}
                onReply={replyTo}
                onPropose={proposeSummaryAction}
              />
            </div>
          ) : null}

          <div ref={listRef} className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-[104px]">
            {visible.map((thread, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={selectedThreadId === thread.id}
                checked={selectedIds.has(thread.id)}
                delay={Math.min(0.4, 0.06 + index * 0.04)}
                onOpen={(event) => selectThread(thread, index, event)}
                onStar={() => toggleStar(thread.primary.id)}
                onRead={() => mailAction("read", thread.primary)}
                onArchive={() => mailAction("archive", thread.primary)}
                onDelete={() => mailAction("delete", thread.primary)}
                onRestore={() => restoreMail(thread.primary)}
                onNotSpam={() => moveToInbox(thread.primary)}
                onMenu={({ x, y }) => setMenu({ mail: thread.primary, x, y })}
              />
            ))}

            {visible.length === 0 ? (
              <div className="px-3 py-8">
                <EmptyState
                  icon={<MailIcon className="size-5" />}
                  title="Aucun message"
                  hint={
                    filter === "all"
                      ? mode === "api"
                        ? "Ce dossier est vide. Synchronise pour récupérer les messages du serveur."
                        : "Cette boîte est vide pour le compte sélectionné."
                      : "Aucune conversation ne correspond à ce filtre."
                  }
                />
                {filter !== "all" ? (
                  <div className="mt-3 flex justify-center">
                    <DButton size="sm" variant="ghost" onClick={() => setFilter("all")}>
                      <RotateCcw className="size-3.5" />
                      Réinitialiser le filtre
                    </DButton>
                  </div>
                ) : null}
                {filter === "all" && mode === "api" ? (
                  <div className="mt-3 flex justify-center">
                    <DButton size="sm" variant="soft" onClick={syncFolder} disabled={syncing}>
                      <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                      Synchroniser
                    </DButton>
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === "api" && hasMore && !threadsLoading ? (
              <div className="flex justify-center px-3 py-4">
                <DButton size="sm" variant="ghost" onClick={loadMore}>
                  Charger plus
                </DButton>
              </div>
            ) : null}
          </div>

          {selectedIds.size > 0 ? (
            <SelectionBar
              count={selectedMails.length}
              mails={selectedMails}
              folder={folder}
              allSelected={selectedIds.size >= visible.length}
              onAction={(kind) => {
                bulkMailAction(kind, selectedMails);
                clearSelection();
              }}
              onSelectAll={() => setSelectedIds(new Set(visible.map((thread) => thread.id)))}
              onClear={clearSelection}
            />
          ) : null}
        </section>

        {tier === "wide" ? (
          <PaneSplitter
            label="Largeur de la liste des mails"
            value={listWidth}
            min={LIST_MIN}
            max={listCeiling}
            onChange={(list) => setPanes((current) => ({ ...current, list }))}
            onCommit={(list) => setInboxPanes({ list })}
            onReset={() => setInboxPanes({ list: DEFAULT_INBOX_PANES.list })}
            onDraggingChange={setDraggingPane}
          />
        ) : null}

        <section
          ref={readerRef}
          tabIndex={-1}
          aria-label="Panneau de lecture"
          className={cn(
            "flex min-h-0 flex-col outline-none",
            tier === "narrow" && "absolute inset-0 z-30 bg-canvas",
            tier === "narrow" && !mail && "hidden",
          )}
        >
          {mail ? (
            <>
              <div className="sticky top-0 z-20 shrink-0">
                <header
                  className={cn(
                    "flex items-start gap-3 bg-surface/85 pt-4 pb-3 backdrop-blur",
                    tier === "wide" ? "px-8" : "px-5",
                  )}
                >
                  {tier === "narrow" ? (
                    <DIconButton
                      label="Revenir à la liste"
                      onClick={() => {
                        setCursor(currentIndex);
                        pendingFocus.current = "list";
                        closeMessage();
                      }}
                    >
                      <ChevronLeft className="size-4" />
                    </DIconButton>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <h1 className="line-clamp-2 text-[24px] leading-[1.22] font-extrabold tracking-[-0.035em] text-ink">
                      {mail.subject}
                    </h1>
                    <p className="mt-1 truncate text-[12.5px] font-semibold text-ink-muted">
                      {folderLabel(mail.folder)}
                      {openThread && openThread.count > 1 ? ` · ${openThread.count} messages` : ""}
                    </p>
                  </div>
                  <div className={cn("flex shrink-0 items-center gap-1", tier === "narrow" && "flex-wrap justify-end")}>
                    {readerActions.map(renderAction)}
                  </div>
                </header>

                <div className="flex items-center gap-2 border-b border-line bg-surface/70 px-5 py-2.5 backdrop-blur">
                  {readOnly ? (
                    <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted">
                      <Lock className="size-3.5" strokeWidth={2.4} />
                      Démo · lecture seule
                    </p>
                  ) : mail.folder === "drafts" ? (
                    <ShimmerButton
                      size="sm"
                      onClick={() => resumeDraft(mail)}
                      shimmerDuration={4}
                      className="h-8 rounded-lg px-3 text-[12px]"
                    >
                      <PenLine className="size-3.5" />
                      Reprendre le brouillon
                    </ShimmerButton>
                  ) : (
                    <>
                      <ShimmerButton
                        size="sm"
                        onClick={() => replyTo(mail)}
                        shimmerDuration={4}
                        className="h-8 rounded-lg px-3 text-[12px]"
                      >
                        <CornerUpLeft className="size-3.5" />
                        Répondre
                      </ShimmerButton>
                      <DButton variant="ghost" size="sm" onClick={() => forwardMail(mail)}>
                        <CornerUpRight className="size-3.5" />
                        Transférer
                      </DButton>
                      <DButton
                        variant="ghost"
                        size="sm"
                        onClick={() => void runAnalyse(mail)}
                      >
                        <Sparkles className="size-3.5" />
                        Analyse
                      </DButton>
                    </>
                  )}
                </div>

                {analyse && analyse.mailId === mail.id ? (
                  <AnalysePanel
                    analyse={analyse}
                    mail={mail}
                    variant="desktop"
                    onClose={closeAnalyse}
                    onAcceptTask={acceptAnalyseTask}
                    onAcceptEvent={acceptAnalyseEvent}
                    onUseReply={(body) => openReplyWithBody(mail, body)}
                    onRetry={() => void runAnalyse(mail, true)}
                  />
                ) : null}
              </div>

              <div
                className={cn(
                  "min-h-0 flex-1 overflow-y-auto py-6 pb-[120px]",
                  tier === "wide" ? "px-8" : "px-5",
                )}
              >
                <BlurFade yOffset={6}>
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={mail.folder === "sent" ? "Moi" : mail.name}
                      tone={mail.tone}
                      size={44}
                      rounded="rounded-full"
                    />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[14px] font-extrabold text-ink">
                          {mail.folder === "sent" ? "Moi" : mail.name}
                        </p>
                        {accountById(mail.account) ? (
                          <Badge tone={accountTone(mail.account)}>{accountById(mail.account)?.label}</Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[12.5px] font-medium text-ink-muted">
                        {mail.folder === "sent"
                          ? (mail.date ?? mail.time)
                          : `${mail.email} · ${mail.date ?? mail.time}`}
                      </p>
                    </div>
                  </div>

                  <MailRecipients mail={mail} className="mt-2" />

                  {mail.pgp !== "none" ? (
                    <div className="mt-3.5 flex items-center gap-2.5 rounded-[14px] border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2.5 text-emerald-700 dark:text-emerald-300">
                      {mail.pgp === "encrypted" ? (
                        <Lock className="size-4 shrink-0" strokeWidth={2.6} />
                      ) : (
                        <ShieldCheck className="size-4 shrink-0" strokeWidth={2.6} />
                      )}
                      <p className="text-[12.5px] font-semibold">
                        {mail.pgp === "encrypted" ? "Chiffré de bout en bout" : "Signature vérifiée"}
                        {myKey ? (
                          <>
                            {" · "}
                            <span className="tabular-nums">{shortFingerprint(myKey.fingerprint)}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                  ) : null}

                  {mail.attachments?.length ? (
                    <div className="mt-4 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {mail.attachments.map((file, index) => {
                          const busy = downloading === `${mail.id}:${file.name}`;
                          return (
                            <button
                              key={`${file.name}-${index}`}
                              type="button"
                              disabled={busy}
                              onClick={() => void runDownload(mail, file)}
                              aria-label={`Télécharger ${file.name} (${file.size})`}
                              className="flex items-center gap-2.5 rounded-[14px] border border-line bg-surface px-3.5 py-2.5 transition-colors hover:border-accent-ring disabled:opacity-60"
                            >
                              <Paperclip className="size-3.5 shrink-0 text-ink-muted" />
                              <span className="text-[12.5px] font-semibold text-ink-soft">{file.name}</span>
                              <span className="text-[11px] font-semibold text-ink-muted">{file.size}</span>
                              {busy ? (
                                <Loader2 className="size-3.5 animate-spin text-ink-muted" />
                              ) : (
                                <Download className="size-3.5 text-ink-muted" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <p role="status" aria-live="polite" className="text-[11px] font-medium text-ink-muted">
                        {downloadNotice ?? "Les fichiers sont relus sur le serveur au moment du téléchargement."}
                      </p>
                    </div>
                  ) : null}

                  {pgpLocked ? (
                    <div
                      role="status"
                      className="mt-4 flex items-start gap-3 rounded-[18px] border border-accent-ring/50 bg-surface-2 px-4 py-3"
                    >
                      <ShieldOff className="mt-0.5 size-4 shrink-0 text-accent-ink" strokeWidth={2.4} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] leading-snug font-bold text-ink">
                          Message chiffré · PGP désactivé pour ce compte
                        </p>
                        <p className="mt-1 text-[11.5px] leading-snug font-medium text-ink-soft">
                          Active PGP pour ce compte dans les réglages pour le déchiffrer.
                        </p>
                      </div>
                      {onOpenPgp ? (
                        <DButton size="sm" variant="soft" onClick={onOpenPgp} className="shrink-0">
                          Ouvrir les réglages
                        </DButton>
                      ) : null}
                    </div>
                  ) : null}

                  {bodyLoading ? (
                    <MailBodyLoading className="mt-6 max-w-[80ch] text-[14.5px] leading-[1.78]" />
                  ) : (
                    <MailBody
                      className="mt-6 max-w-[80ch] text-[14.5px] leading-[1.78]"
                      html={mail.html}
                      paragraphs={mail.body}
                      source={mail.source}
                      encrypted={mail.pgp === "encrypted"}
                    />
                  )}

                  {previous.length > 0 ? (
                    <div className="mt-7 border-t border-line pt-4">
                      <div className="flex items-center gap-2">
                        <SectionLabel>
                          {previous.length} message{previous.length > 1 ? "s" : ""} antérieur
                          {previous.length > 1 ? "s" : ""}
                        </SectionLabel>
                        <button
                          type="button"
                          onClick={toggleAllPrevious}
                          aria-label={allExpanded ? "Tout replier les messages antérieurs" : "Tout déplier les messages antérieurs"}
                          className="focus-ring relative ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-bold text-ink-muted transition-colors duration-200 before:absolute before:-inset-2 before:rounded-full before:content-[''] hover:bg-surface-2 hover:text-ink"
                        >
                          {allExpanded ? "Tout replier" : "Tout déplier"}
                        </button>
                      </div>

                      <div className="mt-2.5 space-y-2.5">
                        {previous.map((message) => {
                          const expanded = !collapsedPrevious.includes(message.id);
                          const who = message.folder === "sent" ? "Moi" : message.name;
                          return (
                            <div
                              key={message.id}
                              className="overflow-hidden rounded-[18px] border border-line bg-surface"
                            >
                              <button
                                type="button"
                                onClick={() => togglePrevious(message.id)}
                                aria-expanded={expanded}
                                aria-label={
                                  expanded ? `Replier le message de ${who}` : `Déplier le message de ${who}`
                                }
                                className="focus-ring flex w-full items-center gap-2.5 px-4 py-2.5 text-left"
                              >
                                <Avatar name={who} tone={message.tone} size={32} rounded="rounded-full" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="truncate text-[12.5px] font-bold text-ink">{who}</span>
                                    {accountById(message.account) ? (
                                      <Badge tone={accountTone(message.account)}>
                                        {accountById(message.account)?.label}
                                      </Badge>
                                    ) : null}
                                    {message.pgp === "encrypted" ? (
                                      <Lock className="size-3 shrink-0 text-emerald-700 dark:text-emerald-300" strokeWidth={2.6} />
                                    ) : message.pgp === "signed" ? (
                                      <ShieldCheck className="size-3 shrink-0 text-sky-700 dark:text-sky-300" strokeWidth={2.6} />
                                    ) : null}
                                    <span className="ml-auto shrink-0 text-[11.5px] font-semibold text-ink-muted">
                                      {message.date ?? message.time}
                                    </span>
                                  </span>
                                </span>
                                <ChevronDown
                                  className={cn(
                                    "size-4 shrink-0 text-ink-muted transition-transform duration-300",
                                    expanded && "rotate-180",
                                  )}
                                />
                              </button>

                              {expanded ? (
                                <div className="max-w-[78ch] space-y-2.5 px-4 pb-4">
                                  {bodyFetching === message.id ? (
                                    <MailBodyLoading className="text-[13.5px] leading-[1.7]" />
                                  ) : message.body.length > 0 || message.html ? (
                                    <MailBody
                                      className="text-[13.5px] leading-[1.7]"
                                      html={message.html}
                                      paragraphs={message.body}
                                      source={message.source}
                                      encrypted={message.pgp === "encrypted"}
                                    />
                                  ) : message.pgp === "encrypted" &&
                                    !resolvePgp(prefs, message.account).enabled ? (
                                    <p className="text-[12.5px] leading-snug font-medium text-ink-muted">
                                      Message chiffré · PGP désactivé pour ce compte
                                    </p>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </BlurFade>
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1">
              <EmptyState
                icon={<MailIcon className="size-5" />}
                title="Sélectionne un message"
                hint="La conversation s'ouvre ici, sans quitter ta boîte."
              />
            </div>
          )}
        </section>

        {tier === "wide" && draggingPane ? (
          <div aria-hidden className="absolute inset-0 z-40" />
        ) : null}
      </div>

      {menu ? (
        <MailContextMenu
          mail={menu.mail}
          ancre={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {folderMenu ? (
        <FolderContextMenu
          entry={folderMenu.entry}
          ancre={{ x: folderMenu.x, y: folderMenu.y }}
          onClose={() => setFolderMenu(null)}
        />
      ) : null}
    </>
  );
}
