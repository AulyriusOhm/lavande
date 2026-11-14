import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerUpLeft,
  CornerUpRight,
  Download,
  Forward,
  Inbox,
  Loader2,
  Lock,
  Mail as MailIcon,
  MailOpen,
  Moon,
  Paperclip,
  PenLine,
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
import type { SummaryResult } from "@/lib/summary";
import { downloadAttachment } from "@/lib/attachments";
import type { Thread } from "@/lib/threads";
import { threadsInFolder } from "@/lib/threads";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import { PGP_STATE, formatKeyDate, keyLabel, keyState, shortFingerprint, type PgpKey } from "@/lib/pgp";
import { listKeys } from "@/lib/pgp-api";
import { useMailStore } from "@/lib/store";
import { resolvePgp, usePrefs } from "@/lib/prefs";
import type { MailNavigation } from "@/lib/app-shortcuts";
import { useEscapeLayer } from "@/desktop/escape";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { BorderBeam } from "@/components/ui/border-beam";
import { NumberTicker } from "@/components/ui/number-ticker";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { MailBody, MailBodyLoading } from "@/components/mail-body";
import { EmptyTrashButton } from "@/components/empty-trash";
import { FolderRow, HiddenFoldersRail } from "@/components/folder-row";
import { useFolderTree } from "@/components/folder-tree";
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

const SUMMARY_FILE_CHIPS = 4;

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

const SUMMARY_ACTIONS: { label: string; hint: string; icon: LucideIcon; target: string }[] = [
  { label: "Répondre à Camille", hint: "Maquettes mobiles — version 3", icon: CornerUpLeft, target: "1" },
  { label: "Valider la v3", hint: "avant vendredi", icon: CheckCircle2, target: "1" },
  { label: "Relancer Marc", hint: "accès serveur", icon: BellRing, target: "3" },
];

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

