import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft, emptyDraft, firstRecipient, insertAt } from "@/lib/draft";
import { htmlToText } from "@/lib/rich-text";
import type { NoticeData } from "@/components/ui/notice";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import type { Account } from "@/lib/accounts";
import { MAILS, folderLabel, mailMatches } from "@/lib/mail";
import type { FolderId, Mail } from "@/lib/mail";
import { threadOf } from "@/lib/threads";
import type { Thread } from "@/lib/threads";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { EVENTS, TODAY_ISO } from "@/lib/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import { activeSignature, usePrefs } from "@/lib/prefs";
import { usePlanning } from "@/lib/planning-store";
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
const EVENTS_KEY = "lavande.events.v1";

function loadEvents(): CalendarEvent[] {
  try {
    const raw = window.localStorage.getItem(EVENTS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is CalendarEvent =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as CalendarEvent).id === "string" &&
            typeof (entry as CalendarEvent).date === "string" &&
            typeof (entry as CalendarEvent).title === "string",
        );
      }
    }
  } catch {
    // stockage corrompu : on repart des événements de démonstration
  }
  return EVENTS;
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
  events: CalendarEvent[];
  selectedDate: string;
  openMail: Mail | null;
  openThread: Thread | undefined;
  notices: NoticeData[];
  composeOpen: boolean;
  composeDraft: ComposeDraft | null;
  composeTitle: string;
  composeDetached: boolean;
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
  openMessage: (mail: Mail) => void;
  closeMessage: () => void;
  startBlankDraft: () => void;
  openComposer: () => void;
  resumeCompose: () => void;
  minimizeCompose: () => void;
  closeCompose: () => void;
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
  createAccount: (input: NewAccount) => Promise<void>;
  askRemoveAccount: (account: Account) => void;
  cancelRemoveAccount: () => void;
  confirmRemoveAccount: () => void;
};

const MailStoreContext = createContext<MailStoreValue | null>(null);

