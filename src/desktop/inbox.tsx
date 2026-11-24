import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  CornerUpLeft,
  CornerUpRight,
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  Forward,
  Inbox,
  KeyRound,
  Layers,
  ListTodo,
  Loader2,
  Lock,
  Mail as MailIcon,
  MailOpen,
  Moon,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  ReplyAll,
  RotateCcw,
  Rows3,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Star,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { FolderId, Mail, MailAttachment } from "@/lib/mail";
import { canReplyAll, folderLabel } from "@/lib/mail";
import { ISO_DAY, currentPeriod, summarySourceLabel, type SummaryRef, type SummaryResult } from "@/lib/summary";
import { dueToneFor, formatDueDate } from "@/lib/tasks";
import { downloadAttachment } from "@/lib/attachments";
import type { Thread } from "@/lib/threads";
import { threadsInFolder } from "@/lib/threads";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { FolderOption } from "@/lib/mail-backend";
import {
  DEFAULT_DECISION_THRESHOLDS,
  decisionReady,
  isPhishing,
  isPromptInjection,
  type CustomCategory,
  type DecisionThresholds,
  type MailDecision,
} from "@/lib/decision";
import { countCleanupByFilter } from "@/lib/cleanup";
import {
  applyTrustRules,
  asDecisionIndex,
  eventDraftFromMail,
  indexDecisions,
  senderDomain,
  summaryDecisionMeta,
  taskDraftFromMail,
  triageDecisionFor,
  type DecisionLookup,
} from "@/lib/triage";
import { openExternal } from "@/lib/open-external";
import type { NewEventInit } from "@/desktop/calendar";
import type { NewTaskDraft } from "@/desktop/planning";
import { suggestFolderForMail } from "@/lib/guards";
import { formatTotpCode } from "@/components/totp-popup";
import { InvitationBanner } from "@/components/invitation-banner";
import { PGP_STATE, formatKeyDate, keyLabel, keyState, shortFingerprint, type PgpKey } from "@/lib/pgp";
import { listKeys } from "@/lib/pgp-api";
import { useMailStore, type BulkKind } from "@/lib/store";
import { DEFAULT_INBOX_PANES, isFolderHidden, resolvePgp, usePrefs, type MailDensity } from "@/lib/prefs";
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
import { MessageTags } from "@/components/message-tags";
import { MailContextMenu } from "@/components/mail-context-menu";
import { AnalysePanel } from "@/components/analyse-panel";
import { CategoryManagerSheet, categoryColorStyle } from "@/components/category-manager-sheet";
import { CleanupScreen } from "@/screens/cleanup-screen";
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

type Filter =
  | "all"
  | "unread"
  | "starred"
  | "encrypted"
  | "attachments"
  | "priority"
  | "needs_reply"
  | "auth_totp"
  | "notification"
  | "promo"
  | `custom:${string}`;

function matchesCustomCategory(category: string, customId: string): boolean {
  return category === `custom:${customId}` || category === customId;
}

function isExcludedFromPriority(
  decision: MailDecision | undefined,
  customCategories: readonly CustomCategory[],
): boolean {
  if (!decision) return false;
  if (
    decision.category === "promo" ||
    decision.category === "spam" ||
    decision.category === "auth_totp" ||
    decision.category === "notification"
  ) {
    return true;
  }
  const custom = customCategories.find((cat) => matchesCustomCategory(decision.category, cat.id));
  return Boolean(custom?.excludeFromPriority);
}

function resolveDefaultFilter(
  configured: string,
  smartActive: boolean,
  customCategories: readonly CustomCategory[],
): Filter {
  if (!configured || configured === "all") return "all";
  if (!smartActive) return "all";
  if (
    configured === "priority" ||
    configured === "needs_reply" ||
    configured === "auth_totp" ||
    configured === "notification" ||
    configured === "promo"
  ) {
    return configured;
  }
  if (configured.startsWith("custom:")) {
    const id = configured.slice("custom:".length);
    if (customCategories.some((cat) => cat.id === id)) {
      return `custom:${id}`;
    }
  }
  return "all";
}

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
  "focus-ring min-w-0 max-w-full truncate text-left text-[12px] leading-[1.35] font-bold text-accent-ink underline decoration-[1.5px] underline-offset-2 transition-colors duration-200 hover:text-accent";

/** Heure courte d'un mail résumé : horodatage réel, sinon libellé déjà formaté. */
function summaryClock(mail: Mail): string {
  return typeof mail.timestamp === "number" ? clockOf(mail.timestamp) : mail.time;
}

const FILTERS: { id: "all" | "unread" | "starred" | "encrypted" | "attachments"; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "unread", label: "Non lus" },
  { id: "starred", label: "Étoilés" },
  { id: "encrypted", label: "Chiffrés" },
  { id: "attachments", label: "Fichiers" },
];

const NARROW_MAX = 859;
const MEDIUM_MAX = 1099;
const NARROW_QUERY = `(max-width: ${NARROW_MAX}px)`;
const MEDIUM_QUERY = `(max-width: ${MEDIUM_MAX}px)`;

