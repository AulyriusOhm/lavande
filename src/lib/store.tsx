import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComposeDraft, DraftAttachment } from "@/lib/draft";
import {
  MAX_ATTACHMENT_BYTES,
  base64Size,
  baseDraft,
  emptyDraft,
  firstRecipient,
  formatBytes,
  insertAt,
  mimeOf,
  persistedDraft,
  readBase64,
} from "@/lib/draft";
import { buildQuotedHtml, htmlToText, splitQuotedBody, textToHtml } from "@/lib/rich-text";
import { notifyNewMail, setUnreadBadge } from "@/lib/notify";
import type { NoticeData } from "@/components/ui/notice";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import type { Account } from "@/lib/accounts";
import { MAILS, folderLabel, mailMatches, normalize } from "@/lib/mail";
import type { FolderId, Mail, MailSource } from "@/lib/mail";
import { threadOf } from "@/lib/threads";
import type { Thread } from "@/lib/threads";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { dueToneFor, formatDueDate } from "@/lib/tasks";
import {
  currentPeriod,
  generateSummary,
  readSummaryCache,
  recentMails,
  summaryScope,
  summarySignature,
  suggestEvents,
  suggestTasks,
  writeSummaryCache,
} from "@/lib/summary";
import type { SummaryEvent, SummaryMailInput, SummaryResult, SummaryTask } from "@/lib/summary";
import { llmReady } from "@/lib/llm";
import { TODAY_ISO } from "@/lib/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import {
  activeSignature,
  isFolderHidden,
  notificationsForAccount,
  perimeterOf,
  resolvePgp,
  usePrefs,
} from "@/lib/prefs";
import { suggestionsInWindow, usePlanning } from "@/lib/planning-store";
import { mailApi, errorText } from "@/lib/api";
import type { LiveEvent } from "@/lib/api";
import type { NewAccount } from "@/lib/api";
import {
  folderOptions as optionsOf,
  folderOptionsForAll,
  folderPathOf,
  folderTargets,
  loadMailbox,
  mailMode,
  messageToMail,
  sendInputOf,
  setAccountDecryptPolicy,
  syncNotice,
  threadToMails,
} from "@/lib/mail-backend";
import type { FolderOption, FolderRecord, MailMode } from "@/lib/mail-backend";
import {
  isComposeWindow,
  loadPersistedCompose,
  openComposeBus,
  persistCompose,
} from "@/lib/compose-bus";
import type { ComposeBus, ComposeState } from "@/lib/compose-bus";

export type BackendPhase = "loading" | "ready" | "offline" | "empty";

const PAGE_SIZE = 50;
const SUMMARY_TICK_MS = 5 * 60_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Stockage du cache de résumé : absent (SSR, stockage bloqué) = pas de cache. */
function summaryStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Une tâche proposée par le résumé devient une suggestion EN ATTENTE, jamais une tâche. */
function summarySuggestion(task: SummaryTask, mail: Mail | undefined, period: string): MailSuggestion {
  const day = ISO_DAY.test(task.due) ? task.due : "";
  const suggestion: MailSuggestion = {
    id: `summary:${task.mailId ?? "sans-mail"}:${normalize(task.title)}`,
    mailId: task.mailId ?? "",
    account: mail?.account ?? "",
    ai: true,
    from: task.from || mail?.name || "Résumé",
    subject: mail?.subject ?? "",
    proposal: task.title,
    due: day ? formatDueDate(day) : "",
    dueTone: day ? dueToneFor(day) : "none",
    tone: mail?.tone ?? 0,
    description: day ? `${period} · échéance ${formatDueDate(day)}` : period,
  };
  if (typeof mail?.timestamp === "number") suggestion.timestamp = mail.timestamp;
  return suggestion;
}

/** Un rendez-vous extrait devient une suggestion d'AGENDA en attente, jamais un événement. */
function eventSuggestion(event: SummaryEvent, mail: Mail | undefined, label: string): MailSuggestion {
  const day = ISO_DAY.test(event.date) ? event.date : "";
  const hours = event.start ? (event.end ? `${event.start}–${event.end}` : event.start) : "";
  const when = [day ? formatDueDate(day) : "", hours].filter(Boolean).join(" ");
  const suggestion: MailSuggestion = {
    id: `event:${event.mailId ?? "sans-mail"}:${event.date}:${normalize(event.title)}`,
    kind: "event",
    mailId: event.mailId ?? "",
    account: mail?.account ?? "",
    ai: true,
    from: event.from || mail?.name || "Résumé",
    subject: mail?.subject ?? "",
    proposal: event.title,
    due: day ? formatDueDate(day) : "",
    dueTone: day ? dueToneFor(day) : "none",
    tone: mail?.tone ?? 0,
    description: [label, when, event.location].filter(Boolean).join(" · "),
    date: event.date,
    start: event.start,
    end: event.end,
  };
  if (event.location) suggestion.location = event.location;
  if (typeof mail?.timestamp === "number") suggestion.timestamp = mail.timestamp;
  return suggestion;
}

export type MailStoreValue = {
  mails: Mail[];
  account: string;
  accountById: (id: string) => Account | undefined;
  accounts: Account[];
  folder: FolderId;
  folderPath: string | null;
  folderOptions: FolderOption[];
  mode: MailMode;
  phase: BackendPhase;
  backendError: string | null;
  threadsLoading: boolean;
  pages: number;
  hasMore: boolean;
  syncing: boolean;
  folderStats: (id: FolderId, path?: string) => { total: number; unread: number };
  accountUnread: (accountId: string) => number;
  connectOpen: boolean;
  removeTarget: Account | null;
  tasks: Task[];
  suggestions: MailSuggestion[];
  summary: SummaryResult | null;
  summaryLoading: boolean;
  /** Mails analysés par le résumé en cours, retrouvés dans la liste vivante. */
  summaryMails: Mail[];
  refreshSummary: (force?: boolean) => Promise<void>;
  events: CalendarEvent[];
  selectedDate: string;
  openMail: Mail | null;
  openThread: Thread | undefined;
  /** Message dont le corps est en cours de lecture sur le serveur. */
  bodyFetching: string | null;
  notices: NoticeData[];
  composeOpen: boolean;
  composeDraft: ComposeDraft | null;
  composeTitle: string;
  composeDetached: boolean;
  /** Brouillon serveur repris, tant qu'il n'a pas été réenregistré ou envoyé. */
  draftSource: MailSource | null;
  setAccount: (value: string) => void;
  setFolder: (value: FolderId, path?: string | null) => void;
  loadMore: () => void;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setEvents: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  setSelectedDate: (value: string) => void;
  setComposeDraft: (value: ComposeDraft | null) => void;
  setComposeTitle: (value: string) => void;
  notify: (message: string, action?: { label: string; run: () => void }) => void;
  dismissNotice: () => void;
  toggleStar: (id: string) => void;
  mailAction: (kind: "delete" | "archive" | "read", mail: Mail) => void;
  moveToInbox: (mail: Mail) => void;
  restoreMail: (mail: Mail) => void;
  emptyTrash: () => void;
  addSuggestion: (suggestion: MailSuggestion) => void;
  dismissSuggestion: (suggestion: MailSuggestion) => void;
  openMessage: (mail: Mail | string) => void;
  closeMessage: () => void;
  startBlankDraft: () => void;
  resumeDraft: (mail: Mail) => void;
  openComposer: () => void;
  resumeCompose: () => void;
  minimizeCompose: () => void;
  closeCompose: () => void;
  saveToDrafts: (draft: ComposeDraft) => Promise<boolean>;
  detachCompose: () => void;
  dockCompose: () => void;
  detachClosed: () => void;
  replyTo: (mail: Mail) => void;
  forwardMail: (mail: Mail) => void;
  sendDraft: (draft: ComposeDraft) => void;
  retryBackend: () => void;
  refreshMailbox: () => Promise<void>;
  useDemo: () => void;
  syncFolder: () => void;
  searchMails: (query: string) => Promise<Mail[]>;
  openConnect: () => void;
  closeConnect: () => void;
  createAccount: (input: NewAccount) => Promise<string>;
  renameAccount: (id: string, label: string) => Promise<void>;
  askRemoveAccount: (account: Account) => void;
  cancelRemoveAccount: () => void;
  confirmRemoveAccount: () => void;
  deleteFolder: (path: string, label: string, accountId?: string) => Promise<boolean>;
  /** Dossiers masqués du compte courant, avec leur libellé pour les réafficher. */
  hiddenFolderOptions: FolderOption[];
  hideFolder: (path: string) => void;
  unhideFolder: (path: string) => void;
};

