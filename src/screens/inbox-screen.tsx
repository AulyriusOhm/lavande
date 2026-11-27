import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, Check, ChevronDown, ChevronUp, Copy, CornerUpLeft, ExternalLink, FolderInput, Inbox, KeyRound, Layers, Loader2, PenLine, Plus, RotateCcw, Rows3, Search, RefreshCw, Send, ShieldAlert, ShieldCheck, Sparkles, Trash2, type LucideIcon } from "lucide-react";
import type { FolderId, Mail } from "@/lib/mail";
import { folderLabel } from "@/lib/mail";
import { currentPeriod, summarySourceLabel, type SummaryRef } from "@/lib/summary";
import { dueToneFor, formatDueDate } from "@/lib/tasks";
import { threadsInFolder, type Thread } from "@/lib/threads";
import { decisionMailKey } from "@/lib/decision-db";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import {
  decisionReady,
  isExcludedFromPriority,
  matchesCustomCategory,
  type CustomCategory,
  type MailDecision,
} from "@/lib/decision";
import { countCleanupByFilter } from "@/lib/cleanup";
import {
  applyTrustRules,
  eventDraftFromMail,
  INBOX_FILTER_TAGS,
  inboxChipEntries,
  inboxGroup,
  inboxGroupForFilter,
  inboxSmartCounts,
  inboxTagLabel,
  indexDecisions,
  summaryDecisionMeta,
  taskDraftFromMail,
  triageDecisionFor,
} from "@/lib/triage";
import { openExternal } from "@/lib/open-external";
import type { NewEventDraft } from "@/screens/new-event-sheet";
import type { NewTaskDraft } from "@/screens/new-task-sheet";
import { formatTotpCode } from "@/components/totp-popup";
import { usePrefs } from "@/lib/prefs";
import { useMailStore } from "@/lib/store";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { accentContrast } from "@/lib/theme";
import { clockOf, cn, initials } from "@/lib/utils";
import { Avatar, Chip, IconButton } from "@/components/ui/primitives";
import { AnimatedGradientText } from "@/components/ui/animated-text";
import { BorderBeam } from "@/components/ui/border-beam";
import { NumberTicker } from "@/components/ui/number-ticker";
import { MeshGlow } from "@/components/ui/backdrops";
import { ThreadRow } from "@/components/thread-row";
import { EmptyTrashButton } from "@/components/empty-trash";
import { HiddenFoldersRail } from "@/components/folder-row";
import { useFolderTree } from "@/components/folder-tree";
import { CategoryManagerSheet, categoryColorStyle } from "@/components/category-manager-sheet";
import { moveFolderPath } from "@/lib/folder-tree";

type Filter =
  | "all"
  | "unread"
  | "starred"
  | "encrypted"
  | "priority"
  | "needs_reply"
  | `group:${string}`
  | `tag:${string}`
  | `custom:${string}`;

function resolveDefaultFilter(
  configured: string,
  smartActive: boolean,
  customCategories: readonly CustomCategory[],
): Filter {
  if (!configured || configured === "all") return "all";
  if (!smartActive) return "all";
  if (configured === "priority" || configured === "needs_reply") return configured;
  if (configured.startsWith("group:")) {
    return inboxGroup(configured.slice("group:".length)) ? (configured as Filter) : "all";
  }
  // Vues héritées enregistrées avant les groupes : un tag nu devient un filtre fin.
  const tag = configured.startsWith("tag:") ? configured.slice("tag:".length) : configured;
  if (INBOX_FILTER_TAGS.has(tag)) return `tag:${tag}`;
  if (configured.startsWith("custom:")) {
    const id = configured.slice("custom:".length);
    if (customCategories.some((cat) => cat.id === id)) {
      return `custom:${id}`;
    }
  }
  return "all";
}

function FilterCount({ active, count }: { active: boolean; count: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "rounded-full px-1.5 text-[10px] font-bold",
        active ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
      )}
    >
      {count}
    </span>
  );
}

const INTRO_HOLD_MS = 2000;

const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const SUMMARY_CHIP =
  "focus-ring relative inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[10.5px] font-bold text-ink-soft transition-colors duration-200 before:absolute before:-inset-y-2 before:inset-x-0 before:rounded-full before:content-['']";
const SUMMARY_CHIP_FILLED =
  "focus-ring relative inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent px-2.5 text-[10.5px] font-bold text-accent-contrast transition-colors duration-200 before:absolute before:-inset-y-2 before:inset-x-0 before:rounded-full before:content-['']";
const SUMMARY_CHIP_DONE =
  "inline-flex h-7 shrink-0 cursor-default items-center gap-1 rounded-full border border-accent-ring/60 bg-accent-soft px-2.5 text-[10.5px] font-bold text-accent-ink";
const SUMMARY_DUE_TONE: Record<ReturnType<typeof dueToneFor>, string> = {
  late: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  soon: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  soft: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  none: "bg-surface-2 text-ink-muted",
};

function summaryClock(mail: Mail) {
  return typeof mail.timestamp === "number" ? clockOf(mail.timestamp) : mail.time;
}

function SummaryTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[9.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
      <span>{label}</span>
      <span className="rounded-full bg-surface px-1.5 py-0.5 text-[9.5px] font-bold tracking-normal text-ink-soft tabular-nums">
        {count}
      </span>
    </div>
  );
}

