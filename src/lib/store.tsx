import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft, emptyDraft, firstRecipient, insertAt } from "@/lib/draft";
import type { NoticeData } from "@/components/ui/notice";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import type { Account } from "@/lib/accounts";
import { MAILS, folderLabel } from "@/lib/mail";
import type { FolderId, Mail } from "@/lib/mail";
import { threadOf } from "@/lib/threads";
import type { Thread } from "@/lib/threads";
import { MAIL_SUGGESTIONS, TASKS, sortTasks, taskFromSuggestion } from "@/lib/tasks";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { EVENTS, TODAY_ISO } from "@/lib/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import { usePrefs } from "@/lib/prefs";
import { mailApi, errorText } from "@/lib/api";
import type { NewAccount } from "@/lib/api";
import {
  folderOptions as optionsOf,
  folderPathOf,
  loadMailbox,
  mailMode,
  messageToMail,
  splitAddresses,
  syncNotice,
  threadToMails,
} from "@/lib/mail-backend";
import type { FolderOption, FolderRecord, MailMode } from "@/lib/mail-backend";

export type BackendPhase = "loading" | "ready" | "offline" | "empty";

export type MailStoreValue = {
  mails: Mail[];
  account: string;
  accountById: (id: string) => Account | undefined;
  accounts: Account[];
  folder: FolderId;
  folderOptions: FolderOption[];
  mode: MailMode;
  phase: BackendPhase;
  backendError: string | null;
  threadsLoading: boolean;
  syncing: boolean;
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
  setAccount: (value: string) => void;
  setFolder: (value: FolderId) => void;
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
  addSuggestion: (suggestion: MailSuggestion) => void;
  dismissSuggestion: (suggestion: MailSuggestion) => void;
  openMessage: (mail: Mail) => void;
  closeMessage: () => void;
  startBlankDraft: () => void;
  openComposer: () => void;
  resumeCompose: () => void;
  minimizeCompose: () => void;
  closeCompose: () => void;
  replyTo: (mail: Mail) => void;
  forwardMail: (mail: Mail) => void;
  sendDraft: (draft: ComposeDraft) => void;
  retryBackend: () => void;
  useDemo: () => void;
  syncFolder: () => void;
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
  const [mode, setMode] = useState<MailMode>(mailMode);
  const [phase, setPhase] = useState<BackendPhase>(() => (mode === "demo" ? "ready" : "loading"));
  const [backendError, setBackendError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>(() => (mode === "demo" ? ACCOUNTS : []));
  const [folderRecords, setFolderRecords] = useState<FolderRecord[]>([]);
  const [mails, setMails] = useState<Mail[]>(() => (mode === "demo" ? MAILS : []));
  const [account, setAccountState] = useState<string>(() => (mode === "demo" ? ALL_ACCOUNTS : ""));
  const [folder, setFolderState] = useState<FolderId>("inbox");
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null);
  const [tasks, setTasks] = useState<Task[]>(() => sortTasks(TASKS));
  const [suggestions, setSuggestions] = useState<MailSuggestion[]>(MAIL_SUGGESTIONS);
  const [events, setEvents] = useState<CalendarEvent[]>(EVENTS);
  const [selectedDate, setSelectedDate] = useState(TODAY_ISO);
  const [openMail, setOpenMail] = useState<Mail | null>(null);
  const [notices, setNotices] = useState<NoticeData[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const [composeTitle, setComposeTitle] = useState("Nouveau message");
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
      setAccountState((current) =>
        loaded.some((entry) => entry.id === current) ? current : loaded[0].id,
      );
      setPhase("ready");
    } catch (error) {
      setBackendError(errorText(error));
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    if (mode === "api") void bootstrap();
  }, [bootstrap, mode]);

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
    setPhase("ready");
    setBackendError(null);
    setConnectOpen(false);
    setRemoveTarget(null);
  }, []);

  const currentPath = useMemo(
    () => folderPathOf(folderRecords, account, folder),
    [folderRecords, account, folder],
  );

  useEffect(() => {
    if (mode !== "api" || phase !== "ready") return;
    if (!account || !currentPath) {
      setMails([]);
      return;
    }
    let cancelled = false;
    setThreadsLoading(true);
    mailApi
      .threads(account, currentPath)
      .then((threads) => {
        if (cancelled) return;
        setMails(threads.flatMap((thread) => threadToMails(thread, folderRecords, folder)));
      })
      .catch((error: unknown) => {
        if (!cancelled) notify(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setThreadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, phase, account, currentPath, folder, folderRecords, revision, notify]);

  const folderOptions = useMemo<FolderOption[]>(
    () =>
      mode === "api"
        ? optionsOf(folderRecords, account)
        : [
            { id: "inbox" as const, label: folderLabel("inbox"), path: "inbox" },
            { id: "sent" as const, label: folderLabel("sent"), path: "sent" },
            { id: "drafts" as const, label: folderLabel("drafts"), path: "drafts" },
            { id: "archive" as const, label: folderLabel("archive"), path: "archive" },
            { id: "spam" as const, label: folderLabel("spam"), path: "spam" },
            { id: "trash" as const, label: folderLabel("trash"), path: "trash" },
          ],
    [mode, folderRecords, account],
  );

  const setAccount = useCallback(
    (value: string) => {
      setAccountState(value);
      if (mode !== "api") return;
      setFolderState((current) =>
        folderPathOf(folderRecords, value, current) ? current : "inbox",
      );
    },
    [folderRecords, mode],
  );

  const setFolder = useCallback((value: FolderId) => setFolderState(value), []);

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
      const mail = mails.find((entry) => entry.id === id);
      setMails((current) =>
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
        notify(errorText(error));
      });
    },
    [flagsFor, mails, mode, notify],
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
      mailApi
        .move(source.accountId, { from_path: source.folderPath, uid: source.uid, to_path: target })
        .then(() => {
          notify(message ?? `Message déplacé vers ${folderLabel(role)}`);
          setRevision((value) => value + 1);
        })
        .catch((error: unknown) => {
          setMails((current) =>
            current.some((entry) => entry.id === mail.id) ? current : [...current, mail],
          );
          notify(errorText(error));
        });
    },
    [folderRecords, notify],
  );

  const addSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      const id = "s-" + suggestion.id;
      const index = suggestions.findIndex((entry) => entry.id === suggestion.id);
      setTasks((current) =>
        current.some((task) => task.id === id)
          ? current
          : sortTasks([taskFromSuggestion(suggestion, id), ...current]),
      );
      setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id));
      notify("Tâche ajoutée à la planification", {
        label: "Annuler",
        run: () => {
          setTasks((current) => current.filter((task) => task.id !== id));
          setSuggestions((current) =>
            current.some((entry) => entry.id === suggestion.id)
              ? current
              : insertAt(current, index, suggestion),
          );
        },
      });
    },
    [notify, suggestions],
  );

  const dismissSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      const index = suggestions.findIndex((entry) => entry.id === suggestion.id);
      setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id));
      notify("Suggestion masquée", {
        label: "Annuler",
        run: () =>
          setSuggestions((current) =>
            current.some((entry) => entry.id === suggestion.id)
              ? current
              : insertAt(current, index, suggestion),
          ),
      });
    },
    [notify, suggestions],
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
          flagsFor(mail, { unread: !mail.unread, starred: mail.starred }).catch((error: unknown) =>
            notify(errorText(error)),
          );
        }
        return;
      }

      if (mode === "api") {
        if (kind === "delete" && mail.folder === "trash") {
          notify("Le service local ne supprime pas définitivement : il déplace les messages.");
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
    [flagsFor, mails, mode, moveTo, notify],
  );

  const openMessage = useCallback(
    (mail: Mail) => {
      setOpenMail({ ...mail, unread: false });
      setMails((current) => current.map((item) => (item.id === mail.id ? { ...item, unread: false } : item)));
      if (mode !== "api" || !mail.source) return;
      if (mail.unread) {
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
        })
        .catch((error: unknown) => notify(`Corps du message indisponible · ${errorText(error)}`));
    },
    [flagsFor, folderRecords, mode, notify],
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

  const minimizeCompose = useCallback(() => setComposeOpen(false), []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft(null);
  }, []);

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
    if (composeOpen) return;
    if (composeDraft && !emptyDraft(composeDraft)) {
      notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: startBlankDraft });
      return;
    }
    startBlankDraft();
  }, [composeDraft, composeOpen, notify, startBlankDraft]);

  const resumeCompose = useCallback(() => setComposeOpen(true), []);

  const replyTo = useCallback(
    (mail: Mail) => {
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
    },
    [prefs.pgpEncrypt, prefs.pgpSign],
  );

  const forwardMail = useCallback(
    (mail: Mail) => {
      setComposeDraft({
        ...baseDraft(mail.account, prefs.pgpEncrypt, prefs.pgpSign),
        subject: /^tr\s*:/i.test(mail.subject.trim()) ? mail.subject : `Tr: ${mail.subject}`,
        body: `\n\n--- Message transféré ---\nDe : ${mail.name} <${mail.email}>\nDate : ${
          mail.date ?? mail.time
        }\nObjet : ${mail.subject}\n\n${mail.body.join("\n")}`,
      });
      setComposeTitle("Transférer");
      setComposeOpen(true);
    },
    [prefs.pgpEncrypt, prefs.pgpSign],
  );

  const sendDraft = useCallback(
    (draft: ComposeDraft) => {
      if (mode === "api") {
        const recipients = (value: string) =>
          splitAddresses(value).map((email) => ({ name: null, email }));
        mailApi
          .send(draft.account, {
            to: recipients(draft.to),
            cc: recipients(draft.cc),
            bcc: recipients(draft.cci),
            subject: draft.subject.trim() || "(sans objet)",
            text: draft.body,
            ...(draft.inReplyTo ? { in_reply_to: draft.inReplyTo } : {}),
            ...(draft.references?.length ? { references: draft.references } : {}),
          })
          .then(() => {
            setComposeOpen(false);
            setComposeDraft(null);
            notify("Message envoyé");
            setRevision((value) => value + 1);
          })
          .catch((error: unknown) => notify(`Envoi impossible · ${errorText(error)}`));
        return;
      }

      const sender = accounts.find((entry) => entry.id === draft.account) ?? accounts[0];
      if (!sender) return;
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const body = draft.body.split("\n").filter((line) => line.trim() !== "");
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
    },
    [accounts, mode, notify],
  );

  const syncFolder = useCallback(() => {
    if (mode !== "api") {
      notify("Mode démo : la synchronisation est simulée.");
      return;
    }
    if (!account || !currentPath) {
      notify("Choisis un dossier à synchroniser.");
      return;
    }
    setSyncing(true);
    mailApi
      .sync(account, currentPath)
      .then((result) => {
        notify(syncNotice(result.reports));
        setRevision((value) => value + 1);
      })
      .catch((error: unknown) => notify(`Synchro impossible · ${errorText(error)}`))
      .finally(() => setSyncing(false));
  }, [account, currentPath, mode, notify]);

  const openConnect = useCallback(() => setConnectOpen(true), []);
  const closeConnect = useCallback(() => setConnectOpen(false), []);

  const createAccount = useCallback(
    async (input: NewAccount) => {
      const summary = await mailApi.createAccount(input);
      const { accounts: loaded, folders: records } = await loadMailbox();
      setAccounts(loaded);
      setFolderRecords(records);
      setAccountState(summary.id);
      setFolderState("inbox");
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
        await bootstrap();
      })
      .catch((error: unknown) => notify(errorText(error)));
  }, [bootstrap, notify, removeTarget]);

  const openThread = useMemo(() => (openMail ? threadOf(mails, openMail) : undefined), [mails, openMail]);

  const value = useMemo<MailStoreValue>(
    () => ({
      mails,
      account,
      accountById,
      accounts,
      folder,
      folderOptions,
      mode,
      phase,
      backendError,
      threadsLoading,
      syncing,
      connectOpen,
      removeTarget,
      tasks,
      suggestions,
      events,
      selectedDate,
      openMail,
      openThread,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      setAccount,
      setFolder,
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
      addSuggestion,
      dismissSuggestion,
      openMessage,
      closeMessage,
      startBlankDraft,
      openComposer,
      resumeCompose,
      minimizeCompose,
      closeCompose,
      replyTo,
      forwardMail,
      sendDraft,
      retryBackend,
      useDemo,
      syncFolder,
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
      folderOptions,
      mode,
      phase,
      backendError,
      threadsLoading,
      syncing,
      connectOpen,
      removeTarget,
      tasks,
      suggestions,
      events,
      selectedDate,
      openMail,
      openThread,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      setAccount,
      setFolder,
      notify,
      dismissNotice,
      toggleStar,
      mailAction,
      moveToInbox,
      restoreMail,
      addSuggestion,
      dismissSuggestion,
      openMessage,
      closeMessage,
      startBlankDraft,
      openComposer,
      resumeCompose,
      minimizeCompose,
      closeCompose,
      replyTo,
      forwardMail,
      sendDraft,
      retryBackend,
      useDemo,
      syncFolder,
      openConnect,
      closeConnect,
      createAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
    ],
  );

  return <MailStoreContext.Provider value={value}>{children}</MailStoreContext.Provider>;
}

export function useMailStore() {
  const context = useContext(MailStoreContext);
  if (!context) throw new Error("useMailStore must be used inside <MailStoreProvider>");
  return context;
}