export function MailStoreProvider({ children }: { children: React.ReactNode }) {
  const prefs = usePrefs();
  const planning = usePlanning();
  const { tasks, suggestions, setTasks } = planning;
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
  const [events, setEvents] = useState<CalendarEvent[]>(loadEvents);
  const [selectedDate, setSelectedDate] = useState(TODAY_ISO);
  const [openMail, setOpenMail] = useState<Mail | null>(null);
  const [searchResults, setSearchResults] = useState<Mail[]>([]);
  const [notices, setNotices] = useState<NoticeData[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [persistedCompose] = useState(loadPersistedCompose);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(
    persistedCompose?.draft ?? null,
  );
  const [composeTitle, setComposeTitle] = useState(persistedCompose?.title ?? "Nouveau message");
  const [composeDetached, setComposeDetached] = useState(false);
  const composeBus = useRef<ComposeBus | null>(null);
  const composeStateRef = useRef<ComposeState>({ draft: null, title: "Nouveau message", detached: false });
  const lastPostedCompose = useRef("");
  const sendDraftRef = useRef<(draft: ComposeDraft) => void>(() => {});
  const noticeId = useRef(0);

  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    noticeId.current += 1;
    const entry = { id: noticeId.current, message, actionLabel: action?.label, onAction: action?.run };
    setNotices((current) => [...current, entry]);
  }, []);

  const dismissNotice = useCallback(() => setNotices((current) => current.slice(1)), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
    } catch {
      // stockage indisponible : les événements restent en mémoire
    }
  }, [events]);

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

  // Le service pousse un événement après chaque détection IDLE : la liste se
  // rafraîchit sans clic, et sans bloquer l'interface.
  useEffect(() => {
    if (mode !== "api" || typeof EventSource === "undefined" || isComposeWindow()) return;
    let source: EventSource | null = null;
    let closed = false;
    void mailApi.eventsUrl().then((url) => {
      if (closed) return;
      source = new EventSource(url);
      source.addEventListener("mail", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as LiveEvent;
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
  }, [account, mode]);

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

  const folderOptions = useMemo<FolderOption[]>(
    () =>
      mode === "api"
        ? account === ALL_ACCOUNTS
          ? folderOptionsForAll(
              folderRecords,
              accounts.map((entry) => entry.id),
            )
          : optionsOf(folderRecords, account)
        : [
            { id: "inbox" as const, label: folderLabel("inbox"), path: "inbox" },
            { id: "sent" as const, label: folderLabel("sent"), path: "sent" },
            { id: "drafts" as const, label: folderLabel("drafts"), path: "drafts" },
            { id: "archive" as const, label: folderLabel("archive"), path: "archive" },
            { id: "spam" as const, label: folderLabel("spam"), path: "spam" },
            { id: "trash" as const, label: folderLabel("trash"), path: "trash" },
          ],
    [mode, folderRecords, account, accounts],
  );

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

  // Première visite d'un dossier : synchro automatique en arrière-plan, pour ne
  // pas avoir à cliquer sur « Synchroniser ». Une seule fois par portée
  // (compte + dossier) ; revision recharge ensuite fils et compteurs.
  const autoSyncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || isComposeWindow()) return;
    if (targets.length === 0) return;
    const key = targets.map((t) => `${t.accountId}:${t.path}`).sort().join("|");
    if (autoSyncedRef.current.has(key)) return;
    autoSyncedRef.current.add(key);
    let cancelled = false;
    setSyncing(true);
    Promise.all(targets.map((t) => mailApi.sync(t.accountId, t.path)))
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
  }, [mode, phase, targets]);

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
    (mail: Mail) => {
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
      const source = mail.source;
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
        .catch((error: unknown) => notify(`Corps du message indisponible · ${errorText(error)}`));
    },
    [adjustCounts, flagsFor, folderRecords, mode, notify],
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

  const minimizeCompose = useCallback(() => setComposeOpen(false), []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft(null);
  }, []);

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
    const state: ComposeState = { draft: composeDraft, title: composeTitle, detached: composeDetached };
    composeStateRef.current = state;
    persistCompose(composeDraft, composeTitle);
    const json = JSON.stringify(state);
    if (json !== lastPostedCompose.current) {
      lastPostedCompose.current = json;
      composeBus.current?.post({ kind: "state", state });
    }
  }, [composeDraft, composeTitle, composeDetached]);

  const blankDraft = useCallback(
    () =>
      baseDraft(
        account === ALL_ACCOUNTS || !account ? accounts[0]?.id ?? "" : account,
        prefs.pgpEncrypt,
        prefs.pgpSign,
      ),
    [account, accounts, prefs.pgpEncrypt, prefs.pgpSign],
  );

  const startBlankDraft = useCallback(() => {
    setComposeDraft(blankDraft());
    setComposeTitle("Nouveau message");
    setComposeOpen(true);
  }, [blankDraft]);

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
        const quoted = mail.body
          .join("\n")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n");
        const references = [
          ...(mail.references ?? []),
          ...(mail.messageId ? [mail.messageId] : []),
        ];
        setComposeDraft({
          ...baseDraft(mail.account, prefs.pgpEncrypt, prefs.pgpSign, mail.threadId ?? mail.id),
          to: mail.email,
          subject: /^re\s*:/i.test(mail.subject.trim()) ? mail.subject : `Re: ${mail.subject}`,
          body: `\n\n---\nLe ${mail.date ?? mail.time}, ${mail.name} a écrit :\n${quoted}`,
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
    [composeDetached, composeDraft, notify, prefs.pgpEncrypt, prefs.pgpSign],
  );

  const forwardMail = useCallback(
    (mail: Mail) => {
      const start = () => {
        setComposeDraft({
          ...baseDraft(mail.account, prefs.pgpEncrypt, prefs.pgpSign),
          subject: /^tr\s*:/i.test(mail.subject.trim()) ? mail.subject : `Tr: ${mail.subject}`,
          body: `\n\n--- Message transféré ---\nDe : ${mail.name} <${mail.email}>\nDate : ${
            mail.date ?? mail.time
          }\nObjet : ${mail.subject}\n\n${mail.body.join("\n")}`,
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
    [composeDetached, composeDraft, notify, prefs.pgpEncrypt, prefs.pgpSign],
  );

  const sendDraft = useCallback(
    (draft: ComposeDraft) => {
      if (mode === "api") {
        mailApi
          .send(draft.account, sendInputOf(draft, activeSignature(prefs.signatures, draft.account)))
          .then(() => {
            setComposeOpen(false);
            setComposeDraft(null);
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
        tone: sender.tone,
      };
      setMails((current) => [mail, ...current]);
      setComposeOpen(false);
      setComposeDraft(null);
      notify("Message envoyé");
      composeBus.current?.post({ kind: "sent" });
    },
    [accounts, mode, notify, prefs.signatures],
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
    setSyncing(true);
    Promise.all(targets.map((target) => mailApi.sync(target.accountId, target.path)))
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
  }, [account, targets, mode, notify]);

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
      try {
        const result = await mailApi.sync(summary.id, "INBOX");
        const report = result.reports[0];
        notify(
          report
            ? `Compte connecté · ${report.inserted} message${report.inserted > 1 ? "s" : ""} dans INBOX`
            : "Compte connecté",
        );
      } catch (error) {
        notify(`Compte connecté, mais synchro impossible · ${errorText(error)}`);
      }
      setRevision((value) => value + 1);
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
      events,
      selectedDate,
      openMail: resolvedOpenMail,
      openThread,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      composeDetached,
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
      retryBackend,
      refreshMailbox: bootstrap,
      useDemo,
      syncFolder,
      searchMails,
      openConnect,
      closeConnect,
      createAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
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
      events,
      selectedDate,
      resolvedOpenMail,
      openThread,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      composeDetached,
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
      retryBackend,
      useDemo,
      syncFolder,
      searchMails,
      openConnect,
      closeConnect,
      createAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
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