export function InboxScreen({
  mails,
  account,
  folder,
  active,
  navigationRef,
  onOpenAccounts,
  onOpenFolders,
  onOpen,
  onToggleStar,
  onSearch,
  onMailAction,
  onReply,
  onNotSpam,
  onRestore,
  onForward,
  onOpenMenu,
  onOpenCleanup,
  onPlanMail,
  onScheduleMail,
}: {
  mails: Mail[];
  account: string;
  folder: FolderId;
  active: boolean;
  navigationRef: RefObject<MailNavigation | null>;
  onOpenAccounts: () => void;
  onOpenFolders: () => void;
  onOpen: (mail: Mail) => void;
  onToggleStar: (id: string) => void;
  onSearch: () => void;
  onMailAction: (kind: "delete" | "archive" | "read", mail: Mail) => void;
  onReply: (mail: Mail) => void;
  onForward?: (mail: Mail) => void;
  onNotSpam?: (mail: Mail) => void;
  onRestore?: (mail: Mail) => void;
  onOpenMenu?: (mail: Mail) => void;
  onOpenCleanup?: () => void;
  onPlanMail?: (draft: NewTaskDraft) => void;
  onScheduleMail?: (draft: NewEventDraft) => void;
}) {
  const {
    summary: summaryConfig,
    decision: decisionPrefs,
    mailDensity,
    setMailDensity,
    mailPreview,
    mailPreviewStyle,
  } = usePrefs();
  const summaryLabel = currentPeriod(summaryConfig).label;
  const {
    mode,
    readOnly,
    syncing,
    syncFolder,
    threadsLoading,
    hasMore,
    loadMore,
    folderPath,
    folderOptions,
    folderRecords,
    accountById,
    folderStats,
    summary,
    summaryLoading,
    summaryMails,
    refreshSummary,
    proposeSummaryAction,
    proposeSummaryEvent,
    moveToFolder,
    openMail,
    closeMessage,
    decisions,
    isDecisionReady,
    triagePendingKeys,
    triageMails,
    trustSender,
  } = useMailStore();

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
  const [compact, setCompact] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [sizes, setSizes] = useState({ hero: 0, bar: 0 });
  const [cursor, setCursor] = useState<number | null>(null);
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
  const rowsRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const focusRow = useCallback((id: string | null) => {
    if (!id || !rowsRef.current) return;
    const row = Array.from(rowsRef.current.querySelectorAll<HTMLElement>("[data-mail-row]")).find(
      (element) => element.dataset.mailRow === id,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
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

  const selectFilter = useCallback((next: Filter) => {
    userPickedFilter.current = true;
    setFilter(next);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const measure = () =>
      setSizes({
        hero: heroRef.current?.offsetHeight ?? 0,
        bar: barRef.current?.offsetHeight ?? 0,
      });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const collapse = useCallback(() => {
    setCompact(true);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCompact(true);
      return;
    }

    const timer = window.setTimeout(collapse, INTRO_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [collapse]);

  const expand = useCallback(() => {
    setCompact(false);
  }, []);

  const threads = useMemo(() => threadsInFolder(mails, folder, account), [mails, folder, account]);
  const heading =
    folderOptions.find(
      (entry) => entry.id === folder && (entry.id !== "other" || entry.path === folderPath),
    )?.label ?? folderLabel(folder);
  const unreadCount = threads.filter((thread) => thread.unread > 0).length;
  const starredCount = threads.filter((thread) => thread.starred).length;
  const encryptedCount = threads.filter((thread) => thread.encrypted > 0).length;

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

  const decisionPendingFor = useCallback(
    (thread: Thread) => {
      const source = thread.primary.source;
      if (!isDecisionReady || !source) return false;
      if (triageDecisionFor(thread.primary, decisionIndex.byKey, decisionIndex.byMessageId)) return false;
      return triagePendingKeys.has(
        decisionMailKey(source.accountId, source.folderPath, source.uid),
      );
    },
    [decisionIndex, isDecisionReady, triagePendingKeys],
  );

  const smartCounts = useMemo(
    () =>
      inboxSmartCounts(smartActive ? threads : [], decisionForThread, {
        customCategories: decisionPrefs.customCategories,
        thresholds: decisionPrefs.thresholds,
        answered: (thread) => Boolean(thread.primary.answered),
      }),
    [
      smartActive,
      threads,
      decisionForThread,
      decisionPrefs.customCategories,
      decisionPrefs.thresholds,
    ],
  );
  const chipEntries = inboxChipEntries(smartCounts);
  const activeGroup = inboxGroupForFilter(filter);

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
  const summaryById = useMemo(() => new Map(summaryMails.map((mail) => [mail.id, mail])), [summaryMails]);
  const summaryRows = (refs: SummaryRef[]) =>
    refs.flatMap((ref) => {
      const mail = summaryById.get(ref.mailId);
      return mail && mail.unread ? [{ ref, mail }] : [];
    });
  const summaryMetaFor = (mail: Mail) => {
    const rawDec = triageDecisionFor(mail, decisionIndex.byKey, decisionIndex.byMessageId);
    const dec = rawDec ? applyTrustRules(rawDec, mail.email, decisionPrefs) : undefined;
    return summaryDecisionMeta(
      mail,
      dec,
      decisionPrefs.thresholds,
      decisionPrefs.customCategories,
    );
  };
  const allActionRows = summary ? summaryRows(summary.groups.actions) : [];
  const authRows: { ref: SummaryRef; mail: Mail }[] = [];
  const actionRows: { ref: SummaryRef; mail: Mail }[] = [];
  for (const row of allActionRows) {
    const meta = summaryMetaFor(row.mail);
    if (!meta.suspect && (meta.totpCode || meta.authLink)) {
      authRows.push(row);
    } else {
      actionRows.push(row);
    }
  }
  const infoRows = summary ? summaryRows(summary.groups.infos) : [];
  const notificationRows = summary ? summaryRows(summary.groups.notifications) : [];
  const hasGroupedRows =
    authRows.length > 0 || actionRows.length > 0 || infoRows.length > 0 || notificationRows.length > 0;
  const showSummaryHeadline = Boolean(
    summary?.headline && hasGroupedRows && !(summary.source === "decision" && hasGroupedRows),
  );
  const moveSummaryMail = (targetMail: Mail, target: string) => {
    const accId = targetMail.source?.accountId ?? targetMail.account;
    const match = folderRecords.find(
      (record) => record.accountId === accId && (record.path === target || record.name === target),
    );
    moveToFolder(targetMail, match?.path ?? target);
  };
  const summaryRow = ({ ref, mail }: { ref: SummaryRef; mail: Mail }, variant: "card" | "list" = "card") => {
    const meta = summaryMetaFor(mail);
    return (
      <div
        key={ref.mailId}
        className={cn(
          "flex min-h-[34px] items-center gap-1.5",
          variant === "card"
            ? "rounded-[11px] border border-line bg-surface/90 px-2.5 py-1"
            : "px-2.5 py-1.5",
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-[6px] bg-surface-2 text-[8.5px] font-bold text-ink-soft">
          {initials(mail.name)}
        </span>
        <button
          type="button"
          onClick={() => onOpen(mail)}
          className="focus-ring min-w-0 flex-1 truncate text-left text-[11.5px] font-semibold text-ink"
        >
          {mail.subject}
        </button>
        {meta.customCategory ? (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold",
              categoryColorStyle(meta.customCategory.color).pill,
            )}
          >
            {meta.customCategory.name}
          </span>
        ) : meta.noiseTag ? (
          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] font-bold text-ink-muted">
            {meta.noiseTag}
          </span>
        ) : null}
        {!readOnly && meta.folderSuggestion ? (
          <button
            type="button"
            onClick={() => moveSummaryMail(mail, meta.folderSuggestion!.path)}
            className="focus-ring inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full border border-accent-ring/60 bg-surface px-1.5 text-[9.5px] font-bold text-accent-ink"
          >
            <FolderInput className="size-2.5" />
            Ranger dans {meta.folderSuggestion.label}
          </button>
        ) : null}
        {!readOnly ? (
          <>
            <button
              type="button"
              aria-label="Archiver"
              onClick={() => onMailAction("archive", mail)}
              className="focus-ring relative grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:bg-surface-2 hover:text-ink"
            >
              <Archive className="size-3" />
            </button>
            <button
              type="button"
              aria-label="Supprimer"
              onClick={() => onMailAction("delete", mail)}
              className="focus-ring relative grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
            >
              <Trash2 className="size-3" />
            </button>
          </>
        ) : null}
        <span className="shrink-0 text-[9.5px] font-semibold text-ink-muted tabular-nums">
          {summaryClock(mail)}
        </span>
      </div>
    );
  };

  const current = accountById(account);

  const visible = threads.filter((thread) => {
    if (filter === "unread") return thread.unread > 0;
    if (filter === "starred") return thread.starred;
    if (filter === "encrypted") return thread.encrypted > 0;
    if (filter === "all") return true;
    const dec = decisionForThread(thread);
    if (filter === "priority") {
      return !isExcludedFromPriority(dec, decisionPrefs.customCategories);
    }
    if (!dec) return false;
    if (filter === "needs_reply") {
      return dec.needsReply >= decisionPrefs.thresholds.category && !thread.primary.answered;
    }
    if (filter.startsWith("group:")) {
      const group = inboxGroup(filter.slice("group:".length));
      return Boolean(group?.tags.includes(dec.category));
    }
    if (filter.startsWith("tag:")) return dec.category === filter.slice("tag:".length);
    if (filter.startsWith("custom:")) {
      const id = filter.slice("custom:".length);
      return matchesCustomCategory(dec.category, id);
    }
    return true;
  });

  const currentIndex = useMemo(() => {
    if (openMail) {
      const index = visible.findIndex((thread) => thread.messages.some((message) => message.id === openMail.id));
      if (index >= 0) return index;
    }
    return cursor;
  }, [openMail, visible, cursor]);
  const selectedThreadId = currentIndex === null ? null : (visible[currentIndex]?.id ?? null);
  const navState = useRef({ visible, currentIndex, active, openMail });
  navState.current = { visible, currentIndex, active, openMail };

  useEffect(() => {
    setCursor(null);
  }, [filter, folder, folderPath, account]);

  useEffect(() => {
    const available = () => {
      const state = navState.current;
      return state.active && !state.openMail && state.visible.length > 0;
    };

    const selected = () => {
      const state = navState.current;
      if (state.openMail) return state.openMail;
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
      if (state.openMail) closeMessage();
    };

    const guarded = (run: (mail: Mail) => void) => {
      const mail = selected();
      if (!mail) return null;
      run(mail);
      return mail;
    };

    const move = (step: number) => {
      const state = navState.current;
      if (state.visible.length === 0) return;
      const base = state.currentIndex ?? (step > 0 ? -1 : state.visible.length);
      const index = Math.min(state.visible.length - 1, Math.max(0, base + step));
      const thread = state.visible[index];
      if (!thread) return;
      setCursor(index);
      focusRow(thread.id);
    };

    navigationRef.current = {
      canMove: available,
      canOpen: available,
      canAct: () => navState.current.active && selected() !== null,
      current: selected,
      next: () => move(1),
      previous: () => move(-1),
      open: () => {
        const state = navState.current;
        const index = state.currentIndex ?? 0;
        const thread = state.visible[index];
        if (!thread) return;
        setCursor(index);
        onOpen(thread.primary);
      },
      selectAll: () => {},
      deleteSelected: () => {
        const mail = guarded((entry) => onMailAction("delete", entry));
        if (mail) advance(threadIdOf(mail));
      },
      archiveSelected: () => {
        const mail = guarded((entry) => onMailAction("archive", entry));
        if (mail) advance(threadIdOf(mail));
      },
      toggleStarSelected: () => {
        guarded((entry) => onToggleStar(entry.id));
      },
      toggleReadSelected: () => {
        guarded((entry) => onMailAction("read", entry));
      },
      replySelected: () => {
        guarded(onReply);
      },
      forwardSelected: () => {
        if (onForward) guarded(onForward);
      },
    };

    return () => {
      navigationRef.current = null;
    };
  }, [navigationRef, onOpen, onMailAction, onToggleStar, onReply, onForward, closeMessage, focusRow]);

  useEffect(() => {
    if (wasOpen.current && !openMail && cursor !== null) focusRow(selectedThreadId);
    wasOpen.current = Boolean(openMail);
  }, [openMail, cursor, selectedThreadId, focusRow]);

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-y-auto no-scrollbar pb-32">
        <MeshGlow className="h-56" />

        <div
          className="overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{
            height: sizes.hero > 0 ? (compact ? sizes.bar + 14 : sizes.hero) : undefined,
          }}
        >
          <div
            ref={heroRef}
            className={cn(
              "origin-top px-4 pt-4 min-[380px]:px-5 transition-[opacity,transform] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]",
              compact ? "pointer-events-none scale-[0.96] opacity-0" : "scale-100 opacity-100",
            )}
          >
            <div className="flex items-start justify-between gap-1.5">
              <div className="flex min-w-0 items-center gap-2 min-[380px]:gap-2.5">
                <IconButton
                  aria-label="Ouvrir les dossiers"
                  onClick={onOpenFolders}
                  className="size-9 bg-accent-soft text-accent-ink hover:bg-accent-soft"
                >
                  <Inbox className="size-[18px]" strokeWidth={2.2} />
                </IconButton>
                <Avatar
                  name="Roman"
                  size={40}
                  rounded="rounded-full"
                  className="ring-2 ring-accent-ring ring-offset-2 ring-offset-canvas max-[379px]:hidden"
                />
                <h1
                  className={cn(
                    "min-w-0 truncate leading-[1.05] font-extrabold tracking-[-0.035em] text-ink",
                    mailDensity === "compact" ? "text-[18px]" : "text-[21px] min-[380px]:text-[24px]",
                  )}
                >
                  {reception ? (
                    <>
                      Boîte de
                      <br />
                      <AnimatedGradientText>réception</AnimatedGradientText>
                    </>
                  ) : (
                    <AnimatedGradientText>{heading}</AnimatedGradientText>
                  )}
                </h1>
              </div>
              <div className="flex shrink-0 items-center gap-0 min-[380px]:gap-1">
                <IconButton aria-label="Rechercher" onClick={onSearch} className="max-[379px]:size-10 max-[379px]:min-w-10">
                  <Search className="size-4" />
                </IconButton>
                <IconButton
                  aria-label="Affichage compact"
                  title="Affichage compact"
                  aria-pressed={mailDensity === "compact"}
                  onClick={() => setMailDensity(mailDensity === "compact" ? "cozy" : "compact")}
                  className={cn("max-[379px]:size-10 max-[379px]:min-w-10", mailDensity === "compact" && "bg-accent-soft text-accent-ink")}
                >
                  <Rows3 className="size-4" />
                </IconButton>
                <IconButton
                  aria-label={syncing ? "Synchronisation en cours" : "Synchroniser le dossier"}
                  aria-busy={syncing}
                  onClick={syncFolder}
                  disabled={syncing}
                  className="max-[379px]:size-10 max-[379px]:min-w-10"
                >
                  <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
                </IconButton>
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenAccounts}
              className={cn(
                "mt-2.5 mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface py-1 pr-2.5 pl-1",
                "text-left transition-colors hover:border-accent-ring",
              )}
            >
              <span
                className="grid size-6 place-items-center rounded-full text-[10px] font-black"
                style={{
                  backgroundColor: current?.color ?? "var(--accent)",
                  color: current ? accentContrast(current.color) : "var(--accent-contrast)",
                }}
              >
                {current ? current.label[0] : "∀"}
              </span>
              <span className="text-[11.5px] font-bold text-ink">
                {current ? current.label : "Tous les comptes"}
              </span>
              <span
                aria-hidden
                className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-bold text-accent-ink"
              >
                <NumberTicker value={unreadCount} /> non lus
              </span>
              <span className="sr-only">
                {unreadCount} conversation{unreadCount > 1 ? "s" : ""} non lue{unreadCount > 1 ? "s" : ""}
              </span>
              <ChevronDown className="size-3.5 text-ink-muted" />
            </button>
          </div>
        </div>

        {reception && (
          <>
            <div className="relative mx-5 min-h-[50px] overflow-hidden rounded-[26px] bg-accent-soft ring-1 ring-accent-ring/40">
              {active && !compact ? <BorderBeam duration={9} /> : null}

              <button
                type="button"
                onClick={collapse}
                aria-label="Réduire le résumé"
                className={cn(
                  "absolute top-2.5 right-2.5 z-10 grid size-7 place-items-center rounded-full bg-surface/80 text-accent-ink transition-opacity duration-200 before:absolute before:-inset-2 before:rounded-full before:content-['']",
                  compact ? "pointer-events-none opacity-0" : "opacity-100",
                )}
              >
                <ChevronUp className="size-3.5" />
              </button>

              {summary ? (
                <button
                  type="button"
                  onClick={() => void refreshSummary(true)}
                  disabled={summaryLoading}
                  aria-label="Régénérer le résumé"
                  className={cn(
                    "absolute top-2.5 right-11 z-10 grid size-7 place-items-center rounded-full bg-surface/80 text-accent-ink transition-opacity duration-200 before:absolute before:-inset-2 before:rounded-full before:content-['']",
                    compact ? "pointer-events-none opacity-0" : "opacity-100",
                  )}
                >
                  <RefreshCw className={cn("size-3.5", summaryLoading && "animate-spin")} />
                </button>
              ) : null}

              <div
                className={cn(
                  "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  compact ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    className={cn(
                      "p-3.5 transition-opacity duration-200",
                      compact ? "pointer-events-none opacity-0" : "opacity-100",
                    )}
                  >
                <div className="flex items-center gap-2 pr-16">
                  <span className="grid size-6 place-items-center rounded-full bg-accent/15">
                    <Sparkles
                      className={cn("size-3.5 text-accent-ink", summaryLoading && "animate-pulse")}
                      strokeWidth={2.4}
                    />
                  </span>
                  <p className="text-[10.5px] font-bold tracking-[0.14em] text-accent-ink uppercase">
                    {summary?.period.label ?? summaryLabel}
                  </p>
                  {summaryLoading ? (
                    <span
                      data-testid="summary-loading-mobile"
                      className="ml-auto inline-flex shrink-0 animate-pulse items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-accent-ink"
                    >
                      Enrichissement…
                    </span>
                  ) : null}
                  {summary ? (
                    <span
                      data-testid="summary-source-mobile"
                      className={cn(
                        "rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-accent-ink",
                        !summaryLoading && "ml-auto",
                      )}
                    >
                      {summarySourceLabel(summary.source)}
                    </span>
                  ) : null}
                </div>
                {summary ? (
                  <>
                    {showSummaryHeadline ? (
                      <p className="mt-1.5 text-[12px] leading-relaxed font-medium text-ink">
                        {summary.headline}
                      </p>
                    ) : null}
                    <div
                      data-testid="summary-attachments-mobile"
                      className="mt-2 space-y-2"
                    >
                      {!hasGroupedRows ? (
                        <p className="py-2 text-center text-[11.5px] font-medium text-ink-muted">
                          Tout a été lu sur la période.
                        </p>
                      ) : null}
                      {authRows.length > 0 ? (
                        <section>
                          <SummaryTitle label="Vérification & accès" count={authRows.length} />
                          <div className="space-y-1">
                            {authRows.map(({ ref, mail }) => {
                              const meta = summaryMetaFor(mail);
                              const copied = Boolean(copiedCodes[ref.mailId]);
                              return (
                                <article
                                  key={ref.mailId}
                                  className="flex flex-col gap-1.5 rounded-[12px] border border-accent-ring/55 bg-surface px-2.5 py-1.5"
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-accent-ring bg-accent-soft text-accent-ink">
                                      <KeyRound className="size-3" strokeWidth={2.4} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="min-w-0 truncate text-[11px] font-bold text-ink">
                                          {mail.name}
                                        </span>
                                        <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-accent-soft px-1.5 text-[9.5px] font-bold text-accent-ink">
                                          {meta.totpCode
                                            ? meta.totpService
                                              ? `Code · ${meta.totpService}`
                                              : "Code"
                                            : meta.totpService
                                              ? `Accès · ${meta.totpService}`
                                              : "Vérification"}
                                        </span>
                                        <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums">
                                          {summaryClock(mail)}
                                        </span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => onOpen(mail)}
                                        className="focus-ring mt-0.5 block max-w-full truncate text-left text-[12px] leading-[1.35] font-bold text-accent-ink underline decoration-[1.5px] underline-offset-2"
                                      >
                                        {mail.subject}
                                      </button>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
                                    {meta.totpCode ? (
                                      <>
                                        <span
                                          data-testid="summary-totp-code-mobile"
                                          className="inline-flex h-6 items-center rounded-lg border border-accent-ring/50 bg-accent-soft px-2 font-mono text-[12.5px] font-extrabold tracking-[0.14em] text-ink tabular-nums select-all"
                                        >
                                          {formatTotpCode(meta.totpCode)}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => copyTotp(ref.mailId, meta.totpCode!)}
                                          className={copied ? SUMMARY_CHIP_DONE : SUMMARY_CHIP_FILLED}
                                        >
                                          {copied ? (
                                            <Check className="size-3" strokeWidth={2.8} />
                                          ) : (
                                            <Copy className="size-3" strokeWidth={2.4} />
                                          )}
                                          {copied ? "Copié !" : "Copier"}
                                        </button>
                                      </>
                                    ) : meta.authLink ? (
                                      <button
                                        type="button"
                                        onClick={() => openExternal(meta.authLink!)}
                                        className={SUMMARY_CHIP_FILLED}
                                      >
                                        <ExternalLink className="size-3" strokeWidth={2.4} />
                                        Ouvrir le lien
                                      </button>
                                    ) : null}
                                    {!readOnly ? (
                                      <button
                                        type="button"
                                        onClick={() => onMailAction("delete", mail)}
                                        className={SUMMARY_CHIP}
                                      >
                                        <Trash2 className="size-3" strokeWidth={2.4} />
                                        Supprimer
                                      </button>
                                    ) : null}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        </section>
                      ) : null}
                      {actionRows.length > 0 ? (
                        <section>
                          <SummaryTitle label="À traiter" count={actionRows.length} />
                          <div className="space-y-1">
                            {actionRows.map(({ ref, mail }) => {
                              const due = ref.due && ISO_DAY.test(ref.due) ? ref.due : null;
                              const meta = summaryMetaFor(mail);

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
                                      "flex flex-col gap-1.5 rounded-[12px] border bg-surface px-2.5 py-1.5",
                                      meta.phishing ? "border-rose-500/35" : "border-amber-500/35",
                                    )}
                                  >
                                    <div className="flex min-w-0 items-center gap-2">
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
                                          <span className="min-w-0 truncate text-[11px] font-bold text-ink">
                                            {mail.name}
                                          </span>
                                          <span
                                            className={cn(
                                              "inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-[9.5px] font-bold",
                                              meta.phishing
                                                ? "bg-rose-500/12 text-rose-700 dark:text-rose-300"
                                                : "bg-amber-500/14 text-amber-700 dark:text-amber-300",
                                            )}
                                          >
                                            {meta.phishing ? "Suspect · Phishing" : "Injection IA"}
                                          </span>
                                          <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums">
                                            {summaryClock(mail)}
                                          </span>
                                        </div>
                                        <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                                          <button
                                            type="button"
                                            onClick={() => onOpen(mail)}
                                            className="focus-ring min-w-0 max-w-full truncate text-left text-[12px] leading-[1.35] font-bold text-accent-ink underline decoration-[1.5px] underline-offset-2"
                                          >
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
                                    {!readOnly ? (
                                      <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
                                        <button
                                          type="button"
                                          onClick={() => onMailAction("delete", mail)}
                                          className="focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-rose-600 px-2 text-[10px] font-bold text-white"
                                        >
                                          <Trash2 className="size-3" strokeWidth={2.4} />
                                          Supprimer
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => trustSender(mail.email)}
                                          className={SUMMARY_CHIP}
                                        >
                                          <ShieldCheck className="size-3" strokeWidth={2.4} />
                                          Pas suspect
                                        </button>
                                      </div>
                                    ) : null}
                                  </article>
                                );
                              }

                              if (meta.totpCode) {
                                const copied = Boolean(copiedCodes[ref.mailId]);
                                return (
                                  <article
                                    key={ref.mailId}
                                    className="flex flex-col gap-1.5 rounded-[12px] border border-accent-ring/55 bg-surface px-2.5 py-1.5"
                                  >
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-accent-ring bg-accent-soft text-accent-ink">
                                        <KeyRound className="size-3" strokeWidth={2.4} />
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                          <span className="min-w-0 truncate text-[11px] font-bold text-ink">
                                            {mail.name}
                                          </span>
                                          <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-accent-soft px-1.5 text-[9.5px] font-bold text-accent-ink">
                                            {meta.totpService ? `Code · ${meta.totpService}` : "Code"}
                                          </span>
                                          <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums">
                                            {summaryClock(mail)}
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => onOpen(mail)}
                                          className="focus-ring mt-0.5 block max-w-full truncate text-left text-[12px] leading-[1.35] font-bold text-accent-ink underline decoration-[1.5px] underline-offset-2"
                                        >
                                          {mail.subject}
                                        </button>
                                      </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
                                      <span
                                        data-testid="summary-totp-code-mobile"
                                        className="inline-flex h-6 items-center rounded-lg border border-accent-ring/50 bg-accent-soft px-2 font-mono text-[12.5px] font-extrabold tracking-[0.14em] text-ink tabular-nums select-all"
                                      >
                                        {formatTotpCode(meta.totpCode)}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => copyTotp(ref.mailId, meta.totpCode!)}
                                        className={copied ? SUMMARY_CHIP_DONE : SUMMARY_CHIP_FILLED}
                                      >
                                        {copied ? (
                                          <Check className="size-3" strokeWidth={2.8} />
                                        ) : (
                                          <Copy className="size-3" strokeWidth={2.4} />
                                        )}
                                        {copied ? "Copié !" : "Copier"}
                                      </button>
                                      {!readOnly ? (
                                        <button
                                          type="button"
                                          onClick={() => onMailAction("delete", mail)}
                                          className={SUMMARY_CHIP}
                                        >
                                          <Trash2 className="size-3" strokeWidth={2.4} />
                                          Supprimer
                                        </button>
                                      ) : null}
                                    </div>
                                  </article>
                                );
                              }

                              return (
                                <article
                                  key={ref.mailId}
                                  className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-surface px-2.5 py-1.5"
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-accent/15 text-[9.5px] font-bold text-accent-ink">
                                      {initials(mail.name)}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="min-w-0 truncate text-[11px] font-bold text-ink">
                                          {mail.name}
                                        </span>
                                        {meta.urgent ? (
                                          <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-rose-500/12 px-1.5 text-[9.5px] font-bold text-rose-700 dark:text-rose-300">
                                            Urgent
                                          </span>
                                        ) : null}
                                        {meta.customCategory ? (
                                          <span
                                            className={cn(
                                              "inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-[9.5px] font-bold",
                                              categoryColorStyle(meta.customCategory.color).pill,
                                            )}
                                          >
                                            {meta.customCategory.name}
                                          </span>
                                        ) : null}
                                        {due ? (
                                          <span
                                            className={cn(
                                              "inline-flex h-4 shrink-0 items-center rounded-md px-1.5 text-[9.5px] font-bold",
                                              SUMMARY_DUE_TONE[dueToneFor(due)],
                                            )}
                                          >
                                            {formatDueDate(due)}
                                          </span>
                                        ) : null}
                                        <span className="ml-auto shrink-0 text-[10px] font-semibold text-ink-muted tabular-nums">
                                          {summaryClock(mail)}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                                        <button
                                          type="button"
                                          onClick={() => onOpen(mail)}
                                          className="focus-ring min-w-0 max-w-full truncate text-left text-[12px] leading-[1.35] font-bold text-accent-ink underline decoration-[1.5px] underline-offset-2"
                                        >
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
                                  <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
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
                                            const rawDec = triageDecisionFor(
                                              mail,
                                              decisionIndex.byKey,
                                              decisionIndex.byMessageId,
                                            );
                                            const dec = rawDec
                                              ? applyTrustRules(rawDec, mail.email, decisionPrefs)
                                              : undefined;
                                            onPlanMail(taskDraftFromMail(mail, ref, dec));
                                            return;
                                          }
                                          const outcome = proposeSummaryAction(ref);
                                          setProposed((current) => ({ ...current, [ref.mailId]: outcome }));
                                        }}
                                        className={SUMMARY_CHIP_FILLED}
                                      >
                                        <Plus className="size-3" strokeWidth={2.8} />
                                        Planification
                                      </button>
                                    )}
                                    {meta.hasEvent ? (
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
                                              onScheduleMail(eventDraftFromMail(mail, ref));
                                              return;
                                            }
                                            const outcome = proposeSummaryEvent(ref);
                                            setProposedEvents((current) => ({
                                              ...current,
                                              [ref.mailId]: outcome,
                                            }));
                                          }}
                                          className={SUMMARY_CHIP}
                                        >
                                          + Agenda
                                        </button>
                                      )
                                    ) : null}
                                    <button
                                      type="button"
                                      onClick={() => onReply(mail)}
                                      className={SUMMARY_CHIP}
                                    >
                                      {meta.needsReply ? (
                                        <Sparkles className="size-3 text-accent-ink" strokeWidth={2.4} />
                                      ) : (
                                        <CornerUpLeft className="size-3" strokeWidth={2.4} />
                                      )}
                                      Répondre
                                    </button>
                                    {!readOnly && meta.folderSuggestion ? (
                                      <button
                                        type="button"
                                        onClick={() => moveSummaryMail(mail, meta.folderSuggestion!.path)}
                                        className={SUMMARY_CHIP}
                                      >
                                        <FolderInput className="size-3" strokeWidth={2.4} />
                                        Ranger dans {meta.folderSuggestion.label}
                                      </button>
                                    ) : null}
                                    {!readOnly ? (
                                      <div className="ml-auto flex items-center gap-0.5">
                                        <button
                                          type="button"
                                          aria-label="Archiver"
                                          onClick={() => onMailAction("archive", mail)}
                                          className="focus-ring relative grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:bg-surface-2 hover:text-ink"
                                        >
                                          <Archive className="size-3" />
                                        </button>
                                        <button
                                          type="button"
                                          aria-label="Supprimer"
                                          onClick={() => onMailAction("delete", mail)}
                                          className="focus-ring relative grid size-6 shrink-0 place-items-center rounded-full text-ink-muted transition-colors before:absolute before:-inset-2.5 before:rounded-full before:content-[''] hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
                                        >
                                          <Trash2 className="size-3" />
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        </section>
                      ) : null}

                      {infoRows.length > 0 ? (
                        <section>
                          <SummaryTitle label="Pour info" count={infoRows.length} />
                          <div className="space-y-1">{infoRows.map((row) => summaryRow(row, "card"))}</div>
                        </section>
                      ) : null}

                      {notificationRows.length > 0 ? (
                        <section>
                          <button
                            type="button"
                            onClick={() => setNotificationsOpen(!notificationsOpen)}
                            aria-expanded={notificationsOpen}
                            className="focus-ring flex w-full items-center gap-2 rounded-[11px] border border-dashed border-accent-ring bg-surface/60 px-2.5 py-1.5 text-left"
                          >
                            <span className="shrink-0 text-[10px] font-bold text-accent-ink">
                              Notifications &amp; listes · {notificationRows.length}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-ink-muted">
                              {[...new Set(notificationRows.map((row) => row.mail.name))].slice(0, 2).join(", ")}
                              {new Set(notificationRows.map((row) => row.mail.name)).size > 2 ? "…" : ""}
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
                              {notificationRows.map((row) => summaryRow(row, "list"))}
                            </div>
                          ) : null}
                        </section>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-[12.5px] leading-relaxed font-medium text-ink">
                    <span className="font-bold">
                      {unreadCount} conversation{unreadCount > 1 ? "s" : ""} non lue{unreadCount > 1 ? "s" : ""}
                    </span>{" "}
                    {mode === "api"
                      ? `dans « ${heading} ».`
                      : "dans ta boîte de réception. Camille veut un retour sur les maquettes v3 avant vendredi."}
                  </p>
                )}
                {summary ? (
                  <div
                    data-testid="summary-footer-mobile"
                    className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-ink-muted"
                  >
                    <span>{summaryLoading ? "Mise à jour…" : `Généré à ${clockOf(summary.generatedAt)}`}</span>
                  </div>
                ) : null}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={expand}
                aria-hidden={!compact}
                tabIndex={compact ? 0 : -1}
                aria-label={`Réafficher le ${(summary?.period.label ?? summaryLabel).toLowerCase()}`}
                className={cn(
                  "absolute inset-0 flex h-[50px] w-full items-center gap-2 px-4 text-left transition-opacity duration-200",
                  compact ? "opacity-100" : "pointer-events-none opacity-0",
                )}
              >
                <Sparkles className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.4} />
                <p className="truncate text-[11px] font-bold text-accent-ink">
                  {summary?.period.label ?? summaryLabel}
                </p>
                <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                  {summary ? `${summary.mailCount} mail${summary.mailCount > 1 ? "s" : ""}` : `${unreadCount} non lus`}
                </span>
                <ChevronDown className="ml-auto size-3.5 shrink-0 text-accent-ink/70" />
              </button>
            </div>
          </>
        )}

        <div className="mt-5 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar">
          <Chip active={filter === "all"} onClick={() => selectFilter("all")}>
            Tous
          </Chip>
          <Chip active={filter === "unread"} onClick={() => selectFilter("unread")}>
            Non lus
            <span
              aria-hidden
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "unread" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
              )}
            >
              {unreadCount}
            </span>
            <span className="sr-only">
              {unreadCount} conversation{unreadCount > 1 ? "s" : ""} non lue{unreadCount > 1 ? "s" : ""}
            </span>
          </Chip>
          <Chip active={filter === "starred"} onClick={() => selectFilter("starred")}>
            Étoilés
            <span
              aria-hidden
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "starred" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
              )}
            >
              {starredCount}
            </span>
            <span className="sr-only">
              {starredCount} conversation{starredCount > 1 ? "s" : ""} étoilée{starredCount > 1 ? "s" : ""}
            </span>
          </Chip>
          <Chip active={filter === "encrypted"} onClick={() => selectFilter("encrypted")}>
            Chiffrés
            <span
              aria-hidden
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "encrypted" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
              )}
            >
              {encryptedCount}
            </span>
            <span className="sr-only">
              {encryptedCount} conversation{encryptedCount > 1 ? "s" : ""} chiffrée{encryptedCount > 1 ? "s" : ""}
            </span>
          </Chip>
          {smartActive ? (
            <>
              {chipEntries.map((item) => {
                const activeChip = filter === item.id;
                return (
                  <Chip
                    key={item.id}
                    active={activeChip}
                    onClick={() => selectFilter(item.id as Filter)}
                  >
                    {item.color ? (
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          activeChip ? "bg-accent-contrast" : categoryColorStyle(item.color).dot,
                        )}
                      />
                    ) : null}
                    <span>{item.label}</span>
                    <FilterCount active={activeChip} count={item.count} />
                  </Chip>
                );
              })}
              {decisionPrefs.customCategories.map((cat) => {
                const catFilter: Filter = `custom:${cat.id}`;
                const activeChip = filter === catFilter;
                const style = categoryColorStyle(cat.color);
                const count = smartCounts.custom[cat.id] ?? 0;
                return (
                  <Chip
                    key={cat.id}
                    active={activeChip}
                    onClick={() => selectFilter(catFilter)}
                  >
                    <span className={cn("size-2 rounded-full", activeChip ? "bg-accent-contrast" : style.dot)} />
                    <span>{cat.name}</span>
                    <FilterCount active={activeChip} count={count} />
                  </Chip>
                );
              })}
              <Chip onClick={() => setCategoriesOpen(true)}>
                <Plus className="size-3.5" />
                <span>Catégorie</span>
              </Chip>
              {onOpenCleanup ? (
                <Chip onClick={onOpenCleanup}>
                  <Sparkles className="size-3.5" />
                  <span>Nettoyage</span>
                  {cleanupCount > 0 ? (
                    <span
                      aria-hidden
                      className="rounded-full bg-accent-soft px-1.5 text-[10px] font-bold text-accent-ink"
                    >
                      {cleanupCount}
                    </span>
                  ) : null}
                </Chip>
              ) : null}
            </>
          ) : null}
        </div>
        {smartActive && activeGroup ? (
          <div className="mt-1.5 flex items-center gap-2 overflow-x-auto px-5 pb-1 no-scrollbar">
            <span className="shrink-0 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
              {activeGroup.label}
            </span>
            {activeGroup.tags.map((tag) => {
              const tagFilter = `tag:${tag}` as Filter;
              const activeTag = filter === tagFilter;
              const idleTone = activeGroup.color
                ? categoryColorStyle(activeGroup.color).pill
                : "border border-line bg-surface text-ink-soft hover:text-ink";
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={activeTag}
                  onClick={() =>
                    selectFilter(activeTag ? (`group:${activeGroup.id}` as Filter) : tagFilter)
                  }
                  className={cn(
                    "focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-semibold transition-colors",
                    activeTag ? "bg-accent text-accent-contrast" : idleTone,
                  )}
                >
                  <span>{inboxTagLabel(tag)}</span>
                  <span aria-hidden className="text-[10px] font-bold tabular-nums opacity-70">
                    {smartCounts.tags[tag] ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div ref={rowsRef} className="mt-3 space-y-1 px-1 [contain:layout_style]">
          {visible.map((thread, index) => (
            <div
              key={thread.id}
              data-mail-row={thread.id}
              tabIndex={-1}
              aria-current={selectedThreadId === thread.id}
              className={cn(
                "rounded-[18px] transition-colors duration-200",
                selectedThreadId === thread.id && "bg-accent-soft ring-1 ring-accent-ring",
              )}
            >
              <ThreadRow
                thread={thread}
                delay={Math.min(0.4, 0.16 + index * 0.05)}
                showAccount={account === ALL_ACCOUNTS}
                density={mailDensity}
                preview={mailPreview}
                previewStyle={mailPreviewStyle}
                decisionPending={decisionPendingFor(thread)}
                decision={decisionForThread(thread)}
                decisionThresholds={decisionPrefs.thresholds}
                customCategories={decisionPrefs.customCategories}
                onOpen={() => onOpen(thread.primary)}
                onToggleStar={() => onToggleStar(thread.primary.id)}
                onDelete={() => onMailAction("delete", thread.primary)}
                onArchive={() => onMailAction("archive", thread.primary)}
                onToggleRead={() => onMailAction("read", thread.primary)}
                onReply={() => onReply(thread.primary)}
                onNotSpam={onNotSpam ? () => onNotSpam(thread.primary) : undefined}
                onRestore={onRestore ? () => onRestore(thread.primary) : undefined}
                onLongPress={onOpenMenu ? () => onOpenMenu(thread.primary) : undefined}
              />
            </div>
          ))}
          {threadsLoading && visible.length === 0 && (
            <div className="flex items-center justify-center gap-2 px-6 py-10 text-[12px] font-semibold text-ink-muted">
              <Loader2 className="size-4 animate-spin" />
              Chargement des messages…
            </div>
          )}
          {visible.length === 0 && !threadsLoading && (
            <div className="px-6 py-6 text-center">
              <p className="text-[13px] font-bold text-ink">Aucun message</p>
              <p className="mt-1 text-[11.5px] leading-relaxed font-medium text-ink-muted">
                {filter !== "all"
                  ? "Aucune conversation ne correspond à ce filtre."
                  : mode === "api"
                    ? "Ce dossier est vide. Lance une synchronisation pour récupérer les messages du serveur."
                    : "Rien ici pour le moment."}
              </p>
              {filter !== "all" && (
                <button
                  type="button"
                  onClick={() => selectFilter("all")}
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
                >
                  <RotateCcw className="size-3.5" />
                  Réinitialiser le filtre
                </button>
              )}
              {filter === "all" && mode === "api" && (
                <button
                  type="button"
                  onClick={syncFolder}
                  disabled={syncing}
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-[12px] font-bold text-accent-contrast transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                  Synchroniser
                </button>
              )}
            </div>
          )}
          {mode === "api" && hasMore && !threadsLoading && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                onClick={loadMore}
                className="focus-ring inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-3.5 py-2 text-[12px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
              >
                Charger plus
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        ref={barRef}
        className={cn(
          "absolute inset-x-0 top-0 z-30 will-change-transform transition-[opacity,transform] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]",
          compact ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-3.5 opacity-0",
        )}
      >
        <div className="glass flex items-center gap-1.5 border-b border-line/70 px-3 pt-2.5 pb-2 min-[380px]:gap-2 min-[380px]:px-4">
          <IconButton
            aria-label="Ouvrir les dossiers"
            onClick={onOpenFolders}
            className="bg-accent-soft text-accent-ink hover:bg-accent-soft max-[379px]:size-10 max-[379px]:min-w-10"
          >
            <Inbox className="size-[18px]" strokeWidth={2.2} />
          </IconButton>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[12.5px] font-bold text-ink">{heading}</p>
            <p className="truncate text-[10.5px] font-semibold text-ink-muted">
              {threads.length} conv. · {unreadCount} non lues
              {folderStats("spam").unread > 0 ? ` · ${folderStats("spam").unread} spam` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <IconButton aria-label="Rechercher" onClick={onSearch} className="size-10 min-w-10">
              <Search className="size-4" />
            </IconButton>
            <IconButton
              aria-label={syncing ? "Synchronisation en cours" : "Synchroniser le dossier"}
              aria-busy={syncing}
              onClick={syncFolder}
              disabled={syncing}
              className="size-10 min-w-10"
            >
              <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
            </IconButton>
            <IconButton
              aria-label="Affichage compact"
              title="Affichage compact"
              aria-pressed={mailDensity === "compact"}
              onClick={() => setMailDensity(mailDensity === "compact" ? "cozy" : "compact")}
              className={cn("size-10 min-w-10", mailDensity === "compact" && "bg-accent-soft text-accent-ink")}
            >
              <Rows3 className="size-4" />
            </IconButton>
            <IconButton aria-label="Changer de compte" onClick={onOpenAccounts} className="size-10 min-w-10">
              <span
                className="grid size-5 place-items-center rounded-full text-[10px] font-black"
                style={{
                  backgroundColor: current?.color ?? "var(--accent)",
                  color: current ? accentContrast(current.color) : "var(--accent-contrast)",
                }}
              >
                {current ? current.label[0] : "∀"}
              </span>
            </IconButton>
          </div>
        </div>
      </div>

      <CategoryManagerSheet
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        onRetriage={() => triageMails(mails, true)}
      />
    </div>
  );
}

export function AccountSwitchSheet({
  active,
  onSelect,
  onClose,
}: {
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { mailAccounts, readOnly, openConnect, accountUnread } = useMailStore();
  const rows = [
    ...(mailAccounts.length > 1
      ? [
          {
            id: ALL_ACCOUNTS,
            label: "Tous les comptes",
            email: "Boîte unifiée",
            color: "var(--accent)",
            glyph: "∀",
          },
        ]
      : []),
    ...mailAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      email: account.email,
      color: account.color,
      glyph: account.label[0] ?? "?",
    })),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-baseline justify-between px-5 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Comptes</h2>
        <button type="button" onClick={onClose} className="text-[11.5px] font-bold text-accent-ink">
          Fermer
        </button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto no-scrollbar px-3 pb-4">
        {rows.map((row) => {
          const isActive = row.id === active;
          const unread = accountUnread(row.id);
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                onSelect(row.id);
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
                isActive ? "bg-accent-soft ring-1 ring-accent-ring/60" : "hover:bg-surface-2",
              )}
            >
              <span
                className="grid size-9 shrink-0 place-items-center rounded-xl text-[12px] font-black"
                style={{ backgroundColor: row.color, color: accentContrast(row.color) }}
              >
                {row.glyph}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-bold text-ink">{row.label}</span>
                <span className="block truncate text-[11px] font-medium text-ink-muted">{row.email}</span>
              </span>
              {unread > 0 && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-bold text-accent-contrast">
                  {unread}
                </span>
              )}
            </button>
          );
        })}

        {readOnly ? null : (
          <button
            type="button"
            onClick={() => {
              onClose();
              openConnect();
            }}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-[12.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
          >
            <Plus className="size-4" />
            Ajouter un compte
          </button>
        )}
      </div>
    </div>
  );
}

const FOLDER_ICONS = {
  inbox: Inbox,
  unified: Layers,
  sent: Send,
  drafts: PenLine,
  archive: Archive,
  spam: ShieldAlert,
  trash: Trash2,
  other: Inbox,
} as const;

function SheetFolderRow({
  path,
  icon: Icon,
  label,
  total,
  unread = 0,
  active = false,
  depth = 0,
  expanded,
  onToggle,
  onSelect,
  reorder = false,
  onMoveUp,
  onMoveDown,
}: {
  path: string;
  icon: LucideIcon;
  label: string;
  total?: number;
  unread?: number;
  active?: boolean;
  depth?: number;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  reorder?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const row = onSelect ? (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
        active ? "bg-accent-soft ring-1 ring-accent-ring/60" : "hover:bg-surface-2",
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-xl",
          active ? "bg-surface text-accent-ink" : "bg-surface-2 text-ink-soft",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{label}</span>
      {total === undefined ? null : (
        <span className="shrink-0 text-[10.5px] font-semibold text-ink-muted">{total}</span>
      )}
      {unread > 0 && (
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-bold text-accent-contrast">
          {unread}
        </span>
      )}
    </button>
  ) : (
    <span className="block truncate rounded-2xl px-3 py-2.5 text-[13px] font-bold text-ink-muted">
      {label}
    </span>
  );

  return (
    <div
      data-folder-row={path}
      className="flex items-center"
      style={depth ? { paddingLeft: depth * 18 } : undefined}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Replier" : "Déplier"} ${label}`}
          className="focus-ring grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
          />
        </button>
      ) : depth ? (
        <span className="size-8 shrink-0" />
      ) : null}
      <div className="min-w-0 flex-1">{row}</div>
      {reorder ? (
        <div className="flex shrink-0 items-center">
          <MoveButton label={`Monter ${label}`} onClick={onMoveUp} icon={ChevronUp} />
          <MoveButton label={`Descendre ${label}`} onClick={onMoveDown} icon={ChevronDown} />
        </div>
      ) : null}
    </div>
  );
}