/** Bornes des colonnes dossiers et liste, et largeur minimale gardée au lecteur. */
const SPLITTER_WIDTH = 8;
const RAIL_MIN = 160;
const RAIL_MAX = 480;
const LIST_MIN = 260;
const LIST_MAX = 1000;
const READER_MIN = 240;

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
  decisions,
  decisionThresholds = DEFAULT_DECISION_THRESHOLDS,
  customCategories = [],
  trustedSenders = [],
  trustedDomains = [],
  onToggle,
  onOpen,
  onRefresh,
  onReply,
  onPropose,
  onProposeEvent,
  onPlanMail,
  onScheduleMail,
  onTrustSender,
  onDelete,
  onArchive,
  onMoveToFolder,
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
  decisions?: DecisionLookup;
  decisionThresholds?: DecisionThresholds;
  customCategories?: readonly CustomCategory[];
  trustedSenders?: readonly string[];
  trustedDomains?: readonly string[];
  onToggle: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onReply: (mail: Mail) => void;
  onPropose: (ref: SummaryRef) => "added" | "existing";
  onProposeEvent?: (ref: SummaryRef) => "added" | "existing";
  onPlanMail?: (ref: SummaryRef, mail: Mail) => void;
  onScheduleMail?: (ref: SummaryRef, mail: Mail) => void;
  onTrustSender?: (mail: Mail) => void;
  onDelete?: (mail: Mail) => void;
  onArchive?: (mail: Mail) => void;
  onMoveToFolder?: (mail: Mail, folderPath: string) => void;
}) {
  const { summary: summaryConfig } = usePrefs();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [proposed, setProposed] = useState<Record<string, "added" | "existing">>({});
  const [proposedEvents, setProposedEvents] = useState<Record<string, "added" | "existing">>({});
  const [copiedCodes, setCopiedCodes] = useState<Record<string, boolean>>({});
  const copyTimers = useRef<Record<string, number>>({});
  useEffect(
    () => () => {
      for (const timer of Object.values(copyTimers.current)) window.clearTimeout(timer);
    },
    [],
  );
  const copyTotp = (mailId: string, code: string) => {
    try {
      void Promise.resolve(navigator.clipboard?.writeText(code)).catch(() => {});
    } catch {
      // presse-papiers indisponible
    }
    setCopiedCodes((current) => ({ ...current, [mailId]: true }));
    if (copyTimers.current[mailId]) window.clearTimeout(copyTimers.current[mailId]);
    copyTimers.current[mailId] = window.setTimeout(() => {
      setCopiedCodes((current) => {
        const next = { ...current };
        delete next[mailId];
        return next;
      });
      delete copyTimers.current[mailId];
    }, 2000);
  };
  const label = summary?.period.label ?? currentPeriod(summaryConfig).label;
  const source = summary ? summarySourceLabel(summary.source) : null;
  const decisionLookup = useMemo(() => (decisions ? asDecisionIndex(decisions) : null), [decisions]);
  const byId = useMemo(() => new Map(mails.map((mail) => [mail.id, mail])), [mails]);
  const generatedClock = summary ? clockOf(summary.generatedAt) : "";
  const rowsOf = (refs: SummaryRef[]): SummaryRow[] =>
    refs.flatMap((ref) => {
      const mail = byId.get(ref.mailId);
      return mail && mail.unread ? [{ ref, mail }] : [];
    });
  const metaFor = (mail: Mail) => {
    const rawDec = decisionLookup
      ? triageDecisionFor(mail, decisionLookup.byKey, decisionLookup.byMessageId)
      : undefined;
    const dec = rawDec
      ? applyTrustRules(rawDec, mail.email, {
          trustedSenders: [...trustedSenders],
          trustedDomains: [...trustedDomains],
        })
      : undefined;
    return summaryDecisionMeta(mail, dec, decisionThresholds, customCategories);
  };
  const allActions = summary ? rowsOf(summary.groups.actions) : [];
  const authRows: SummaryRow[] = [];
  const actions: SummaryRow[] = [];
  for (const row of allActions) {
    const meta = metaFor(row.mail);
    if (!meta.suspect && (meta.totpCode || meta.authLink)) {
      authRows.push(row);
    } else {
      actions.push(row);
    }
  }
  const infos = summary ? rowsOf(summary.groups.infos) : [];
  const notifications = summary ? rowsOf(summary.groups.notifications) : [];
  const hasGroupedRows =
    authRows.length > 0 || actions.length > 0 || infos.length > 0 || notifications.length > 0;
  const showHeadline = Boolean(
    summary?.headline && hasGroupedRows && !(summary.source === "decision" && hasGroupedRows),
  );
  const senders = [...new Set(notifications.map((row) => row.mail.name))];
  const notified = senders
    .slice(0, 2)
    .map((name) => {
      const count = notifications.filter((row) => row.mail.name === name).length;
      return count > 1 ? `${name} ×${count}` : name;
    })
    .join(", ");

  const infoRow = ({ ref, mail }: SummaryRow, variant: "card" | "list" = "card") => {
    const meta = metaFor(mail);
    return (
      <div
        key={ref.mailId}
        className={cn(
          "flex min-h-[34px] items-center gap-2 transition-colors duration-200",
          variant === "card"
            ? "rounded-[11px] border border-line bg-surface/90 px-2.5 py-1 hover:bg-surface"
            : "px-2.5 py-1.5 hover:bg-surface-2/45",
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-[6px] bg-surface-2 text-[9px] font-bold text-ink-soft">
          {initials(mail.name)}
        </span>
        <span className="hidden max-w-[120px] shrink-0 truncate text-[11.5px] font-bold text-ink @[420px]:inline">
          {mail.name}
        </span>
        <button
          type="button"
          onClick={() => onOpen(mail.id)}
          className="focus-ring min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-ink transition-colors duration-200 hover:text-accent-ink hover:underline"
        >
          {mail.subject}
        </button>
        {meta.customCategory ? (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold",
              categoryColorStyle(meta.customCategory.color).pill,
            )}
          >
            {meta.customCategory.name}
          </span>
        ) : meta.noiseTag ? (
          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] font-bold text-ink-muted">
            {meta.noiseTag}
          </span>
        ) : null}
        {meta.folderSuggestion && onMoveToFolder ? (
          <button
            type="button"
            onClick={() => onMoveToFolder(mail, meta.folderSuggestion!.path)}
            className="focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-accent-ring/60 bg-accent-soft px-2 text-[10px] font-bold text-accent-ink transition-colors hover:border-accent-ring"
          >
            <FolderInput className="size-3" />
            Ranger dans {meta.folderSuggestion.label}
          </button>
        ) : null}
        {onArchive ? (
          <button
            type="button"
            aria-label="Archiver"
            onClick={() => onArchive(mail)}
            className="focus-ring grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Archive className="size-3.5" />
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            aria-label="Supprimer"
            onClick={() => onDelete(mail)}
            className="focus-ring grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
        <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted tabular-nums">
          {summaryClock(mail)}
        </span>
      </div>
    );
  };

  const renderAuthBanner = ({ ref, mail }: SummaryRow, meta: ReturnType<typeof metaFor>) => {
    const copied = Boolean(copiedCodes[ref.mailId]);
    const badgeLabel = meta.totpCode
      ? meta.totpService
        ? `Code · ${meta.totpService}`
        : "Code"
      : meta.totpService
        ? `Accès · ${meta.totpService}`
        : "Vérification";

    return (
      <article
        key={ref.mailId}
        className="flex min-h-[38px] flex-col gap-1.5 rounded-[12px] border border-accent-ring/55 bg-surface px-2.5 py-1.5 @[480px]:flex-row @[480px]:items-center @[480px]:justify-between @[480px]:gap-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-accent-ring bg-accent-soft text-accent-ink">
            <KeyRound className="size-3" strokeWidth={2.4} />
          </span>
          <Badge tone="accent">{badgeLabel}</Badge>
          <button type="button" onClick={() => onOpen(mail.id)} className={SUMMARY_SUBJECT}>
            {mail.subject}
          </button>
          <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums @[480px]:ml-0">
            {summaryClock(mail)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {meta.totpCode ? (
            <>
              <span
                data-testid="summary-totp-code"
                className="inline-flex h-6 items-center rounded-lg border border-accent-ring/50 bg-accent-soft px-2 font-mono text-[12.5px] font-extrabold tracking-[0.14em] text-ink tabular-nums select-all"
              >
                {formatTotpCode(meta.totpCode)}
              </span>
              <button
                type="button"
                onClick={() => copyTotp(ref.mailId, meta.totpCode!)}
                className={copied ? SUMMARY_CHIP_DONE : SUMMARY_CHIP_FILLED}
              >
                {copied ? <Check className="size-3" strokeWidth={2.8} /> : <Copy className="size-3" strokeWidth={2.4} />}
                {copied ? "Copié !" : "Copier"}
              </button>
            </>
          ) : meta.authLink ? (
            <button type="button" onClick={() => openExternal(meta.authLink!)} className={SUMMARY_CHIP_FILLED}>
              <ExternalLink className="size-3" strokeWidth={2.4} />
              Ouvrir le lien
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              aria-label="Supprimer"
              onClick={() => onDelete(mail)}
              className="focus-ring grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
      </article>
    );
  };

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
      className="@container relative overflow-hidden rounded-[20px] border border-accent-ring/60 bg-[linear-gradient(105deg,var(--surface),var(--accent-soft))]"
    >
      <BorderBeam duration={9} />

      <div className="relative px-3.5 pt-3 pb-1.5">
        <div className="flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-accent text-accent-contrast">
            <Sparkles className={cn("size-4", loading && "animate-pulse")} strokeWidth={2.4} />
          </span>
          <p className="min-w-0 truncate text-[11px] font-bold tracking-[0.16em] text-accent-ink uppercase">
            {label}
          </p>
          {loading ? (
            <span
              data-testid="summary-loading"
              className="ml-auto inline-flex shrink-0 animate-pulse items-center gap-1 rounded-full border border-accent-ring/60 bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink"
            >
              <Sparkles className="size-3" strokeWidth={2.4} />
              Enrichissement…
            </span>
          ) : null}
          <span
            data-testid={source ? "summary-source" : "summary-badge"}
            className={cn(
              "shrink-0 rounded-full border border-accent-ring/60 bg-surface/80 px-2 py-0.5 text-[10px] font-bold text-accent-ink",
              !loading && "ml-auto",
            )}
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
            {showHeadline ? (
              <p className="mt-1 text-[12.5px] leading-[1.55] font-medium text-ink-soft">{summary.headline}</p>
            ) : null}
            <div
              data-testid="summary-attachments"
              className="mt-2 space-y-2"
            >
              {!hasGroupedRows ? (
                <p className="py-2 text-center text-[12px] font-medium text-ink-muted">
                  Tout a été lu sur la période.
                </p>
              ) : null}
              {authRows.length > 0 ? (
                <section>
                  <SummaryGroupTitle label="Vérification & accès" count={authRows.length} />
                  <div className="space-y-1">
                    {authRows.map((row) => renderAuthBanner(row, metaFor(row.mail)))}
                  </div>
                </section>
              ) : null}
              {actions.length > 0 ? (
                <section>
                  <SummaryGroupTitle label="À traiter" count={actions.length} />
                  <div className="space-y-1">
                    {actions.map((row) => {
                      const { ref, mail } = row;
                      const due = ref.due && ISO_DAY.test(ref.due) ? ref.due : null;
                      const meta = metaFor(mail);

                      if (meta.suspect) {
                        const suspectReason =
                          ref.reason ||
                          (meta.phishing
                            ? "Hameçonnage détecté · Ne cliquez sur aucun lien"
                            : "Alerte sécurité · injection détectée");
                        return (
                          <article
                            key={ref.mailId}
                            className={cn(
                              "flex min-h-[44px] flex-col gap-1.5 rounded-[12px] border px-2.5 py-1.5 @[480px]:flex-row @[480px]:items-center @[480px]:justify-between @[480px]:gap-3",
                              meta.phishing
                                ? "border-rose-500/35 bg-rose-500/[0.04]"
                                : "border-amber-500/35 bg-amber-500/[0.04]",
                            )}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span
                                className={cn(
                                  "grid size-[22px] shrink-0 place-items-center rounded-[7px]",
                                  meta.phishing
                                    ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                                    : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                                )}
                              >
                                <ShieldAlert className="size-3.5" strokeWidth={2.4} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="min-w-0 truncate text-[11.5px] font-bold text-ink">
                                    {mail.name}
                                  </span>
                                  <Badge tone={meta.phishing ? "rose" : "amber"}>
                                    {meta.phishing ? "Suspect · Phishing" : "Injection IA"}
                                  </Badge>
                                  <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums @[480px]:ml-0">
                                    {summaryClock(mail)}
                                  </span>
                                </div>
                                <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                                  <button type="button" onClick={() => onOpen(mail.id)} className={SUMMARY_SUBJECT}>
                                    {mail.subject}
                                  </button>
                                  <span aria-hidden="true" className="shrink-0 text-[11px] text-ink-muted">
                                    —
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-soft">
                                    {suspectReason}
                                  </span>
                                </div>
                              </div>
                            </div>
                            {onDelete || onTrustSender ? (
                              <div className="flex shrink-0 flex-wrap items-center gap-1 @[480px]:justify-end">
                                {onDelete ? (
                                  <button
                                    type="button"
                                    onClick={() => onDelete(mail)}
                                    className="focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-rose-600 px-2.5 text-[10.5px] font-bold text-white transition-colors hover:bg-rose-700"
                                  >
                                    <Trash2 className="size-3" strokeWidth={2.4} />
                                    Supprimer
                                  </button>
                                ) : null}
                                {onTrustSender ? (
                                  <button
                                    type="button"
                                    onClick={() => onTrustSender(mail)}
                                    className={SUMMARY_CHIP}
                                  >
                                    <ShieldCheck className="size-3" strokeWidth={2.4} />
                                    Pas suspect
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </article>
                        );
                      }

                      if (meta.totpCode) {
                        return renderAuthBanner(row, meta);
                      }

                      return (
                        <article
                          key={ref.mailId}
                          className="flex min-h-[44px] flex-col gap-1.5 rounded-[12px] border border-line bg-surface px-2.5 py-1.5 @[480px]:flex-row @[480px]:items-center @[480px]:justify-between @[480px]:gap-3"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-accent-ring bg-accent-soft text-[9.5px] font-bold text-accent-ink">
                              {initials(mail.name)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="min-w-0 truncate text-[11.5px] font-bold text-ink">{mail.name}</span>
                                {meta.urgent ? <Badge tone="rose">Urgent</Badge> : null}
                                {meta.customCategory ? (
                                  <span
                                    className={cn(
                                      "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold",
                                      categoryColorStyle(meta.customCategory.color).pill,
                                    )}
                                  >
                                    {meta.customCategory.name}
                                  </span>
                                ) : null}
                                {due ? (
                                  <Badge tone={SUMMARY_DUE_TONE[dueToneFor(due)]}>{formatDueDate(due)}</Badge>
                                ) : null}
                                <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums @[480px]:ml-0">
                                  {summaryClock(mail)}
                                </span>
                              </div>
                              <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                                <button type="button" onClick={() => onOpen(mail.id)} className={SUMMARY_SUBJECT}>
                                  {mail.subject}
                                </button>
                                {ref.reason ? (
                                  <>
                                    <span aria-hidden="true" className="shrink-0 text-[11px] text-ink-muted">
                                      —
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-soft">
                                      {ref.reason}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-1 @[480px]:justify-end">
                            {!onPlanMail && proposed[ref.mailId] ? (
                              <button type="button" disabled className={SUMMARY_CHIP_DONE}>
                                <Check className="size-3 shrink-0" strokeWidth={2.8} />
                                {proposed[ref.mailId] === "added" ? "Ajouté" : "Déjà proposé"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  if (onPlanMail) {
                                    onPlanMail(ref, mail);
                                    return;
                                  }
                                  const outcome = onPropose(ref);
                                  setProposed((current) => ({ ...current, [ref.mailId]: outcome }));
                                }}
                                className={SUMMARY_CHIP_FILLED}
                              >
                                <Plus className="size-3" strokeWidth={2.8} />
                                Planification
                              </button>
                            )}
                            {meta.hasEvent && (onScheduleMail || onProposeEvent) ? (
                              !onScheduleMail && proposedEvents[ref.mailId] ? (
                                <button type="button" disabled className={SUMMARY_CHIP_DONE}>
                                  <Check className="size-3 shrink-0" strokeWidth={2.8} />
                                  {proposedEvents[ref.mailId] === "added" ? "Ajouté" : "Déjà proposé"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (onScheduleMail) {
                                      onScheduleMail(ref, mail);
                                      return;
                                    }
                                    if (!onProposeEvent) return;
                                    const outcome = onProposeEvent(ref);
                                    setProposedEvents((current) => ({ ...current, [ref.mailId]: outcome }));
                                  }}
                                  className={SUMMARY_CHIP}
                                >
                                  + Agenda
                                </button>
                              )
                            ) : null}
                            <button type="button" onClick={() => onReply(mail)} className={SUMMARY_CHIP}>
                              {meta.needsReply ? (
                                <Sparkles className="size-3 text-accent-ink" strokeWidth={2.4} />
                              ) : (
                                <CornerUpLeft className="size-3" strokeWidth={2.4} />
                              )}
                              Répondre
                            </button>
                            {meta.folderSuggestion && onMoveToFolder ? (
                              <button
                                type="button"
                                onClick={() => onMoveToFolder(mail, meta.folderSuggestion!.path)}
                                className={SUMMARY_CHIP}
                              >
                                <FolderInput className="size-3" strokeWidth={2.4} />
                                Ranger dans {meta.folderSuggestion.label}
                              </button>
                            ) : null}
                            {onArchive ? (
                              <button
                                type="button"
                                aria-label="Archiver"
                                onClick={() => onArchive(mail)}
                                className="focus-ring grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                              >
                                <Archive className="size-3.5" />
                              </button>
                            ) : null}
                            {onDelete ? (
                              <button
                                type="button"
                                aria-label="Supprimer"
                                onClick={() => onDelete(mail)}
                                className="focus-ring grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            ) : null}
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
                  <div className="space-y-1">{infos.map((row) => infoRow(row, "card"))}</div>
                </section>
              ) : null}

              {notifications.length > 0 ? (
                <section>
                  <button
                    type="button"
                    onClick={() => setNotificationsOpen(!notificationsOpen)}
                    aria-expanded={notificationsOpen}
                    className="focus-ring flex w-full items-center gap-2 rounded-[11px] border border-dashed border-accent-ring/70 bg-surface/55 px-2.5 py-1.5 text-left transition-colors duration-200 hover:border-accent-ring"
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
                    <div className="mt-1 divide-y divide-line/70 rounded-[11px] border border-line bg-surface">
                      {notifications.map((row) => infoRow(row, "list"))}
                    </div>
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
        <div
          data-testid="summary-footer"
          className="relative flex items-center gap-1.5 border-t border-accent-ring/25 px-4 py-2 text-[10.5px] font-bold text-ink-muted"
        >
          <span>{loading ? "Mise à jour…" : `Généré à ${generatedClock}`}</span>
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
  decision = null,
  decisionThresholds = DEFAULT_DECISION_THRESHOLDS,
  customCategories = [],
  density = "cozy",
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
  decision?: MailDecision | null;
  decisionThresholds?: DecisionThresholds;
  customCategories?: readonly CustomCategory[];
  density?: MailDensity;
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
  const tight = density === "compact";

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
      (cat) => matchesCustomCategory(decision.category, cat.id),
    );
    if (customCat) {
      decisionBadges.push({
        label: customCat.name,
        className: categoryColorStyle(customCat.color).pill,
      });
    }
  }

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

        <div className={cn("pointer-events-none relative flex gap-3 px-3", tight ? "py-2" : "py-3.5")}>
          <div className="relative shrink-0">
            {tight && thread.count > 1 ? (
              <div className="relative h-[28px] w-[34px]">
                <span className="absolute bottom-0 left-[6px] size-[28px] rounded-full border border-line bg-surface-2/70" />
                <span className="absolute bottom-0 left-[3px] size-[28px] rounded-full border border-line bg-surface-2/70" />
                <Avatar
                  name={name}
                  tone={mail.tone}
                  size={28}
                  rounded="rounded-full"
                  className="absolute bottom-0 left-0"
                />
              </div>
            ) : (
              <Avatar
                name={name}
                tone={mail.tone}
                size={tight ? 28 : 40}
                rounded="rounded-full"
              />
            )}
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
                "truncate text-[13px] text-ink",
                tight ? "mt-0.5" : "mt-1",
                unread ? "font-bold" : "font-semibold",
              )}
            >
              {thread.subject}
            </p>

            {tight ? null : (
              <p className="mt-1 line-clamp-3 text-[12.5px] leading-[1.5] text-ink-muted">{thread.preview}</p>
            )}

            {(tight
              ? decisionBadges.length > 0
              : thread.count > 1 || thread.attachments > 0 || decisionBadges.length > 0) ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {!tight && thread.count > 1 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
                    {thread.count} messages
                  </span>
                ) : null}
                {!tight && thread.attachments > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
                    <Paperclip className="size-2.5" />
                    {thread.attachments}
                  </span>
                ) : null}
                {decisionBadges.map((badge) => (
                  <span
                    key={badge.label}
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                      badge.className,
                    )}
                  >
                    {badge.label}
                  </span>
                ))}
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
  onOpenNewTask,
  onOpenNewEvent,
}: {
  onOpenSearch: () => void;
  navigationRef?: React.RefObject<MailNavigation | null>;
  onOpenPgp?: () => void;
  onOpenNewTask?: (draft: NewTaskDraft) => void;
  onOpenNewEvent?: (draft: NewEventInit) => void;
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
    folderRecords,
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
    moveToFolder,
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
    proposeSummaryEvent,
    bodyFetching,
    fetchBody,
    hiddenFolderOptions,
    folderOrder,
    setFolderOrder,
    decisions,
    isDecisionReady,
    triageMails,
    trustSender,
    trustDomain,
  } = useMailStore();
  const { dark, setDark } = useTheme();
  const prefs = usePrefs();
  const { decision: decisionPrefs } = prefs;
  const smartActive = decisionReady(decisionPrefs) || Object.keys(decisions).length > 0;
  const reception = folder === "inbox" || folder === "unified";
  const [filter, setFilter] = useState<Filter>(() =>
    reception
      ? resolveDefaultFilter(
          decisionPrefs.defaultInboxFilter,
          smartActive,
          decisionPrefs.customCategories,
        )
      : "all",
  );
  const userPickedFilter = useRef(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupScanning, setCleanupScanning] = useState(false);
  const [confirmAnalyseInjection, setConfirmAnalyseInjection] = useState(false);
  const [asyncFolderSuggestion, setAsyncFolderSuggestion] = useState<{
    mailId: string;
    folderPath: string;
    folderLabel: string;
    confidence: number;
  } | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [collapsedPrevious, setCollapsedPrevious] = useState<string[]>([]);
  const [pgpKeys, setPgpKeys] = useState<PgpKey[] | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
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
    setDownloadPath(null);
    setDownloadNotice(`Téléchargement de « ${file.name} »…`);
    const { message, path } = await downloadAttachment(mail, file);
    setDownloadNotice(message);
    setDownloadPath(path);
    setDownloading(null);
  };

  const openDownloadFolder = async (path: string) => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch {
      setDownloadNotice("Ouverture du dossier impossible");
      setDownloadPath(null);
    }
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
  const decisionIndex = useMemo(() => indexDecisions(decisions), [decisions]);
  const decisionForThread = useCallback(
    (thread: Thread): MailDecision | undefined => {
      const primary = triageDecisionFor(
        thread.primary,
        decisionIndex.byKey,
        decisionIndex.byMessageId,
      );
      if (primary) return applyTrustRules(primary, thread.primary.email, decisionPrefs);
      for (const msg of thread.messages) {
        const hit = triageDecisionFor(msg, decisionIndex.byKey, decisionIndex.byMessageId);
        if (hit) return applyTrustRules(hit, msg.email, decisionPrefs);
      }
      return undefined;
    },
    [decisionIndex, decisionPrefs],
  );

  const smartCounts = useMemo(() => {
    if (!smartActive) {
      return {
        priority: 0,
        needsReply: 0,
        authTotp: 0,
        notification: 0,
        promo: 0,
        custom: {} as Record<string, number>,
      };
    }
    const custom: Record<string, number> = {};
    for (const cat of decisionPrefs.customCategories) custom[cat.id] = 0;
    let priority = 0;
    let needsReply = 0;
    let authTotp = 0;
    let notification = 0;
    let promo = 0;

    for (const thread of threads) {
      const dec = decisionForThread(thread);
      if (!isExcludedFromPriority(dec, decisionPrefs.customCategories)) priority += 1;
      if (dec) {
        if (dec.needsReply >= decisionPrefs.thresholds.category && !thread.primary.answered) {
          needsReply += 1;
        }
        if (dec.category === "auth_totp") authTotp += 1;
        else if (dec.category === "notification") notification += 1;
        else if (dec.category === "promo" || dec.category === "spam") promo += 1;
        else {
          for (const cat of decisionPrefs.customCategories) {
            if (matchesCustomCategory(dec.category, cat.id)) {
              custom[cat.id] = (custom[cat.id] ?? 0) + 1;
            }
          }
        }
      }
    }

    return { priority, needsReply, authTotp, notification, promo, custom };
  }, [
    smartActive,
    threads,
    decisionForThread,
    decisionPrefs.customCategories,
    decisionPrefs.thresholds.category,
  ]);

  const cleanupCount = useMemo(
    () =>
      smartActive
        ? countCleanupByFilter(
            mails,
            decisions,
            [],
            [],
            decisionPrefs.thresholds,
            Date.now(),
            decisionPrefs.customCategories,
          ).all
        : 0,
    [smartActive, mails, decisions, decisionPrefs.thresholds, decisionPrefs.customCategories],
  );

  const handleScanMoreCleanup = useCallback(async () => {
    if (cleanupScanning) return;
    const untriaged = mails.filter(
      (entry) =>
        entry.source && !triageDecisionFor(entry, decisionIndex.byKey, decisionIndex.byMessageId),
    );
    if (untriaged.length === 0) return;
    setCleanupScanning(true);
    try {
      await triageMails(untriaged, false);
    } finally {
      setCleanupScanning(false);
    }
  }, [cleanupScanning, decisionIndex, mails, triageMails]);

  const visible = threads.filter((thread) => {
    if (filter === "unread") return thread.unread > 0;
    if (filter === "starred") return thread.starred;
    if (filter === "encrypted") return thread.encrypted > 0;
    if (filter === "attachments") return thread.attachments > 0;
    if (filter === "all") return true;
    const dec = decisionForThread(thread);
    if (filter === "priority") {
      return !isExcludedFromPriority(dec, decisionPrefs.customCategories);
    }
    if (!dec) return false;
    if (filter === "needs_reply") {
      return dec.needsReply >= decisionPrefs.thresholds.category && !thread.primary.answered;
    }
    if (filter === "auth_totp") return dec.category === "auth_totp";
    if (filter === "notification") return dec.category === "notification";
    if (filter === "promo") return dec.category === "promo" || dec.category === "spam";
    if (filter.startsWith("custom:")) {
      const id = filter.slice("custom:".length);
      return matchesCustomCategory(dec.category, id);
    }
    return true;
  });
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

  const selectFilter = useCallback((next: Filter) => {
    userPickedFilter.current = true;
    setFilter(next);
  }, []);

  useEffect(() => {
    userPickedFilter.current = false;
    setFilter(
      reception
        ? resolveDefaultFilter(
            decisionPrefs.defaultInboxFilter,
            smartActive,
            decisionPrefs.customCategories,
          )
        : "all",
    );
  }, [folder, folderPath, account]);

  useEffect(() => {
    if (userPickedFilter.current) return;
    setFilter(
      reception
        ? resolveDefaultFilter(
            decisionPrefs.defaultInboxFilter,
            smartActive,
            decisionPrefs.customCategories,
          )
        : "all",
    );
  }, [
    reception,
    smartActive,
    decisionPrefs.defaultInboxFilter,
    decisionPrefs.customCategories,
  ]);

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

  const openMailDecision = useMemo(() => {
    if (!mail) return null;
    const raw = triageDecisionFor(mail, decisionIndex.byKey, decisionIndex.byMessageId);
    return raw ? applyTrustRules(raw, mail.email, decisionPrefs) : null;
  }, [mail, decisionIndex, decisionPrefs]);
  const securityThresholds = decisionPrefs.thresholds;
  const phishingAlert = Boolean(openMailDecision && isPhishing(openMailDecision, securityThresholds));
  const promptInjectionAlert = Boolean(
    openMailDecision && isPromptInjection(openMailDecision, securityThresholds),
  );
  const folderThreshold = securityThresholds.folder;

  const openMailCustomFolders = useMemo(() => {
    if (!mail) return [];
    const accId = mail.source?.accountId ?? mail.account;
    const fromRecords = folderRecords
      .filter(
        (record) =>
          record.accountId === accId &&
          record.role === "other" &&
          !isFolderHidden(prefs.hiddenFolders, accId, record.path),
      )
      .map((record) => ({ path: record.path, label: record.name }));
    if (fromRecords.length > 0) return fromRecords;
    return folderOptions
      .filter((option) => option.id === "other")
      .map((option) => ({ path: option.path, label: option.label }));
  }, [folderOptions, folderRecords, mail, prefs.hiddenFolders]);

  const isAlreadyInFolder = useCallback(
    (targetPath: string, targetLabel?: string) => {
      if (!mail) return false;
      const currentPath = mail.source?.folderPath;
      if (currentPath && currentPath === targetPath) return true;
      if (
        mail.folderName &&
        (mail.folderName === targetPath || (targetLabel && mail.folderName === targetLabel))
      ) {
        return true;
      }
      return false;
    },
    [mail],
  );

  const decisionFolderSuggestion = (() => {
    if (!mail || !openMailDecision?.suggestedFolder) return null;
    if ((openMailDecision.suggestedFolderConf ?? 0) < folderThreshold) return null;
    const match = openMailCustomFolders.find(
      (entry) =>
        entry.path === openMailDecision.suggestedFolder ||
        entry.label === openMailDecision.suggestedFolder,
    );
    const targetPath = match?.path ?? openMailDecision.suggestedFolder;
    const targetLabel =
      match?.label ??
      (openMailDecision.suggestedFolder.split(/[/.]/).filter(Boolean).pop() ||
        openMailDecision.suggestedFolder);
    if (isAlreadyInFolder(targetPath, targetLabel)) return null;
    return {
      folderPath: targetPath,
      folderLabel: targetLabel,
      confidence: openMailDecision.suggestedFolderConf ?? 0,
    };
  })();

  useEffect(() => {
    setConfirmAnalyseInjection(false);
  }, [mail?.id]);

  useEffect(() => {
    if (!mail || readOnly || decisionFolderSuggestion || openMailCustomFolders.length === 0) return;
    const config =
      isDecisionReady && !decisionPrefs.daemonHasKey
        ? { ...decisionPrefs, enabled: true, daemonHasKey: true }
        : decisionPrefs;
    if (!decisionReady(config)) return;
    let cancelled = false;
    void suggestFolderForMail(
      config,
      {
        from: `${mail.name} <${mail.email}>`,
        subject: mail.subject,
        excerpt: mail.preview || mail.body.join(" "),
        folders: openMailCustomFolders,
      },
      { useDaemon: mode === "api" },
    ).then((result) => {
      if (cancelled || !result) return;
      if (result.confidence < folderThreshold) return;
      if (isAlreadyInFolder(result.folderPath, result.folderLabel)) return;
      setAsyncFolderSuggestion({ mailId: mail.id, ...result });
    });
    return () => {
      cancelled = true;
    };
  }, [
    mail,
    readOnly,
    decisionFolderSuggestion,
    openMailCustomFolders,
    isDecisionReady,
    decisionPrefs,
    mode,
    folderThreshold,
    isAlreadyInFolder,
  ]);

  const activeFolderSuggestion =
    mail && !readOnly
      ? (decisionFolderSuggestion ??
        (asyncFolderSuggestion?.mailId === mail.id ? asyncFolderSuggestion : null))
      : null;

  const handleAnalyseClick = () => {
    if (!mail) return;
    if (promptInjectionAlert) {
      setConfirmAnalyseInjection(true);
      return;
    }
    void runAnalyse(mail);
  };

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

  useEscapeLayer(cleanupOpen, () => setCleanupOpen(false));
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

  /* Le fil est chronologique : ce qui précède le message ouvert est antérieur,
     ce qui le suit est postérieur — un message plus récent n'est pas un antérieur. */
  const threadMessages = openThread?.messages ?? [];
  const openIndex = mail ? threadMessages.findIndex((message) => message.id === mail.id) : -1;
  const earlier =
    openIndex >= 0
      ? threadMessages.slice(0, openIndex)
      : threadMessages.filter((message) => message.id !== mail?.id);
  const later = openIndex >= 0 ? threadMessages.slice(openIndex + 1) : [];
  const history = [...earlier, ...later];

  const togglePrevious = (id: string) =>
    setCollapsedPrevious((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  const allExpanded = (list: Mail[]) =>
    list.every((message) => !collapsedPrevious.includes(message.id));
  const toggleAllPrevious = (list: Mail[]) =>
    setCollapsedPrevious(allExpanded(list) ? list.map((message) => message.id) : []);

  // Les messages du fil sont dépliés par défaut : leur corps se lit dès qu'ils
  // sont visibles. La clé est la liste des corps manquants, pas `history`
  // (nouveau tableau à chaque rendu) : une lecture ratée n'est pas rejouée.
  const pendingBodies = history
    .filter((message) => !collapsedPrevious.includes(message.id) && !message.bodyFetched)
    .map((message) => message.id)
    .join(",");
  useEffect(() => {
    for (const id of pendingBodies.split(",").filter(Boolean)) {
      const message = history.find((entry) => entry.id === id);
      if (message) fetchBody(message);
    }
  }, [pendingBodies]);

  const messageCard = (message: Mail) => {
    const expanded = !collapsedPrevious.includes(message.id);
    const who = message.folder === "sent" ? "Moi" : message.name;
    const replyAll = canReplyAll(message, accountById(message.account)?.email);
    return (
      <div key={message.id} className="overflow-hidden rounded-[18px] border border-line bg-surface">
        <button
          type="button"
          onClick={() => togglePrevious(message.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ mail: message, x: event.clientX, y: event.clientY });
          }}
          aria-expanded={expanded}
          aria-label={expanded ? `Replier le message de ${who}` : `Déplier le message de ${who}`}
          className="focus-ring flex w-full items-center gap-2.5 px-4 py-2.5 text-left"
        >
          <Avatar name={who} tone={message.tone} size={32} rounded="rounded-full" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-bold text-ink">{who}</span>
              {accountById(message.account) ? (
                <Badge tone={accountTone(message.account)}>{accountById(message.account)?.label}</Badge>
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
                senderEmail={message.email}
                encrypted={message.pgp === "encrypted"}
              />
            ) : message.pgp === "encrypted" && !resolvePgp(prefs, message.account).enabled ? (
              <p className="text-[12.5px] leading-snug font-medium text-ink-muted">
                Message chiffré · PGP désactivé pour ce compte
              </p>
            ) : null}

            {readOnly ? null : (
              <div className="flex flex-wrap items-center gap-1">
                <DButton
                  size="sm"
                  onClick={() => replyTo(message)}
                  aria-label={`Répondre au message de ${who}`}
                  className="px-2 text-[11.5px]"
                >
                  <CornerUpLeft className="size-3.5" />
                  Répondre
                </DButton>
                {replyAll ? (
                  <DButton
                    size="sm"
                    onClick={() => replyTo(message, true)}
                    aria-label={`Répondre à tous les destinataires du message de ${who}`}
                    className="px-2 text-[11.5px]"
                  >
                    <ReplyAll className="size-3.5" />
                    Répondre à tous
                  </DButton>
                ) : null}
                <DButton
                  size="sm"
                  onClick={() => forwardMail(message)}
                  aria-label={`Transférer le message de ${who}`}
                  className="px-2 text-[11.5px]"
                >
                  <CornerUpRight className="size-3.5" />
                  Transférer
                </DButton>
                <DButton
                  size="sm"
                  onClick={() => openMessage(message)}
                  aria-label={`Ouvrir le message de ${who}`}
                  className="px-2 text-[11.5px]"
                >
                  <MailIcon className="size-3.5" />
                  Ouvrir
                </DButton>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const historySection = (label: string, list: Mail[], suffix: string) =>
    list.length === 0 ? null : (
      <div className="mt-7 border-t border-line pt-4">
        <div className="flex items-center gap-2">
          <SectionLabel>{label}</SectionLabel>
          <button
            type="button"
            onClick={() => toggleAllPrevious(list)}
            aria-label={`${allExpanded(list) ? "Tout replier" : "Tout déplier"} les messages ${suffix}`}
            className="focus-ring relative ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-bold text-ink-muted transition-colors duration-200 before:absolute before:-inset-2 before:rounded-full before:content-[''] hover:bg-surface-2 hover:text-ink"
          >
            {allExpanded(list) ? "Tout replier" : "Tout déplier"}
          </button>
        </div>

        <div className="mt-2.5 space-y-2.5">{list.map(messageCard)}</div>
      </div>
    );


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
                small={prefs.mailDensity === "compact"}
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
              <DIconButton
                label="Affichage compact"
                active={prefs.mailDensity === "compact"}
                aria-pressed={prefs.mailDensity === "compact"}
                onClick={() =>
                  prefs.setMailDensity(prefs.mailDensity === "compact" ? "cozy" : "compact")
                }
              >
                <Rows3 className="size-4" />
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
                <DChip key={entry.id} active={filter === entry.id} onClick={() => selectFilter(entry.id)}>
                  {entry.label}
                </DChip>
              ))}
              {smartActive ? (
                <>
                  {(
                    [
                      { id: "priority", label: "Prioritaire", count: smartCounts.priority },
                      { id: "needs_reply", label: "À répondre", count: smartCounts.needsReply },
                      { id: "auth_totp", label: "Codes & Auth", count: smartCounts.authTotp },
                      { id: "notification", label: "Notifications", count: smartCounts.notification },
                      { id: "promo", label: "Pub & Promos", count: smartCounts.promo },
                    ] as { id: Filter; label: string; count: number }[]
                  ).map((item) => (
                    <DChip
                      key={item.id}
                      active={filter === item.id}
                      onClick={() => selectFilter(item.id)}
                    >
                      <span>{item.label}</span>
                      <span
                        aria-hidden
                        className={cn(
                          "rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                          filter === item.id ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
                        )}
                      >
                        {item.count}
                      </span>
                    </DChip>
                  ))}
                  {decisionPrefs.customCategories.map((cat) => {
                    const catFilter: Filter = `custom:${cat.id}`;
                    const activeChip = filter === catFilter;
                    const style = categoryColorStyle(cat.color);
                    const count = smartCounts.custom[cat.id] ?? 0;
                    return (
                      <DChip
                        key={cat.id}
                        active={activeChip}
                        onClick={() => selectFilter(catFilter)}
                      >
                        <span className={cn("size-2 rounded-full", activeChip ? "bg-accent-contrast" : style.dot)} />
                        <span>{cat.name}</span>
                        <span
                          aria-hidden
                          className={cn(
                            "rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                            activeChip ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
                          )}
                        >
                          {count}
                        </span>
                      </DChip>
                    );
                  })}
                  <DChip onClick={() => setCategoriesOpen(true)}>
                    <Plus className="size-3.5" />
                    <span>Catégorie</span>
                  </DChip>
                  <DChip onClick={() => setCleanupOpen(true)}>
                    <Sparkles className="size-3.5" />
                    <span>Nettoyage</span>
                    {cleanupCount > 0 ? (
                      <span
                        aria-hidden
                        className="rounded-full bg-accent-soft px-1.5 text-[10px] font-bold text-accent-ink tabular-nums"
                      >
                        {cleanupCount}
                      </span>
                    ) : null}
                  </DChip>
                </>
              ) : null}
            </div>
          </div>

          <div ref={listRef} className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-[104px]">
            {reception ? (
              <div className="mb-2 px-2">
                <MorningSummary
                  open={summaryOpen}
                  unread={unreadThreads}
                  attachments={attachmentThreads}
                  encrypted={encryptedThreads}
                  demo={mode === "demo"}
                  summary={summary}
                  mails={summaryMails}
                  loading={summaryLoading}
                  decisions={decisionIndex}
                  decisionThresholds={decisionPrefs.thresholds}
                  customCategories={decisionPrefs.customCategories}
                  trustedSenders={decisionPrefs.trustedSenders}
                  trustedDomains={decisionPrefs.trustedDomains}
                  onToggle={() => setSummaryOpen(!summaryOpen)}
                  onOpen={openById}
                  onRefresh={() => void refreshSummary(true)}
                  onReply={replyTo}
                  onPropose={proposeSummaryAction}
                  onProposeEvent={proposeSummaryEvent}
                  onPlanMail={
                    onOpenNewTask
                      ? (ref, entry) => {
                          const rawDec = triageDecisionFor(
                            entry,
                            decisionIndex.byKey,
                            decisionIndex.byMessageId,
                          );
                          const dec = rawDec
                            ? applyTrustRules(rawDec, entry.email, decisionPrefs)
                            : undefined;
                          onOpenNewTask(taskDraftFromMail(entry, ref, dec));
                        }
                      : undefined
                  }
                  onScheduleMail={
                    onOpenNewEvent
                      ? (ref, entry) => onOpenNewEvent(eventDraftFromMail(entry, ref))
                      : undefined
                  }
                  onTrustSender={readOnly ? undefined : (entry) => trustSender(entry.email)}
                  onDelete={readOnly ? undefined : (entry) => mailAction("delete", entry)}
                  onArchive={readOnly ? undefined : (entry) => mailAction("archive", entry)}
                  onMoveToFolder={
                    readOnly
                      ? undefined
                      : (entry, target) => {
                          const accId = entry.source?.accountId ?? entry.account;
                          const match = folderRecords.find(
                            (record) =>
                              record.accountId === accId &&
                              (record.path === target || record.name === target),
                          );
                          moveToFolder(entry, match?.path ?? target);
                        }
                  }
                />
              </div>
            ) : null}

            <div className="space-y-1">
              {visible.map((thread, index) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  selected={selectedThreadId === thread.id}
                  checked={selectedIds.has(thread.id)}
                  delay={Math.min(0.4, 0.06 + index * 0.04)}
                  decision={decisionForThread(thread)}
                  decisionThresholds={decisionPrefs.thresholds}
                  customCategories={decisionPrefs.customCategories}
                  density={prefs.mailDensity}
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
                      <DButton size="sm" variant="ghost" onClick={() => selectFilter("all")}>
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
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                      <p className="truncate text-[12.5px] font-semibold text-ink-muted">
                        {folderLabel(mail.folder)}
                        {openThread && openThread.count > 1 ? ` · ${openThread.count} messages` : ""}
                      </p>
                      {mail.answered ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted">
                          <CornerUpLeft className="size-3" />
                          Répondu
                        </span>
                      ) : null}
                      {activeFolderSuggestion ? (
                        <button
                          type="button"
                          onClick={() => moveToFolder(mail, activeFolderSuggestion.folderPath)}
                          className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-ring/60 bg-accent-soft px-2.5 py-0.5 text-[11px] font-bold text-accent-ink transition-colors hover:border-accent-ring"
                        >
                          <FolderInput className="size-3" />
                          Ranger dans {activeFolderSuggestion.folderLabel}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className={cn("flex shrink-0 items-center gap-1", tier === "narrow" && "flex-wrap justify-end")}>
                    {readerActions.map(renderAction)}
                  </div>
                </header>

                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/70 px-5 py-2.5 backdrop-blur">
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
                      {canReplyAll(mail, accountById(mail.account)?.email) ? (
                        <DButton variant="ghost" size="sm" onClick={() => replyTo(mail, true)}>
                          <ReplyAll className="size-3.5" />
                          Répondre à tous
                        </DButton>
                      ) : null}
                      <DButton variant="ghost" size="sm" onClick={() => forwardMail(mail)}>
                        <CornerUpRight className="size-3.5" />
                        Transférer
                      </DButton>
                      <DButton
                        variant="ghost"
                        size="sm"
                        onClick={handleAnalyseClick}
                      >
                        <Sparkles className="size-3.5" />
                        Analyse
                      </DButton>
                      {onOpenNewTask ? (
                        <DButton
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            onOpenNewTask(
                              taskDraftFromMail(mail, undefined, openMailDecision ?? undefined),
                            )
                          }
                        >
                          <ListTodo className="size-3.5" />
                          Planifier
                        </DButton>
                      ) : null}
                      {onOpenNewEvent ? (
                        <DButton
                          variant="ghost"
                          size="sm"
                          onClick={() => onOpenNewEvent(eventDraftFromMail(mail))}
                        >
                          <CalendarPlus className="size-3.5" />
                          + Agenda
                        </DButton>
                      ) : null}
                    </>
                  )}
                </div>

                {confirmAnalyseInjection ? (
                  <div
                    role="alertdialog"
                    aria-label="Confirmer l'analyse malgré l'injection de prompt"
                    className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2.5"
                  >
                    <p className="min-w-0 flex-1 text-[12px] font-semibold text-ink">
                      Ce mail semble contenir une tentative d'injection de prompt. Analyser quand même ?
                    </p>
                    <DButton size="sm" variant="ghost" onClick={() => setConfirmAnalyseInjection(false)}>
                      Annuler
                    </DButton>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmAnalyseInjection(false);
                        void runAnalyse(mail);
                      }}
                      className="focus-ring inline-flex h-8 items-center rounded-lg bg-amber-600 px-3 text-[12px] font-bold text-white transition-colors hover:bg-amber-700"
                    >
                      Analyser quand même
                    </button>
                  </div>
                ) : null}

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
                  <MessageTags source={mail.source} />

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
                      {downloadPath ? (
                        <button
                          type="button"
                          onClick={() => void openDownloadFolder(downloadPath)}
                          className="focus-ring inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent-ink transition-colors duration-200 hover:text-accent"
                        >
                          <FolderOpen className="size-3.5" />
                          Ouvrir le dossier
                        </button>
                      ) : null}
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

                  {mail.source ? (
                    <InvitationBanner
                      accountId={mail.source.accountId}
                      folderPath={mail.source.folderPath}
                      uid={mail.source.uid}
                      attachments={mail.attachments}
                      selfEmail={accountById(mail.account)?.email}
                      readOnly={readOnly}
                    />
                  ) : null}

                  {phishingAlert ? (
                    <div
                      role="alert"
                      className="mt-4 flex items-start gap-2.5 rounded-[18px] border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-700 dark:text-red-300"
                    >
                      <ShieldAlert className="mt-0.5 size-4.5 shrink-0" strokeWidth={2.4} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] leading-snug font-bold">
                          Alerte hameçonnage (phishing)
                        </p>
                        <p className="mt-1 text-[11.5px] leading-snug font-medium">
                          Ce message présente des signes d'hameçonnage. Ne clique pas sur les liens et n'ouvre pas les pièces jointes.
                        </p>
                        {!readOnly ? (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => trustSender(mail.email)}
                              className="focus-ring inline-flex h-7 items-center gap-1 rounded-full border border-red-500/30 bg-surface px-2.5 text-[11px] font-bold text-ink transition-colors hover:border-accent-ring"
                            >
                              <ShieldCheck className="size-3.5" strokeWidth={2.2} />
                              Pas suspect
                            </button>
                            {senderDomain(mail.email) ? (
                              <button
                                type="button"
                                onClick={() => trustDomain(mail.email)}
                                className="focus-ring inline-flex h-7 items-center rounded-full border border-red-500/20 bg-surface/75 px-2.5 text-[11px] font-semibold text-ink-soft transition-colors hover:border-accent-ring hover:text-ink"
                              >
                                Faire confiance au domaine
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {promptInjectionAlert ? (
                    <div
                      role="status"
                      className="mt-3 flex items-start gap-2.5 rounded-[18px] border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-amber-800 dark:text-amber-300"
                    >
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] leading-snug font-bold">
                          Mail isolé des automatismes IA
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug font-medium">
                          Tentative d'injection de prompt détectée · exclu des résumés et extractions automatiques.
                        </p>
                        {!readOnly ? (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => trustSender(mail.email)}
                              className="focus-ring inline-flex h-7 items-center gap-1 rounded-full border border-amber-500/30 bg-surface px-2.5 text-[11px] font-bold text-ink transition-colors hover:border-accent-ring"
                            >
                              <ShieldCheck className="size-3.5" strokeWidth={2.2} />
                              Pas suspect
                            </button>
                            {senderDomain(mail.email) ? (
                              <button
                                type="button"
                                onClick={() => trustDomain(mail.email)}
                                className="focus-ring inline-flex h-7 items-center rounded-full border border-amber-500/20 bg-surface/75 px-2.5 text-[11px] font-semibold text-ink-soft transition-colors hover:border-accent-ring hover:text-ink"
                              >
                                Faire confiance au domaine
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {bodyLoading ? (
                    <MailBodyLoading className="mt-6 max-w-[80ch] text-[14.5px] leading-[1.78]" />
                  ) : (
                    <MailBody
                      className={cn(
                        "mt-6 text-[14.5px] leading-[1.78]",
                        mail.html ? "w-full" : "max-w-[80ch]",
                      )}
                      html={mail.html}
                      paragraphs={mail.body}
                      source={mail.source}
                      senderEmail={mail.email}
                      encrypted={mail.pgp === "encrypted"}
                    />
                  )}

                  {historySection(
                    `${earlier.length} message${earlier.length > 1 ? "s" : ""} antérieur${
                      earlier.length > 1 ? "s" : ""
                    }`,
                    earlier,
                    "antérieurs",
                  )}
                  {historySection(
                    `${later.length} message${later.length > 1 ? "s" : ""} suivant${
                      later.length > 1 ? "s" : ""
                    }`,
                    later,
                    "suivants",
                  )}
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

      <CategoryManagerSheet
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        onRetriage={() => triageMails(mails, true)}
      />

      {cleanupOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Nettoyage de boîte"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-[2px]"
        >
          <div className="h-[min(86vh,760px)] w-full max-w-3xl overflow-hidden rounded-[28px] border border-line bg-canvas shadow-2xl">
            <CleanupScreen
              mails={mails}
              decisions={decisions}
              thresholds={decisionPrefs.thresholds}
              customCategories={decisionPrefs.customCategories}
              onTrash={(targets) => bulkMailAction("delete", targets)}
              onArchive={(targets) => bulkMailAction("archive", targets)}
              onRestore={(targets) => bulkMailAction("restore", targets)}
              onOpenMail={(target) => {
                setCleanupOpen(false);
                openMessage(target);
              }}
              onScanMore={handleScanMoreCleanup}
              scanning={cleanupScanning}
              onClose={() => setCleanupOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