const MailStoreContext = createContext<MailStoreValue | null>(null);

export function MailStoreProvider({ children }: { children: React.ReactNode }) {
  const prefs = usePrefs();
  const pgpPrefs = useMemo(
    () => ({ pgpEncrypt: prefs.pgpEncrypt, pgpSign: prefs.pgpSign, pgpAccounts: prefs.pgpAccounts }),
    [prefs.pgpEncrypt, prefs.pgpSign, prefs.pgpAccounts],
  );
  // Interrupteurs de synchronisation : le maître coupe tous les domaines.
  const mailSyncOn = prefs.sync.enabled && prefs.sync.mails;
  /** Périmètre du compte : hors mails, sa boîte n'est plus relevée du tout. */
  const mailsInPerimeter = useCallback(
    (accountId: string | undefined) =>
      !accountId || perimeterOf(prefs.perimeters, accountId).mails,
    [prefs.perimeters],
  );
  const planning = usePlanning();
  const { tasks, suggestions: storedSuggestions, setTasks, events, setEvents } = planning;
  const [mode, setMode] = useState<MailMode>(mailMode);
  const [phase, setPhase] = useState<BackendPhase>(() => (mode === "demo" ? "ready" : "loading"));
  const [backendError, setBackendError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>(() => (mode === "demo" ? ACCOUNTS : []));
  const [folderRecords, setFolderRecords] = useState<FolderRecord[]>([]);
  const [mails, setMails] = useState<Mail[]>(() => (mode === "demo" ? MAILS : []));
  const [account, setAccountState] = useState<string>(() => (mode === "demo" ? ALL_ACCOUNTS : ""));
  const [folder, setFolderState] = useState<FolderId>("inbox");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [pages, setPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [folderCounts, setFolderCounts] = useState<Record<string, { total: number; unread: number }>>({});
  const [revision, setRevision] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null);
  const [selectedDate, setSelectedDate] = useState(TODAY_ISO);
  const [openMail, setOpenMail] = useState<Mail | null>(null);
  const [bodyFetching, setBodyFetching] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Mail[]>([]);
  const [notices, setNotices] = useState<NoticeData[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [persistedCompose] = useState(loadPersistedCompose);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(
    persistedCompose?.draft ?? null,
  );
  const [composeTitle, setComposeTitle] = useState(persistedCompose?.title ?? "Nouveau message");
  const [composeDetached, setComposeDetached] = useState(false);
  const [draftSource, setDraftSource] = useState<MailSource | null>(
    persistedCompose?.draftSource ?? null,
  );
  const resumedDraftId = useRef<string | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const summaryRun = useRef<string | null>(null);
  const summaryRunning = useRef(false);
  const taskRun = useRef<string | null>(null);
  const taskRunning = useRef(false);
  const eventRun = useRef<string | null>(null);
  const eventRunning = useRef(false);
  const composeBus = useRef<ComposeBus | null>(null);
  const composeStateRef = useRef<ComposeState>({ draft: null, title: "Nouveau message", detached: false });
  const lastPostedCompose = useRef("");
  const sendDraftRef = useRef<(draft: ComposeDraft) => void>(() => {});
  const resumeDraftRef = useRef<(mail: Mail) => void>(() => {});
  const noticeId = useRef(0);

  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    noticeId.current += 1;
    const entry = { id: noticeId.current, message, actionLabel: action?.label, onAction: action?.run };
    setNotices((current) => [...current, entry]);
  }, []);

  const dismissNotice = useCallback(() => setNotices((current) => current.slice(1)), []);

  const accountById = useCallback(
    (id: string) => accounts.find((entry) => entry.id === id),
    [accounts],
  );

  const bootstrap = useCallback(async () => {
    setPhase("loading");
    setBackendError(null);
    try {
      const { accounts: loaded, folders: records } = await loadMailbox();
      setAccounts(loaded);
      setFolderRecords(records);
      if (loaded.length === 0) {
        setMails([]);
        setAccountState("");
        setPhase("empty");
        return;
      }
      setAccountState((current) => {
        if (current === ALL_ACCOUNTS) return loaded.length > 1 ? ALL_ACCOUNTS : loaded[0].id;
        if (loaded.some((entry) => entry.id === current)) return current;
        return loaded.length > 1 ? ALL_ACCOUNTS : loaded[0].id;
      });
      setPhase("ready");
    } catch (error) {
      setBackendError(errorText(error));
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    if (mode === "api") void bootstrap();
  }, [bootstrap, mode]);

  // Interrupteur PGP effectif de chaque compte : poussé au démon (les corps
  // chiffrés restent fermés en base) et au lecteur (défense en profondeur).
  // Une valeur déjà transmise n'est pas renvoyée.
  const pgpPolicy = useMemo(() => {
    const next: Record<string, boolean> = {};
    for (const entry of accounts) next[entry.id] = resolvePgp(pgpPrefs, entry.id).enabled;
    return next;
  }, [accounts, pgpPrefs]);
  const pushedPgp = useRef<Record<string, boolean>>({});

  useEffect(() => {
    setAccountDecryptPolicy(pgpPolicy);
    if (mode !== "api") return;
    for (const [id, enabled] of Object.entries(pgpPolicy)) {
      if (pushedPgp.current[id] === enabled) continue;
      pushedPgp.current[id] = enabled;
      mailApi.setAccountPgp(id, enabled).catch((error: unknown) => {
        delete pushedPgp.current[id];
        notify(`Interrupteur PGP non transmis · ${errorText(error)}`);
      });
    }
  }, [mode, notify, pgpPolicy]);

  // Le service pousse un événement après chaque détection IDLE : la liste se
  // rafraîchit sans clic, et sans bloquer l'interface.
  const notifyPrefs = useRef(prefs.notifications);
  notifyPrefs.current = prefs.notifications;
  const notifyAccounts = useRef(accounts);
  notifyAccounts.current = accounts;
  const liveMails = useRef(mails);
  liveMails.current = mails;

  useEffect(() => {
    if (mode !== "api" || !mailSyncOn || typeof EventSource === "undefined" || isComposeWindow()) return;
    let source: EventSource | null = null;
    let closed = false;
    void mailApi.eventsUrl().then((url) => {
      if (closed) return;
      source = new EventSource(url);
      source.addEventListener("mail", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as LiveEvent;
          const inserted = payload.report?.inserted ?? 0;
          if (
            inserted > 0 &&
            payload.folder_path.toUpperCase() === "INBOX" &&
            notificationsForAccount(notifyPrefs.current, payload.account_id)
          ) {
            const label = notifyAccounts.current.find((entry) => entry.id === payload.account_id)?.label;
            void notifyNewMail(
              label ? `Nouveau message · ${label}` : "Nouveau message",
              inserted === 1
                ? "Vous avez reçu un nouveau message."
                : `${inserted} nouveaux messages dans la boîte de réception.`,
            );
          }
          if (account === ALL_ACCOUNTS || !account || payload.account_id === account) {
            setRevision((value) => value + 1);
          }
        } catch {
          setRevision((value) => value + 1);
        }
      });
    });
    return () => {
      closed = true;
      source?.close();
    };
  }, [account, mailSyncOn, mode]);

  const retryBackend = useCallback(() => {
    if (mode === "api") void bootstrap();
  }, [bootstrap, mode]);

  const useDemo = useCallback(() => {
    setMode("demo");
    setAccounts(ACCOUNTS);
    setFolderRecords([]);
    setMails(MAILS);
    setAccountState(ALL_ACCOUNTS);
    setFolderState("inbox");
    setFolderPath(null);
    setOpenMail(null);
    setPages(1);
    setHasMore(false);
    setPhase("ready");
    setBackendError(null);
    setConnectOpen(false);
    setRemoveTarget(null);
  }, []);

  const targets = useMemo(
    () =>
      mode === "api"
        ? folderTargets(
            folderRecords,
            account === ALL_ACCOUNTS
              ? accounts.map((entry) => entry.id)
              : account
                ? [account]
                : [],
            folder,
            folderPath ?? undefined,
          )
        : [],
    [mode, folderRecords, account, accounts, folder, folderPath],
  );

  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || isComposeWindow()) return;
    if (targets.length === 0) {
      setMails([]);
      setHasMore(false);
      return;
    }
    let cancelled = false;
    setThreadsLoading(true);
    const requests = targets.flatMap((target) =>
      Array.from({ length: pages }, (_, page) =>
        mailApi.threads(target.accountId, target.path, PAGE_SIZE, page * PAGE_SIZE),
      ),
    );
    Promise.allSettled(requests)
      .then((results) => {
        if (cancelled) return;
        const loaded = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (loaded.length === 0 && failed) {
          notify(errorText(failed.reason));
          return;
        }
        setMails(
          loaded.flatMap((threads) =>
            threads.flatMap((thread) => threadToMails(thread, folderRecords, folder)),
          ),
        );
        setHasMore(
          targets.some((_, index) => {
            const last = results[index * pages + pages - 1];
            return last !== undefined && last.status === "fulfilled" && last.value.length === PAGE_SIZE;
          }),
        );
        if (failed) notify(errorText(failed.reason));
      })
      .finally(() => {
        if (!cancelled) setThreadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, phase, targets, pages, folder, folderRecords, revision, notify]);

  const folderOptions = useMemo<FolderOption[]>(() => {
    if (mode !== "api") {
      return [
        { id: "inbox" as const, label: folderLabel("inbox"), path: "inbox" },
        { id: "sent" as const, label: folderLabel("sent"), path: "sent" },
        { id: "drafts" as const, label: folderLabel("drafts"), path: "drafts" },
        { id: "archive" as const, label: folderLabel("archive"), path: "archive" },
        { id: "spam" as const, label: folderLabel("spam"), path: "spam" },
        { id: "trash" as const, label: folderLabel("trash"), path: "trash" },
      ];
    }
    const visible = folderRecords.filter(
      (record) =>
        record.role !== "other" ||
        !isFolderHidden(prefs.hiddenFolders, record.accountId, record.path),
    );
    return account === ALL_ACCOUNTS
      ? folderOptionsForAll(visible, accounts.map((entry) => entry.id))
      : optionsOf(visible, account);
  }, [mode, folderRecords, account, accounts, prefs.hiddenFolders]);

  const hiddenFolderOptions = useMemo<FolderOption[]>(() => {
    if (mode !== "api" || !account || account === ALL_ACCOUNTS) return [];
    const hidden = prefs.hiddenFolders[account] ?? [];
    if (hidden.length === 0) return [];
    return optionsOf(folderRecords, account).filter(
      (option) => option.id === "other" && hidden.includes(option.path),
    );
  }, [mode, account, folderRecords, prefs.hiddenFolders]);

  const setAccount = useCallback(
    (value: string) => {
      setAccountState(value);
      setFolderPath(null);
      if (mode !== "api" || value === ALL_ACCOUNTS) return;
      setFolderState((current) =>
        folderPathOf(folderRecords, value, current) ? current : "inbox",
      );
    },
    [folderRecords, mode],
  );

  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || isComposeWindow()) return;
    let cancelled = false;
    Promise.allSettled(accounts.map((entry) => mailApi.folderCounts(entry.id))).then((results) => {
      if (cancelled) return;
      const next: Record<string, { total: number; unread: number }> = {};
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        for (const count of result.value) {
          next[`${accounts[index].id}:${count.path}`] = { total: count.total, unread: count.unread };
        }
      });
      setFolderCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, phase, accounts, revision]);

  useEffect(() => {
    if (mode !== "api") return;
    let unread = 0;
    for (const record of folderRecords) {
      if (record.role === "inbox") {
        unread += folderCounts[`${record.accountId}:${record.path}`]?.unread ?? 0;
      }
    }
    setUnreadBadge(unread);
  }, [mode, folderCounts, folderRecords]);

  // Première visite d'un dossier : synchro automatique en arrière-plan, pour ne
  // pas avoir à cliquer sur « Synchroniser ». Une seule fois par portée
  // (compte + dossier) ; revision recharge ensuite fils et compteurs.
  const autoSyncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (mode !== "api" || !mailSyncOn || phase !== "ready" || isComposeWindow()) return;
    const due = targets.filter((target) => mailsInPerimeter(target.accountId));
    if (due.length === 0) return;
    const key = due.map((t) => `${t.accountId}:${t.path}`).sort().join("|");
    if (autoSyncedRef.current.has(key)) return;
    autoSyncedRef.current.add(key);
    let cancelled = false;
    setSyncing(true);
    Promise.all(due.map((t) => mailApi.sync(t.accountId, t.path)))
      .then(() => {
        if (!cancelled) setRevision((value) => value + 1);
      })
      .catch(() => {
        // Synchro de confort en arrière-plan : muette en cas d'échec pour ne pas
        // dupliquer la notice du chargement des fils. L'état vide propose « Synchroniser ».
      })
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mailsInPerimeter, mailSyncOn, mode, phase, targets]);

  const demoCounts = useMemo(() => {
    const next: Record<string, { total: number; unread: number }> = {};
    if (mode !== "demo") return next;
    for (const mail of mails) {
      const key = `${mail.account}:${mail.folder}`;
      const entry = next[key] ?? { total: 0, unread: 0 };
      entry.total += 1;
      if (mail.unread) entry.unread += 1;
      next[key] = entry;
    }
    return next;
  }, [mode, mails]);

  const statsFor = useCallback(
    (id: FolderId, path: string | undefined, scopeAccounts: string[]) => {
      const counts = mode === "demo" ? demoCounts : folderCounts;
      let total = 0;
      let unread = 0;
      for (const accountId of scopeAccounts) {
        const paths =
          mode === "demo"
            ? [id as string]
            : folderRecords
                .filter(
                  (record) =>
                    record.accountId === accountId &&
                    record.role === id &&
                    (id !== "other" || record.path === path),
                )
                .map((record) => record.path);
        for (const folderPath of paths) {
          const entry = counts[`${accountId}:${folderPath}`];
          if (entry) {
            total += entry.total;
            unread += entry.unread;
          }
        }
      }
      return { total, unread };
    },
    [demoCounts, folderCounts, folderRecords, mode],
  );

  const folderStats = useCallback(
    (id: FolderId, path?: string) =>
      statsFor(
        id,
        path,
        account === ALL_ACCOUNTS ? accounts.map((entry) => entry.id) : account ? [account] : [],
      ),
    [account, accounts, statsFor],
  );

  const accountUnread = useCallback(
    (accountId: string) =>
      statsFor(
        "inbox",
        undefined,
        accountId === ALL_ACCOUNTS ? accounts.map((entry) => entry.id) : [accountId],
      ).unread,
    [accounts, statsFor],
  );

  const adjustCounts = useCallback(
    (accountId: string, path: string, total: number, unread: number) => {
      if (mode !== "api") return;
      setFolderCounts((current) => {
        const key = `${accountId}:${path}`;
        const entry = current[key] ?? { total: 0, unread: 0 };
        return {
          ...current,
          [key]: {
            total: Math.max(0, entry.total + total),
            unread: Math.max(0, entry.unread + unread),
          },
        };
      });
    },
    [mode],
  );

  const scope = JSON.stringify([account, folder, folderPath]);
  const [scopeKey, setScopeKey] = useState(scope);
  if (scope !== scopeKey) {
    setScopeKey(scope);
    setPages(1);
    setHasMore(false);
  }

  const setFolder = useCallback((value: FolderId, path?: string | null) => {
    setFolderState(value);
    setFolderPath(path ?? null);
  }, []);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    setPages((current) => current + 1);
  }, [hasMore]);

  const flagsFor = useCallback(
    (mail: Mail, next: { unread: boolean; starred: boolean }) => {
      if (!mail.source) return Promise.resolve();
      return mailApi.setFlags(mail.source.accountId, {
        folder_path: mail.source.folderPath,
        uid: mail.source.uid,
        unread: next.unread,
        starred: next.starred,
      });
    },
    [],
  );

  const toggleStar = useCallback(
    (id: string) => {
      const mail =
        mails.find((entry) => entry.id === id) ?? searchResults.find((entry) => entry.id === id);
      setMails((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, starred: !entry.starred } : entry)),
      );
      setSearchResults((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, starred: !entry.starred } : entry)),
      );
      setOpenMail((current) =>
        current && current.id === id ? { ...current, starred: !current.starred } : current,
      );
      if (mode !== "api" || !mail) return;
      flagsFor(mail, { unread: mail.unread, starred: !mail.starred }).catch((error: unknown) => {
        setMails((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, starred: mail.starred } : entry)),
        );
        setSearchResults((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, starred: mail.starred } : entry)),
        );
        notify(errorText(error));
      });
    },
    [flagsFor, mails, mode, notify, searchResults],
  );

  const moveTo = useCallback(
    (mail: Mail, role: FolderId, message?: string) => {
      if (!mail.source) return;
      const target = folderPathOf(folderRecords, mail.source.accountId, role);
      if (!target) {
        notify(`Dossier « ${folderLabel(role)} » introuvable sur ce compte.`);
        return;
      }
      if (target === mail.source.folderPath) {
        notify(`Le message est déjà dans « ${folderLabel(role)} ».`);
        return;
      }
      const source = mail.source;
      setMails((current) => current.filter((entry) => entry.id !== mail.id));
      adjustCounts(source.accountId, source.folderPath, -1, mail.unread ? -1 : 0);
      mailApi
        .move(source.accountId, { from_path: source.folderPath, uid: source.uid, to_path: target })
        .then(() => {
          adjustCounts(source.accountId, target, 1, mail.unread ? 1 : 0);
          notify(message ?? `Message déplacé vers ${folderLabel(role)}`);
          setRevision((value) => value + 1);
        })
        .catch((error: unknown) => {
          setMails((current) =>
            current.some((entry) => entry.id === mail.id) ? current : [...current, mail],
          );
          adjustCounts(source.accountId, source.folderPath, 1, mail.unread ? 1 : 0);
          notify(errorText(error));
        });
    },
    [adjustCounts, folderRecords, notify],
  );

  const addSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      planning.addSuggestion(suggestion);
      notify("Tâche ajoutée à la planification", {
        label: "Annuler",
        run: () => planning.unpromote(suggestion),
      });
    },
    [notify, planning],
  );

  const dismissSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      planning.dismissSuggestion(suggestion);
      notify("Suggestion masquée");
    },
    [notify, planning],
  );

  const mailAction = useCallback(
    (kind: "delete" | "archive" | "read", mail: Mail) => {
      if (kind === "read") {
        setMails((current) =>
          current.map((entry) => (entry.id === mail.id ? { ...entry, unread: !entry.unread } : entry)),
        );
        setOpenMail((current) =>
          current && current.id === mail.id ? { ...current, unread: !current.unread } : current,
        );
        if (mode === "api" && mail.source) {
          const source = mail.source;
          adjustCounts(source.accountId, source.folderPath, 0, mail.unread ? -1 : 1);
          flagsFor(mail, { unread: !mail.unread, starred: mail.starred }).catch((error: unknown) => {
            setMails((current) =>
              current.map((entry) => (entry.id === mail.id ? { ...entry, unread: mail.unread } : entry)),
            );
            adjustCounts(source.accountId, source.folderPath, 0, mail.unread ? 1 : -1);
            notify(errorText(error));
          });
        }
        return;
      }

      if (mode === "api") {
        if (kind === "delete" && mail.folder === "trash" && mail.source) {
          const source = mail.source;
          mailApi
            .deleteMessage(source.accountId, { folder_path: source.folderPath, uid: source.uid })
            .then(() => {
              setMails((current) => current.filter((entry) => entry.id !== mail.id));
              setOpenMail((current) => (current && current.id === mail.id ? null : current));
              adjustCounts(source.accountId, source.folderPath, -1, mail.unread ? -1 : 0);
              notify("Message supprimé définitivement");
            })
            .catch((error: unknown) => notify(errorText(error)));
          return;
        }

        moveTo(
          mail,
          kind === "delete" ? "trash" : "archive",
          kind === "delete" ? "Message déplacé vers la corbeille" : "Message archivé",
        );
        return;
      }

      const index = mails.findIndex((entry) => entry.id === mail.id);

      if (kind === "delete" && mail.folder === "trash") {
        setMails((current) => current.filter((entry) => entry.id !== mail.id));
        notify("Message supprimé", {
          label: "Annuler",
          run: () =>
            setMails((current) =>
              current.some((entry) => entry.id === mail.id) ? current : insertAt(current, index, mail),
            ),
        });
        return;
      }

      const target: FolderId = kind === "delete" ? "trash" : "archive";
      const previous = mail.folder;
      setMails((current) =>
        current.map((entry) =>
          entry.id === mail.id ? { ...entry, folder: target, previousFolder: previous } : entry,
        ),
      );
      notify(target === "trash" ? "Message déplacé vers la corbeille" : "Message archivé", {
        label: "Annuler",
        run: () =>
          setMails((current) =>
            current.map((entry) =>
              entry.id === mail.id ? { ...entry, folder: previous, previousFolder: mail.previousFolder } : entry,
            ),
          ),
      });
    },
    [adjustCounts, flagsFor, mails, mode, moveTo, notify],
  );

  const openMessage = useCallback(
    (target: Mail | string) => {
      const mail = typeof target === "string" ? liveMails.current.find((entry) => entry.id === target) : target;
      if (!mail) {
        if (typeof target === "string") notify("Mail d'origine introuvable");
        return;
      }
      if (mail.folder === "drafts") {
        resumeDraftRef.current(mail);
        return;
      }
      setOpenMail({ ...mail, unread: false });
      setMails((current) => current.map((item) => (item.id === mail.id ? { ...item, unread: false } : item)));
      if (mode !== "api" || !mail.source) return;
      if (mail.unread) {
        adjustCounts(mail.source.accountId, mail.source.folderPath, 0, -1);
        flagsFor(mail, { unread: false, starred: mail.starred }).catch((error: unknown) =>
          notify(errorText(error)),
        );
      }
      if (mail.bodyFetched) return;
      if (mail.pgp === "encrypted" && !resolvePgp(pgpPrefs, mail.account).enabled) {
        return;
      }
      const source = mail.source;
      setBodyFetching(mail.id);
      mailApi
        .message(source.accountId, source.folderPath, source.uid)
        .then((message) => {
          const fetched = messageToMail(message, folderRecords, mail.folder);
          setMails((current) =>
            current.map((entry) =>
              entry.id === fetched.id ? { ...fetched, folder: entry.folder, unread: false } : entry,
            ),
          );
          setOpenMail((current) =>
            current && current.id === fetched.id
              ? { ...fetched, folder: current.folder, unread: false }
              : current,
          );
        })
        .catch((error: unknown) => notify(`Corps du message indisponible · ${errorText(error)}`))
        .finally(() => setBodyFetching((current) => (current === mail.id ? null : current)));
    },
    [adjustCounts, flagsFor, folderRecords, mode, notify, pgpPrefs],
  );

  const closeMessage = useCallback(() => setOpenMail(null), []);

  const moveToInbox = useCallback(
    (mail: Mail) => {
      if (mode === "api") {
        moveTo(mail, "inbox", "Message déplacé vers la boîte de réception");
        return;
      }
      const previous = mail.folder;
      setMails((current) =>
        current.map((entry) =>
          entry.id === mail.id ? { ...entry, folder: "inbox", previousFolder: undefined } : entry,
        ),
      );
      notify("Message déplacé vers la boîte de réception", {
        label: "Annuler",
        run: () =>
          setMails((current) =>
            current.map((entry) => (entry.id === mail.id ? { ...entry, folder: previous } : entry)),
          ),
      });
    },
    [mode, moveTo, notify],
  );

  const restoreMail = useCallback(
    (mail: Mail) => {
      if (mode === "api") {
        moveTo(mail, "inbox", "Message restauré dans la boîte de réception");
        return;
      }
      const from = mail.folder;
      const target: FolderId = mail.previousFolder ?? "inbox";
      setMails((current) =>
        current.map((entry) =>
          entry.id === mail.id ? { ...entry, folder: target, previousFolder: undefined } : entry,
        ),
      );
      notify(`Message restauré · ${folderLabel(target)}`, {
        label: "Annuler",
        run: () =>
          setMails((current) =>
            current.map((entry) =>
              entry.id === mail.id
                ? { ...entry, folder: from, previousFolder: mail.previousFolder }
                : entry,
            ),
          ),
      });
    },
    [mode, moveTo, notify],
  );

  const emptyTrash = useCallback(() => {
    const inTrash = (entry: Mail) =>
      entry.folder === "trash" && (account === ALL_ACCOUNTS || entry.account === account);

    if (mode === "api") {
      const purges = folderTargets(
        folderRecords,
        account === ALL_ACCOUNTS ? accounts.map((entry) => entry.id) : [account],
        "trash",
      );
      if (purges.length === 0) {
        notify("Ce compte n'a pas de dossier corbeille.");
        return;
      }
      Promise.all(purges.map((purge) => mailApi.purgeFolder(purge.accountId, { folder_path: purge.path })))
        .then((results) => {
          const removed = results.reduce((sum, result) => sum + result.removed, 0);
          setMails((current) => current.filter((entry) => !inTrash(entry)));
          setOpenMail((current) => (current && inTrash(current) ? null : current));
          setFolderCounts((current) => {
            const next = { ...current };
            for (const purge of purges) next[`${purge.accountId}:${purge.path}`] = { total: 0, unread: 0 };
            return next;
          });
          setRevision((value) => value + 1);
          notify(
            removed > 0
              ? `Corbeille vidée · ${removed} message${removed > 1 ? "s" : ""}`
              : "La corbeille est déjà vide.",
          );
        })
        .catch((error: unknown) => notify(`Corbeille impossible · ${errorText(error)}`));
      return;
    }

    const removed = mails.filter(inTrash);
    setMails((current) => current.filter((entry) => !inTrash(entry)));
    setOpenMail((current) => (current && inTrash(current) ? null : current));
    notify("Corbeille vidée", {
      label: "Annuler",
      run: () =>
        setMails((current) => [
          ...current,
          ...removed.filter((entry) => !current.some((item) => item.id === entry.id)),
        ]),
    });
  }, [account, accounts, folderRecords, mails, mode, notify]);

  /** Reprise remplacée ou abandonnée : plus rien à supprimer côté serveur. */
  const resetDraftSource = useCallback(() => {
    resumedDraftId.current = null;
    setDraftSource(null);
  }, []);

  /**
   * La reprise a été enregistrée ou envoyée : l'ancien brouillon serveur est
   * supprimé pour ne pas laisser de doublon. Rien n'est supprimé avant, pour
   * qu'un abandon ou une fermeture laisse l'original intact.
   */
  const forgetDraftSource = useCallback(
    (source: MailSource | null) => {
      const demoId = resumedDraftId.current;
      resumedDraftId.current = null;
      setDraftSource(null);
      if (demoId) setMails((current) => current.filter((entry) => entry.id !== demoId));
      if (!source) return;
      mailApi
        .deleteMessage(source.accountId, { folder_path: source.folderPath, uid: source.uid })
        .catch((error: unknown) => notify(`Ancien brouillon conservé · ${errorText(error)}`));
    },
    [notify],
  );

  const minimizeCompose = useCallback(() => setComposeOpen(false), []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft(null);
    resetDraftSource();
  }, [resetDraftSource]);

  /**
   * Reprise d'un brouillon : le lecteur n'a rien à y faire, le corps revient
   * dans l'éditeur avec sa signature déjà écrite (`includeSignature: false`).
   */
  const resumeDraft = useCallback(
    (mail: Mail) => {
      const open = (draft: ComposeDraft, source: MailSource | null) => {
        resumedDraftId.current = source ? null : mail.id;
        setDraftSource(source);
        setComposeDraft(draft);
        setComposeTitle("Brouillon");
        setComposeOpen(true);
        if (composeDetached) composeBus.current?.post({ kind: "focus" });
        notify("Brouillon repris");
      };

      const start = () => {
        const source = mode === "api" ? mail.source : undefined;
        if (!source) {
          const pgp = resolvePgp(pgpPrefs, mail.account);
          const attachments = (mail.attachments ?? []).flatMap((file) =>
            file.data
              ? [
                  {
                    filename: file.name,
                    mime: file.mime || mimeOf(file.name),
                    data_base64: file.data,
                    size: base64Size(file.data),
                  },
                ]
              : [],
          );
          open(
            {
              ...baseDraft(mail.account, pgp.encrypt, pgp.sign, mail.threadId),
              to: mail.to ?? "",
              subject: mail.subject === "(sans objet)" ? "" : mail.subject,
              body: mail.body.join("\n"),
              includeSignature: false,
              attachments: attachments.length ? attachments : undefined,
            },
            null,
          );
          return;
        }

        void (async () => {
          try {
            const message = await mailApi.message(source.accountId, source.folderPath, source.uid);
            const pgp = resolvePgp(pgpPrefs, source.accountId);
            const full = message.body_html ?? textToHtml(message.body_text ?? "");
            const { body, quoted } = splitQuotedBody(full);
            const attachments: DraftAttachment[] = [];
            for (const [index, file] of message.attachments.entries()) {
              if (file.inline) continue;
              if (file.size > MAX_ATTACHMENT_BYTES) {
                notify(
                  `« ${file.filename} » non reprise · ${formatBytes(MAX_ATTACHMENT_BYTES)} maximum par fichier.`,
                );
                continue;
              }
              try {
                const blob = await mailApi.attachment(
                  source.accountId,
                  source.folderPath,
                  source.uid,
                  index,
                );
                attachments.push({
                  filename: file.filename,
                  mime: file.mime || mimeOf(file.filename),
                  data_base64: await readBase64(blob),
                  size: file.size,
                });
              } catch (error) {
                notify(`« ${file.filename} » non reprise · ${errorText(error)}`);
              }
            }
            open(
              {
                ...baseDraft(source.accountId, pgp.encrypt, pgp.sign, message.thread_id),
                to: message.to.map((address) => address.email).join(", "),
                cc: message.cc.map((address) => address.email).join(", "),
                subject: message.subject === "(sans objet)" ? "" : message.subject,
                body,
                ...(quoted ? { quoted } : {}),
                includeSignature: false,
                attachments: attachments.length ? attachments : undefined,
                inReplyTo: message.in_reply_to ?? undefined,
                references: message.references,
              },
              source,
            );
          } catch (error) {
            notify(`Brouillon non repris · ${errorText(error)}`);
          }
        })();
      };

      if (composeDraft && !emptyDraft(composeDraft)) {
        notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: start });
        return;
      }
      start();
    },
    [composeDetached, composeDraft, mode, notify, pgpPrefs],
  );
  resumeDraftRef.current = resumeDraft;

  const saveToDrafts = useCallback(
    async (draft: ComposeDraft): Promise<boolean> => {
      const source = draftSource;
      if (mode !== "api") {
        forgetDraftSource(null);
        notify("Brouillon enregistré (démo)");
        return true;
      }
      try {
        await mailApi.saveDraft(draft.account, sendInputOf(draft));
        if (source) forgetDraftSource(source);
        notify("Brouillon enregistré");
        setRevision((value) => value + 1);
        return true;
      } catch (error) {
        notify(`Brouillon non enregistré · ${errorText(error)}`);
        return false;
      }
    },
    [draftSource, forgetDraftSource, mode, notify],
  );

  const detachCompose = useCallback(() => {
    setComposeDetached(true);
    setComposeOpen(false);
  }, []);

  const dockCompose = useCallback(() => {
    setComposeDetached(false);
    setComposeOpen(true);
  }, []);

  const detachClosed = useCallback(() => setComposeDetached(false), []);

  useEffect(() => {
    if (isComposeWindow()) return;
    const bus = openComposeBus((message) => {
      switch (message.kind) {
        case "hello":
          composeBus.current?.post({ kind: "state", state: composeStateRef.current });
          break;
        case "edit":
          if (composeStateRef.current.draft) setComposeDraft(message.draft);
          break;
        case "send":
          if (composeStateRef.current.draft) sendDraftRef.current(message.draft);
          break;
        case "closed":
          setComposeDetached(false);
          break;
        case "dock":
          setComposeDetached(false);
          setComposeOpen(true);
          break;
      }
    });
    composeBus.current = bus;
    return () => {
      bus?.close();
      composeBus.current = null;
    };
  }, []);

  useEffect(() => {
    if (isComposeWindow()) return;
    const state: ComposeState = {
      draft: composeDraft,
      title: composeTitle,
      detached: composeDetached,
      draftSource,
    };
    composeStateRef.current = state;
    persistCompose(
      composeDraft ? persistedDraft(composeDraft) : null,
      composeTitle,
      composeDraft ? draftSource : null,
    );
    const json = JSON.stringify(state);
    if (json !== lastPostedCompose.current) {
      lastPostedCompose.current = json;
      composeBus.current?.post({ kind: "state", state });
    }
  }, [composeDraft, composeTitle, composeDetached, draftSource]);

  const blankDraft = useCallback(() => {
    const sender = account === ALL_ACCOUNTS || !account ? accounts[0]?.id ?? "" : account;
    const pgp = resolvePgp(pgpPrefs, sender);
    return baseDraft(sender, pgp.encrypt, pgp.sign);
  }, [account, accounts, pgpPrefs]);

  const startBlankDraft = useCallback(() => {
    setComposeDraft(blankDraft());
    setComposeTitle("Nouveau message");
    setComposeOpen(true);
    resetDraftSource();
  }, [blankDraft, resetDraftSource]);

  const openComposer = useCallback(() => {
    if (composeDetached) {
      composeBus.current?.post({ kind: "focus" });
      if (!composeDraft || emptyDraft(composeDraft)) startBlankDraft();
      return;
    }
    if (composeOpen) return;
    if (composeDraft && !emptyDraft(composeDraft)) {
      notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: startBlankDraft });
      return;
    }
    startBlankDraft();
  }, [composeDetached, composeDraft, composeOpen, notify, startBlankDraft]);

  const resumeCompose = useCallback(() => setComposeOpen(true), []);

  const replyTo = useCallback(
    (mail: Mail) => {
      const start = () => {
        resetDraftSource();
        const pgp = resolvePgp(pgpPrefs, mail.account);
        const references = [
          ...(mail.references ?? []),
          ...(mail.messageId ? [mail.messageId] : []),
        ];
        setComposeDraft({
          ...baseDraft(mail.account, pgp.encrypt, pgp.sign, mail.threadId ?? mail.id),
          to: mail.email,
          subject: /^re\s*:/i.test(mail.subject.trim()) ? mail.subject : `Re: ${mail.subject}`,
          body: "",
          quoted: buildQuotedHtml(
            `Le ${mail.date ?? mail.time}, ${mail.name} a écrit :`,
            textToHtml(mail.body.join("\n")),
          ),
          inReplyTo: mail.messageId,
          references,
        });
        setComposeTitle("Répondre");
        setComposeOpen(true);
        if (composeDetached) composeBus.current?.post({ kind: "focus" });
      };
      if (composeDraft && !emptyDraft(composeDraft)) {
        notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: start });
        return;
      }
      start();
    },
    [composeDetached, composeDraft, notify, pgpPrefs, resetDraftSource],
  );

  const forwardMail = useCallback(
    (mail: Mail) => {
      const start = () => {
        resetDraftSource();
        const pgp = resolvePgp(pgpPrefs, mail.account);
        setComposeDraft({
          ...baseDraft(mail.account, pgp.encrypt, pgp.sign),
          subject: /^tr\s*:/i.test(mail.subject.trim()) ? mail.subject : `Tr: ${mail.subject}`,
          body: "",
          quoted: buildQuotedHtml(
            "Message transféré",
            textToHtml(
              `De : ${mail.name} <${mail.email}>\nDate : ${mail.date ?? mail.time}\nObjet : ${
                mail.subject
              }\n\n${mail.body.join("\n")}`,
            ),
          ),
        });
        setComposeTitle("Transférer");
        setComposeOpen(true);
        if (composeDetached) composeBus.current?.post({ kind: "focus" });
      };
      if (composeDraft && !emptyDraft(composeDraft)) {
        notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: start });
        return;
      }
      start();
    },
    [composeDetached, composeDraft, notify, pgpPrefs],
  );

  const sendDraft = useCallback(
    (draft: ComposeDraft) => {
      const source = draftSource;
      if (mode === "api") {
        mailApi
          .send(draft.account, sendInputOf(draft, activeSignature(prefs.signatures, draft.account)))
          .then(() => {
            setComposeOpen(false);
            setComposeDraft(null);
            if (source) forgetDraftSource(source);
            notify("Message envoyé");
            setRevision((value) => value + 1);
            composeBus.current?.post({ kind: "sent" });
          })
          .catch((error: unknown) => {
            const message = `Envoi impossible · ${errorText(error)}`;
            notify(message);
            composeBus.current?.post({ kind: "send-failed", message });
          });
        return;
      }

      const sender = accounts.find((entry) => entry.id === draft.account) ?? accounts[0];
      if (!sender) return;
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const body = htmlToText(draft.body).split("\n").filter((line) => line.trim() !== "");
      const preview = body.find((line) => line.trim() !== "---" && !line.startsWith(">")) ?? "";
      const mail: Mail = {
        id: `sent-${now.getTime()}`,
        account: sender.id,
        folder: "sent",
        threadId: draft.threadId,
        name: sender.label,
        email: sender.email,
        subject: draft.subject.trim() || "(sans objet)",
        to: firstRecipient([draft.to, draft.cc, draft.cci].filter(Boolean).join(",")) || undefined,
        preview,
        body,
        time,
        date: `${new Intl.DateTimeFormat("fr-FR", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }).format(now)} · ${time}`,
        unread: false,
        starred: false,
        pgp: draft.pgpEncrypt ? "encrypted" : draft.pgpSign ? "signed" : "none",
        attachments: draft.attachments?.map((file) => ({
          name: file.filename,
          size: formatBytes(file.size),
          mime: file.mime,
        })),
        tone: sender.tone,
      };
      setMails((current) => [mail, ...current]);
      setComposeOpen(false);
      setComposeDraft(null);
      forgetDraftSource(null);
      notify("Message envoyé");
      composeBus.current?.post({ kind: "sent" });
    },
    [accounts, draftSource, forgetDraftSource, mode, notify, prefs.signatures],
  );
  sendDraftRef.current = sendDraft;

  const syncFolder = useCallback(() => {
    if (mode !== "api") {
      notify("Mode démo : la synchronisation est simulée.");
      return;
    }
    if (targets.length === 0) {
      notify("Choisis un dossier à synchroniser.");
      return;
    }
    const due = targets.filter((target) => mailsInPerimeter(target.accountId));
    if (due.length === 0) {
      notify("Mails hors périmètre de ce compte · synchronisation ignorée");
      return;
    }
    setSyncing(true);
    Promise.all(due.map((target) => mailApi.sync(target.accountId, target.path)))
      .then((results) => {
        const reports = results.flatMap((result) => result.reports);
        if (account === ALL_ACCOUNTS) {
          const totals = reports.reduce(
            (sum, report) => ({
              inserted: sum.inserted + report.inserted,
              flags_updated: sum.flags_updated + report.flags_updated,
              removed: sum.removed + report.removed,
            }),
            { inserted: 0, flags_updated: 0, removed: 0 },
          );
          notify(syncNotice([totals]));
        } else {
          notify(syncNotice(reports));
        }
        setRevision((value) => value + 1);
      })
      .catch((error: unknown) => notify(`Synchro impossible · ${errorText(error)}`))
      .finally(() => setSyncing(false));
  }, [account, mailsInPerimeter, targets, mode, notify]);

  const openConnect = useCallback(() => setConnectOpen(true), []);
  const closeConnect = useCallback(() => setConnectOpen(false), []);

  const searchMails = useCallback(
    async (query: string): Promise<Mail[]> => {
      const trimmed = query.trim();
      if (!trimmed) {
        setSearchResults([]);
        return [];
      }
      if (mode !== "api") {
        const found = MAILS.filter((mail) => mailMatches(mail, trimmed));
        setSearchResults(found);
        return found;
      }
      const results = await Promise.allSettled(
        accounts.map((entry) => mailApi.search(entry.id, trimmed)),
      );
      const found = results.flatMap((result) =>
        result.status === "fulfilled"
          ? result.value.map((message) => messageToMail(message, folderRecords, "inbox"))
          : [],
      );
      setSearchResults(found);
      return found;
    },
    [accounts, folderRecords, mode],
  );

  const createAccount = useCallback(
    async (input: NewAccount) => {
      const summary = await mailApi.createAccount(input);
      const { accounts: loaded, folders: records } = await loadMailbox();
      setAccounts(loaded);
      setFolderRecords(records);
      setAccountState(summary.id);
      setFolderState("inbox");
      setFolderPath(null);
      setConnectOpen(false);
      setPhase("ready");
      setBackendError(null);
      if (!mailSyncOn || !mailsInPerimeter(summary.id)) {
        notify("Compte connecté · synchronisation des mails coupée");
        return summary.id;
      }
      try {
        const result = await mailApi.sync(summary.id);
        const inserted = result.reports.reduce((total, report) => total + report.inserted, 0);
        notify(
          inserted > 0
            ? `Compte connecté · ${inserted} message${inserted > 1 ? "s" : ""} synchronisé${inserted > 1 ? "s" : ""}`
            : "Compte connecté",
        );
      } catch (error) {
        notify(`Compte connecté, mais synchro impossible · ${errorText(error)}`);
      }
      setRevision((value) => value + 1);
      return summary.id;
    },
    [mailSyncOn, mailsInPerimeter, notify],
  );

  const renameAccount = useCallback(
    async (id: string, label: string) => {
      const clean = label.trim();
      if (!clean) return;
      try {
        await mailApi.renameAccount(id, clean);
        setAccounts((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, label: clean } : entry)),
        );
        notify(`Compte renommé · ${clean}`);
      } catch (error) {
        notify(errorText(error));
      }
    },
    [notify],
  );

  const askRemoveAccount = useCallback((target: Account) => setRemoveTarget(target), []);
  const cancelRemoveAccount = useCallback(() => setRemoveTarget(null), []);

  const confirmRemoveAccount = useCallback(() => {
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target) return;
    mailApi
      .deleteAccount(target.id)
      .then(async () => {
        notify(`Compte « ${target.label} » retiré`);
        setOpenMail(null);
        setComposeDraft(null);
        setComposeOpen(false);
        setFolderState("inbox");
        setFolderPath(null);
        await bootstrap();
      })
      .catch((error: unknown) => notify(errorText(error)));
  }, [bootstrap, notify, removeTarget]);

  /**
   * Supprime un dossier personnalisé : le serveur d'abord, le cache local
   * ensuite. Un refus du serveur laisse le dossier et ses messages en place.
   */
  const deleteFolder = useCallback(
    async (path: string, label: string, accountId?: string) => {
      if (mode !== "api") return false;
      const ids = accountId
        ? [accountId]
        : account === ALL_ACCOUNTS
          ? accounts.map((entry) => entry.id)
          : account
            ? [account]
            : [];
      const scope = folderTargets(folderRecords, ids, "other", path);
      if (scope.length === 0) {
        notify(`Dossier « ${label} » introuvable sur ce compte.`);
        return false;
      }
      let failure: string | null = null;
      for (const target of scope) {
        try {
          await mailApi.deleteFolder(target.accountId, target.path);
        } catch (error) {
          failure = errorText(error);
          break;
        }
      }
      try {
        const { folders: records } = await loadMailbox();
        setFolderRecords(records);
        if (folder === "other" && folderPath === path) setFolder("inbox", null);
      } catch (error) {
        failure = failure ?? errorText(error);
      }
      setRevision((value) => value + 1);
      notify(
        failure === null
          ? `Dossier « ${label} » supprimé`
          : `Dossier « ${label} » non supprimé · ${failure}`,
      );
      return failure === null;
    },
    [account, accounts, folder, folderPath, folderRecords, mode, notify, setFolder],
  );

  /**
   * Masque un dossier de la liste du compte courant : rien ne quitte le serveur,
   * seul le réglage local change. Un dossier ouvert repart sur la réception.
   */
  const hideFolder = useCallback(
    (path: string) => {
      if (mode !== "api" || !account || account === ALL_ACCOUNTS) return;
      prefs.setFolderHidden(account, path, true);
      if (folder === "other" && folderPath === path) setFolder("inbox", null);
    },
    [prefs, account, folder, folderPath, mode, setFolder],
  );

  const unhideFolder = useCallback(
    (path: string) => {
      if (mode !== "api" || !account || account === ALL_ACCOUNTS) return;
      prefs.setFolderHidden(account, path, false);
    },
    [prefs, account, mode],
  );

  const inboxMails = useMemo(() => mails.filter((mail) => mail.folder === "inbox"), [mails]);

  const inboxIndex = useMemo(
    () => new Map(inboxMails.map((mail) => [mail.id, mail])),
    [inboxMails],
  );

  /** Mails réellement analysés par le résumé affiché : base de l'aperçu des pièces jointes. */
  const summaryMails = useMemo(() => {
    if (!summary || summary.mailIds.length === 0) return [];
    const byId = new Map(mails.map((mail) => [mail.id, mail]));
    return summary.mailIds.flatMap((id) => {
      const mail = byId.get(id);
      return mail ? [mail] : [];
    });
  }, [mails, summary]);

  /** Comptes coupés des suggestions : leurs mails ne sont ni analysés ni proposés. */
  const excludedAccounts = useMemo(
    () => new Set(prefs.aiTasks.excludedAccounts),
    [prefs.aiTasks.excludedAccounts],
  );

  const aiMails = useMemo(
    () =>
      excludedAccounts.size === 0
        ? inboxMails
        : inboxMails.filter((mail) => !excludedAccounts.has(mail.account)),
    [excludedAccounts, inboxMails],
  );

  /** Suggestions affichées : celles de la fenêtre, hors des comptes exclus. */
  const suggestions = useMemo(() => {
    const visible = suggestionsInWindow(storedSuggestions, prefs.aiTasks.windowHours);
    return excludedAccounts.size === 0
      ? visible
      : visible.filter((suggestion) => !excludedAccounts.has(suggestion.account));
  }, [excludedAccounts, storedSuggestions, prefs.aiTasks.windowHours]);

  /** Entrée minimale du moteur : expéditeur, objet, aperçu et horodatage, rien d'autre. */
  const summaryInputs = useCallback(
    (list: Mail[]): SummaryMailInput[] =>
      list.flatMap((mail) =>
        typeof mail.timestamp === "number"
          ? [
              {
                id: mail.id,
                from: mail.name,
                subject: mail.subject,
                snippet: mail.preview,
                timestamp: mail.timestamp,
              },
            ]
          : [],
      ),
    [],
  );

  /**
   * Transforme des tâches extraites en SUGGESTIONS en attente de validation.
   * Dédup par mail + intitulé : une même action ne devient jamais deux suggestions.
   */
  const proposeTasks = useCallback(
    (proposed: SummaryTask[], byId: Map<string, Mail>, label: string) => {
      const known = new Set([
        ...planning.suggestions.map((entry) => `${entry.mailId}:${normalize(entry.proposal)}`),
        ...planning.tasks.map((entry) => `${entry.mailId ?? ""}:${normalize(entry.title)}`),
      ]);
      for (const task of proposed) {
        const key = `${task.mailId ?? ""}:${normalize(task.title)}`;
        if (known.has(key)) continue;
        known.add(key);
        const mail = task.mailId ? byId.get(task.mailId) : undefined;
        planning.proposeSuggestion(summarySuggestion(task, mail, label));
      }
    },
    [planning],
  );


  /**
   * Recalcule le résumé de la plage courante pour la boîte sélectionnée. Le
   * modèle n'est sollicité qu'une fois par portée, plage et jeu de mails : le
   * résultat est conservé sur le poste, et seul « Régénérer » force un nouveau
   * passage. En démo, jamais de réseau.
   */
  const refreshSummary = useCallback(
    async (force = false) => {
      if (!prefs.summary.enabled) {
        setSummary(null);
        return;
      }
      if (summaryRunning.current) return;
      const now = new Date();
      const period = currentPeriod(prefs.summary, now);
      const scope = summaryScope(account && account !== ALL_ACCOUNTS ? account : null);
      const scoped =
        scope === ALL_ACCOUNTS ? inboxMails : inboxMails.filter((mail) => mail.account === scope);
      const inputs = summaryInputs(scoped);
      const signature = summarySignature(inputs);
      const runKey = `${scope}:${period.id}:${signature}`;
      if (!force && summaryRun.current === runKey) return;
      if (!force) {
        const cached = readSummaryCache(summaryStorage(), scope, period.id, signature);
        if (cached) {
          summaryRun.current = runKey;
          setSummary(cached);
          return;
        }
      }
      summaryRunning.current = true;
      setSummaryLoading(true);
      try {
        const result = await generateSummary(
          mode === "demo" ? { ...prefs.summary, llmConsent: false } : prefs.summary,
          prefs.llm,
          inputs,
          now,
        );
        setSummary(result);
        if (result.mailCount > 0) summaryRun.current = runKey;
        if (result.source === "llm") {
          writeSummaryCache(summaryStorage(), scope, result.period.id, signature, result);
        }
        proposeTasks(
          result.tasks.filter((task) => {
            const mail = task.mailId ? inboxIndex.get(task.mailId) : undefined;
            return !mail || !excludedAccounts.has(mail.account);
          }),
          inboxIndex,
          result.period.label,
        );
      } catch (error) {
        notify(`Résumé indisponible · ${errorText(error)}`);
      } finally {
        summaryRunning.current = false;
        setSummaryLoading(false);
      }
    },
    [
      account,
      excludedAccounts,
      inboxIndex,
      inboxMails,
      mode,
      notify,
      prefs.llm,
      prefs.summary,
      proposeTasks,
      summaryInputs,
    ],
  );

  /**
   * Propose des tâches extraites des mails de la fenêtre configurée. Le LLM n'est
   * sollicité qu'une fois par contenu de fenêtre (signature window+mails), et
   * jamais en démo : pas de réseau, pas de boucle, aucune création automatique.
   */
  const refreshTaskSuggestions = useCallback(async () => {
    const config = prefs.aiTasks;
    if (!config.enabled || !prefs.planningEnabled) {
      taskRun.current = null;
      return;
    }
    if (mode !== "api" || !llmReady(prefs.llm) || taskRunning.current) return;
    const recent = recentMails(summaryInputs(aiMails), config.windowHours);
    if (recent.length === 0) return;
    const signature = `${config.windowHours}:${recent.map((mail) => mail.id).join(",")}`;
    if (taskRun.current === signature) return;
    taskRunning.current = true;
    try {
      const proposed = await suggestTasks({ windowHours: config.windowHours }, prefs.llm, recent);
      taskRun.current = signature;
      if (proposed.length === 0) return;
      proposeTasks(proposed, inboxIndex, "Suggestion IA");
    } finally {
      taskRunning.current = false;
    }
  }, [aiMails, inboxIndex, mode, prefs.aiTasks, prefs.llm, prefs.planningEnabled, proposeTasks, summaryInputs]);

  const refreshSummaryRef = useRef(refreshSummary);
  useEffect(() => {
    refreshSummaryRef.current = refreshSummary;
  }, [refreshSummary]);

  const refreshTaskSuggestionsRef = useRef(refreshTaskSuggestions);
  useEffect(() => {
    refreshTaskSuggestionsRef.current = refreshTaskSuggestions;
  }, [refreshTaskSuggestions]);

  /**
   * Dédup par mail + intitulé + jour : un même rendez-vous ne devient jamais
   * deux suggestions, ni ne double un événement déjà présent à l'agenda.
   */
  const proposeEvents = useCallback(
    (proposed: SummaryEvent[], byId: Map<string, Mail>, label: string) => {
      const key = (mailId: string, title: string, date: string) => `${mailId}:${normalize(title)}:${date}`;
      const known = new Set([
        ...planning.suggestions.map((entry) => key(entry.mailId, entry.proposal, entry.date ?? "")),
        ...planning.events.map((entry) => key(entry.mailId ?? "", entry.title, entry.date)),
      ]);
      for (const event of proposed) {
        const dedup = key(event.mailId ?? "", event.title, event.date);
        if (known.has(dedup)) continue;
        known.add(dedup);
        const mail = event.mailId ? byId.get(event.mailId) : undefined;
        planning.proposeSuggestion(eventSuggestion(event, mail, label));
      }
    },
    [planning],
  );

  /**
   * Propose des rendez-vous extraits des mails de la fenêtre. Même signature de
   * cache que les tâches (fenêtre + mails) : un seul appel par contenu, jamais
   * en démo, et aucune création automatique d'événement.
   */
  const refreshEventSuggestions = useCallback(async () => {
    const config = prefs.aiTasks;
    if (!config.enabled || !config.events || !prefs.calendarEnabled) {
      eventRun.current = null;
      return;
    }
    if (mode !== "api" || !llmReady(prefs.llm) || eventRunning.current) return;
    const recent = recentMails(summaryInputs(aiMails), config.windowHours);
    if (recent.length === 0) return;
    const signature = `${config.windowHours}:${recent.map((mail) => mail.id).join(",")}`;
    if (eventRun.current === signature) return;
    eventRunning.current = true;
    try {
      const proposed = await suggestEvents({ windowHours: config.windowHours }, prefs.llm, recent);
      eventRun.current = signature;
      if (proposed.length === 0) return;
      proposeEvents(proposed, inboxIndex, "Rendez-vous IA");
    } finally {
      eventRunning.current = false;
    }
  }, [
    aiMails,
    inboxIndex,
    mode,
    prefs.aiTasks,
    prefs.calendarEnabled,
    prefs.llm,
    proposeEvents,
    summaryInputs,
  ]);

  const refreshEventSuggestionsRef = useRef(refreshEventSuggestions);
  useEffect(() => {
    refreshEventSuggestionsRef.current = refreshEventSuggestions;
  }, [refreshEventSuggestions]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    summaryRun.current = null;
    void refreshSummaryRef.current();
    const timer = window.setInterval(() => void refreshSummaryRef.current(), SUMMARY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [account, mode, phase, prefs.summary]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshSummaryRef.current();
  }, [inboxMails.length, phase]);

  useEffect(() => {
    taskRun.current = null;
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshTaskSuggestionsRef.current();
    const timer = window.setInterval(() => void refreshTaskSuggestionsRef.current(), SUMMARY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [mode, phase, prefs.aiTasks]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshTaskSuggestionsRef.current();
  }, [inboxMails.length, phase]);

  useEffect(() => {
    eventRun.current = null;
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshEventSuggestionsRef.current();
    const timer = window.setInterval(() => void refreshEventSuggestionsRef.current(), SUMMARY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [mode, phase, prefs.aiTasks, prefs.calendarEnabled]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshEventSuggestionsRef.current();
  }, [inboxMails.length, phase]);

  const resolvedOpenMail = useMemo(
    () => (openMail ? (mails.find((entry) => entry.id === openMail.id) ?? openMail) : null),
    [mails, openMail],
  );
  const openThread = useMemo(
    () => (resolvedOpenMail ? threadOf(mails, resolvedOpenMail) : undefined),
    [mails, resolvedOpenMail],
  );

  const value = useMemo<MailStoreValue>(
    () => ({
      mails,
      account,
      accountById,
      accounts,
      folder,
      folderPath,
      folderOptions,
      mode,
      phase,
      backendError,
      threadsLoading,
      pages,
      hasMore,
      syncing,
      folderStats,
      accountUnread,
      connectOpen,
      removeTarget,
      tasks,
      suggestions,
      summary,
      summaryLoading,
      summaryMails,
      refreshSummary,
      events,
      selectedDate,
      openMail: resolvedOpenMail,
      openThread,
      bodyFetching,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      composeDetached,
      draftSource,
      setAccount,
      setFolder,
      loadMore,
      setTasks,
      setEvents,
      setSelectedDate,
      setComposeDraft,
      setComposeTitle,
      notify,
      dismissNotice,
      toggleStar,
      mailAction,
      moveToInbox,
      restoreMail,
      emptyTrash,
      addSuggestion,
      dismissSuggestion,
      openMessage,
      closeMessage,
      startBlankDraft,
      resumeDraft,
      openComposer,
      resumeCompose,
      minimizeCompose,
      closeCompose,
      detachCompose,
      dockCompose,
      detachClosed,
      replyTo,
      forwardMail,
      sendDraft,
      saveToDrafts,
      retryBackend,
      refreshMailbox: bootstrap,
      useDemo,
      syncFolder,
      searchMails,
      openConnect,
      closeConnect,
      createAccount,
      renameAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
      deleteFolder,
      hiddenFolderOptions,
      hideFolder,
      unhideFolder,
    }),
    [
      mails,
      account,
      accountById,
      accounts,
      folder,
      folderPath,
      folderOptions,
      mode,
      phase,
      backendError,
      threadsLoading,
      pages,
      hasMore,
      syncing,
      folderStats,
      accountUnread,
      connectOpen,
      removeTarget,
      tasks,
      suggestions,
      summary,
      summaryLoading,
      summaryMails,
      refreshSummary,
      events,
      selectedDate,
      resolvedOpenMail,
      openThread,
      bodyFetching,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      composeDetached,
      draftSource,
      setAccount,
      setFolder,
      loadMore,
      notify,
      dismissNotice,
      toggleStar,
      mailAction,
      moveToInbox,
      restoreMail,
      emptyTrash,
      addSuggestion,
      dismissSuggestion,
      openMessage,
      closeMessage,
      startBlankDraft,
      resumeDraft,
      openComposer,
      resumeCompose,
      minimizeCompose,
      closeCompose,
      detachCompose,
      dockCompose,
      detachClosed,
      replyTo,
      forwardMail,
      sendDraft,
      saveToDrafts,
      retryBackend,
      useDemo,
      syncFolder,
      searchMails,
      openConnect,
      closeConnect,
      createAccount,
      renameAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
      deleteFolder,
      hiddenFolderOptions,
      hideFolder,
      unhideFolder,
      bootstrap,
    ],
  );

  return <MailStoreContext.Provider value={value}>{children}</MailStoreContext.Provider>;
}

export function useMailStore() {
  const context = useContext(MailStoreContext);
  if (!context) throw new Error("useMailStore must be used inside <MailStoreProvider>");
  return context;
}