function MoveButton({
  label,
  onClick,
  icon: Icon,
}: {
  label: string;
  onClick?: () => void;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick}
      className="focus-ring grid size-10 place-items-center rounded-xl text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <Icon className="size-4" />
    </button>
  );
}

export function MailboxSheet({
  folder,
  onSelect,
  onClose,
}: {
  folder: FolderId;
  onSelect: (id: FolderId, path: string | null) => void;
  onClose: () => void;
}) {
  const {
    account,
    mode,
    readOnly,
    folderOptions,
    folderPath,
    emptyTrash,
    folderStats,
    hiddenFolderOptions,
    folderOrder,
    setFolderOrder,
  } = useMailStore();
  const trashCount = folderStats("trash").total;
  const [reordering, setReordering] = useState(false);
  const reorderable = mode === "api" && account !== ALL_ACCOUNTS && !readOnly;
  const rows = useFolderTree(folderOptions, folderOrder);

  const siblingsAt = (depth: number, parentPath: string | null) =>
    rows
      .filter((row) => row.depth === depth && row.parentPath === parentPath)
      .map((row) => row.node.path);

  const move = (path: string, depth: number, parentPath: string | null, offset: -1 | 1) => {
    const siblings = siblingsAt(depth, parentPath);
    const target = siblings[siblings.indexOf(path) + offset];
    if (!target) return;
    setFolderOrder(moveFolderPath(folderOrder, siblings, path, target, offset > 0));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-baseline justify-between px-5 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Dossiers</h2>
        <div className="flex items-center gap-3">
          {reorderable ? (
            <button
              type="button"
              onClick={() => setReordering((value) => !value)}
              aria-pressed={reordering}
              className="text-[11.5px] font-bold text-ink-muted transition-colors hover:text-ink"
            >
              {reordering ? "Terminé" : "Réordonner"}
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="text-[11.5px] font-bold text-accent-ink">
            Fermer
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto no-scrollbar px-3 pb-4">
        {rows.map((row) => {
          const entry = row.node.item;
          const stats = entry ? folderStats(entry.id, entry.path) : null;
          const siblings = reordering ? siblingsAt(row.depth, row.parentPath) : [];
          const index = siblings.indexOf(row.node.path);
          return (
            <SheetFolderRow
              key={row.node.path}
              path={row.node.path}
              icon={entry ? FOLDER_ICONS[entry.id] : FOLDER_ICONS.other}
              label={entry?.label ?? row.node.name}
              total={stats?.total}
              unread={stats?.unread ?? 0}
              active={
                entry !== null &&
                folder === entry.id &&
                (entry.id !== "other" || row.node.path === folderPath)
              }
              depth={row.depth}
              expanded={row.expanded}
              onToggle={row.hasChildren ? row.toggle : undefined}
              onSelect={
                entry
                  ? () => {
                      onSelect(entry.id, entry.id === "other" ? entry.path : null);
                      onClose();
                    }
                  : undefined
              }
              reorder={reordering}
              onMoveUp={
                entry && index > 0
                  ? () => move(row.node.path, row.depth, row.parentPath, -1)
                  : undefined
              }
              onMoveDown={
                entry && index >= 0 && index < siblings.length - 1
                  ? () => move(row.node.path, row.depth, row.parentPath, 1)
                  : undefined
              }
            />
          );
        })}

        <HiddenFoldersRail count={hiddenFolderOptions.length} variant="mobile">
          {hiddenFolderOptions.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => {
                onSelect("other", entry.path);
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-ink-soft transition-colors hover:bg-surface-2"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
                <FOLDER_ICONS.other className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{entry.label}</span>
            </button>
          ))}
        </HiddenFoldersRail>

        {trashCount > 0 && (
          <div className="pt-1">
            <EmptyTrashButton count={trashCount} onConfirm={emptyTrash} variant="mobile" />
          </div>
        )}
      </div>
    </div>
  );
}