function MorningSummary({
  open,
  unread,
  attachments,
  encrypted,
  demo,
  summary,
  files,
  loading,
  onToggle,
  onOpen,
  onRefresh,
}: {
  open: boolean;
  unread: number;
  attachments: number;
  encrypted: number;
  demo: boolean;
  summary: SummaryResult | null;
  files: MailAttachment[];
  loading: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const label = summary?.period.label ?? "Résumé du matin";
  const source = summary ? (summary.source === "llm" ? "IA" : "local") : null;

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
          <p className="mt-1 text-[12.5px] leading-[1.55] font-medium text-ink-soft">{summary.text}</p>
        ) : (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.55] font-medium text-ink-soft">
            <span className="font-bold text-ink">{unread} conversations non lues</span>, {attachments} avec des pièces
            jointes, {encrypted} chiffrées.
            {demo ? " Camille attend un retour sur la v3 avant vendredi." : ""}
          </p>
        )}

        {files.length > 0 ? (
          <div data-testid="summary-attachments" className="mt-2 flex flex-wrap items-center gap-1.5">
            {files.slice(0, SUMMARY_FILE_CHIPS).map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                title={`${file.name} · ${file.size}`}
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-accent-ring/50 bg-surface/80 px-2 py-0.5 text-[10.5px] font-bold text-ink-soft"
              >
                <Paperclip className="size-2.5 shrink-0 text-accent-ink" strokeWidth={2.6} />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 font-semibold text-ink-muted">{file.size}</span>
              </span>
            ))}
            {files.length > SUMMARY_FILE_CHIPS ? (
              <span className="rounded-full bg-surface/80 px-2 py-0.5 text-[10.5px] font-bold text-ink-muted tabular-nums">
                +{files.length - SUMMARY_FILE_CHIPS}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {demo ? (
        <div className="relative divide-y divide-accent-ring/20 border-t border-accent-ring/20">
          {SUMMARY_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onOpen(action.target)}
              aria-label={`${action.label} — ${action.hint}`}
              className="focus-ring flex h-9 w-full items-center gap-2.5 px-4 text-left transition-colors duration-200 hover:bg-surface/70"
            >
              <action.icon className="size-4 shrink-0 text-accent-ink" strokeWidth={2.4} />
              <span className="shrink-0 text-[12px] font-bold text-ink">{action.label}</span>
              <span className="truncate text-[11px] font-semibold text-ink-muted">{action.hint}</span>
              <ChevronRight className="ml-auto size-3.5 shrink-0 text-ink-muted" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThreadRow({
  thread,
  selected,
  delay,
  onOpen,
  onStar,
  onRead,
  onArchive,
  onDelete,
  onRestore,
  onNotSpam,
}: {
  thread: Thread;
  selected: boolean;
  delay: number;
  onOpen: () => void;
  onStar: () => void;
  onRead: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onNotSpam: () => void;
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
          "group relative rounded-[16px] transition-colors duration-200",
          selected ? "bg-accent-soft ring-1 ring-accent-ring" : "hover:bg-surface-2",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-current={selected}
          data-mail-row={thread.id}
          aria-label={`${name} — ${thread.subject}${thread.count > 1 ? ` · ${thread.count} messages` : ""}${
            unread ? " · non lu" : ""
          }`}
          className="focus-row absolute inset-0 rounded-[16px]"
        />

        <div className="pointer-events-none relative flex gap-3 px-3 py-3.5">
          <Avatar name={name} tone={mail.tone} size={40} rounded="rounded-full" />

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
    moveToInbox,
    restoreMail,
    emptyTrash,
    openMessage,
    closeMessage,
    replyTo,
    forwardMail,
    resumeDraft,
    folderStats,
    accountUnread,
    summary,
    summaryLoading,
    summaryMails,
    refreshSummary,
    bodyFetching,
    hiddenFolderOptions,
    hideFolder,
    unhideFolder,
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
  const tier = useInboxTier();
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<"reader" | "list" | null>(null);

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


  const runDownload = async (mail: Mail, file: MailAttachment) => {
    const key = `${mail.id}:${file.name}`;
    setDownloading(key);
    setDownloadNotice(`Téléchargement de « ${file.name} »…`);
    setDownloadNotice(await downloadAttachment(mail, file));
    setDownloading(null);
  };

  const threads = threadsInFolder(mails, folder, account);
  const roleOptions = useMemo(
    () => folderOptions.filter((entry) => entry.id !== "other"),
    [folderOptions],
  );
  const customOptions = useMemo(
    () => folderOptions.filter((entry) => entry.id === "other"),
    [folderOptions],
  );
  const customRows = useFolderTree(customOptions);
  const heading =
    folderOptions.find((entry) => entry.id === folder && entry.path === folderPath)?.label ??
    folderLabel(folder);
  const visible = threads.filter(FILTER_MATCH[filter]);
  const unreadThreads = threads.filter((thread) => thread.unread > 0).length;
  const attachmentThreads = threads.filter((thread) => thread.attachments > 0).length;
  const summaryFiles = summaryMails.flatMap((mail) => mail.attachments ?? []);
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
  }, [filter, folder, folderPath, account]);

  useEscapeLayer(Boolean(mail), () => {
    setCursor(currentIndex);
    pendingFocus.current = "list";
    closeMessage();
  });

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
      deleteSelected: () => {
        const mail = guarded((entry) => mailAction("delete", entry));
        if (mail) advance(threadIdOf(mail));
      },
      archiveSelected: () => {
        const mail = guarded((entry) => mailAction("archive", entry));
        if (mail) advance(threadIdOf(mail));
      },
      toggleStarSelected: () => {
        guarded((entry) => toggleStar(entry.id));
      },
      toggleReadSelected: () => {
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
  }, [navigationRef, openMessage, closeMessage, mailAction, toggleStar, replyTo, forwardMail, focusRow, listFocused]);

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

  const readerActions: QuickAction[] = mail
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
        className={cn(
          "relative grid h-full min-h-0",
          tier === "wide" && "grid-cols-[248px_420px_minmax(0,1fr)]",
          tier === "medium" && "grid-cols-[minmax(0,360px)_minmax(0,1fr)]",
          tier === "narrow" && "grid-cols-[minmax(0,1fr)]",
        )}
        data-testid="desktop-inbox"
        data-tier={tier}
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
                {roleOptions.map((entry) => {
                  const Icon = FOLDER_ICONS[entry.id];
                  const stats = folderStats(entry.id, entry.path);
                  const count =
                    entry.id === "sent"
                      ? 0
                      : entry.id === "drafts" || entry.id === "trash"
                        ? stats.total
                        : stats.unread;
                  return (
                    <RailItem
                      key={`${entry.id}:${entry.path}`}
                      active={folder === entry.id}
                      onClick={() => setFolder(entry.id, null)}
                      label={entry.label}
                      count={count}
                      icon={<Icon className="size-4" />}
                    />
                  );
                })}
                {customRows.map((row) => {
                  const entry = row.node.item;
                  const label = entry?.label ?? row.node.name;
                  const rail = (
                    <RailItem
                      active={entry !== null && folder === "other" && row.node.path === folderPath}
                      onClick={entry ? () => setFolder("other", entry.path) : undefined}
                      label={label}
                      count={entry ? folderStats("other", entry.path).unread : 0}
                      icon={<FOLDER_ICONS.other className="size-4" />}
                      depth={row.depth}
                      expanded={row.expanded}
                      onToggle={row.hasChildren ? row.toggle : undefined}
                    />
                  );
                  return entry ? (
                    <FolderRow
                      key={row.node.path}
                      label={label}
                      onHide={account === ALL_ACCOUNTS ? undefined : () => hideFolder(entry.path)}
                    >
                      {rail}
                    </FolderRow>
                  ) : (
                    <div key={row.node.path}>{rail}</div>
                  );
                })}
                <HiddenFoldersRail count={hiddenFolderOptions.length}>
                  {hiddenFolderOptions.map((entry) => (
                    <FolderRow
                      key={entry.path}
                      label={entry.label}
                      onUnhide={() => unhideFolder(entry.path)}
                    >
                      <RailItem
                        active={folder === "other" && folderPath === entry.path}
                        onClick={() => setFolder("other", entry.path)}
                        label={entry.label}
                        count={folderStats("other", entry.path).unread}
                        icon={<FOLDER_ICONS.other className="size-4" />}
                      />
                    </FolderRow>
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

        <section className="flex min-h-0 flex-col border-r border-line">
          <div className="shrink-0 px-4 pt-4 pb-2">
            <div className="flex items-center gap-2">
              <PaneTitle
                hint={
                  folder === "inbox" ? (
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

          {folder === "inbox" ? (
            <div className="shrink-0 px-4">
              <MorningSummary
                open={summaryOpen}
                unread={unreadThreads}
                attachments={attachmentThreads}
                encrypted={encryptedThreads}
                demo={mode === "demo"}
                summary={summary}
                files={summaryFiles}
                loading={summaryLoading}
                onToggle={() => setSummaryOpen(!summaryOpen)}
                onOpen={openById}
                onRefresh={() => void refreshSummary(true)}
              />
            </div>
          ) : null}

          <div ref={listRef} className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-[104px]">
            {visible.map((thread, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={selectedThreadId === thread.id}
                delay={Math.min(0.4, 0.06 + index * 0.04)}
                onOpen={() => openMessage(thread.primary)}
                onStar={() => toggleStar(thread.primary.id)}
                onRead={() => mailAction("read", thread.primary)}
                onArchive={() => mailAction("archive", thread.primary)}
                onDelete={() => mailAction("delete", thread.primary)}
                onRestore={() => restoreMail(thread.primary)}
                onNotSpam={() => moveToInbox(thread.primary)}
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
        </section>

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
                  {mail.folder === "drafts" ? (
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
                    </>
                  )}
                </div>
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
                        {mail.folder === "sent" ? `à ${mail.to ?? "destinataire"}` : mail.email} ·{" "}
                        {mail.date ?? mail.time}
                      </p>
                    </div>
                  </div>

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
                                  {message.body.map((paragraph, index) => (
                                    <p
                                      key={index}
                                      className="text-[13.5px] leading-[1.7] font-medium whitespace-pre-line text-ink-soft"
                                    >
                                      {paragraph}
                                    </p>
                                  ))}
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
      </div>
    </>
  );
}
