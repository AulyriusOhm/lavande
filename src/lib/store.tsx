import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft, emptyDraft, firstRecipient, insertAt } from "@/lib/draft";
import type { NoticeData } from "@/components/ui/notice";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import { MAILS, folderLabel } from "@/lib/mail";
import type { FolderId, Mail } from "@/lib/mail";
import { threadOf } from "@/lib/threads";
import type { Thread } from "@/lib/threads";
import { MAIL_SUGGESTIONS, TASKS, sortTasks, taskFromSuggestion } from "@/lib/tasks";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { EVENTS, TODAY_ISO } from "@/lib/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import { usePrefs } from "@/lib/prefs";

export type MailStoreValue = {
  mails: Mail[];
  account: string;
  folder: FolderId;
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
};

const MailStoreContext = createContext<MailStoreValue | null>(null);

export function MailStoreProvider({ children }: { children: React.ReactNode }) {
  const prefs = usePrefs();
  const [mails, setMails] = useState<Mail[]>(MAILS);
  const [account, setAccount] = useState<string>(ALL_ACCOUNTS);
  const [folder, setFolder] = useState<FolderId>("inbox");
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

  const toggleStar = useCallback((id: string) => {
    setMails((current) =>
      current.map((mail) => (mail.id === id ? { ...mail, starred: !mail.starred } : mail)),
    );
    setOpenMail((current) =>
      current && current.id === id ? { ...current, starred: !current.starred } : current,
    );
  }, []);

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
    [mails, notify],
  );

  const openMessage = useCallback((mail: Mail) => {
    setOpenMail({ ...mail, unread: false });
    setMails((current) => current.map((item) => (item.id === mail.id ? { ...item, unread: false } : item)));
  }, []);

  const closeMessage = useCallback(() => setOpenMail(null), []);

  const moveToInbox = useCallback(
    (mail: Mail) => {
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
    [notify],
  );

  const restoreMail = useCallback(
    (mail: Mail) => {
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
    [notify],
  );

  const minimizeCompose = useCallback(() => setComposeOpen(false), []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft(null);
  }, []);

  const blankDraft = useCallback(
    () => baseDraft(account === ALL_ACCOUNTS ? ACCOUNTS[0].id : account, prefs.pgpEncrypt, prefs.pgpSign),
    [account, prefs.pgpEncrypt, prefs.pgpSign],
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
      setComposeDraft({
        ...baseDraft(mail.account, prefs.pgpEncrypt, prefs.pgpSign, mail.threadId ?? mail.id),
        to: mail.email,
        subject: /^re\s*:/i.test(mail.subject.trim()) ? mail.subject : `Re: ${mail.subject}`,
        body: `\n\n---\nLe ${mail.date ?? mail.time}, ${mail.name} a écrit :\n${quoted}`,
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
      const sender = ACCOUNTS.find((entry) => entry.id === draft.account) ?? ACCOUNTS[0];
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const body = draft.body.split("\n").filter((line) => line.trim() !== "");
      const preview = body.find((line) => line.trim() !== "---" && !line.startsWith(">")) ?? "";
      const mail: Mail = {
        id: `sent-${now.getTime()}`,
        account: sender.id as Mail["account"],
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
    [notify],
  );

  const openThread = useMemo(() => (openMail ? threadOf(mails, openMail) : undefined), [mails, openMail]);

  const value = useMemo<MailStoreValue>(
    () => ({
      mails,
      account,
      folder,
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
    }),
    [
      mails,
      account,
      folder,
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
    ],
  );

  return <MailStoreContext.Provider value={value}>{children}</MailStoreContext.Provider>;
}

export function useMailStore() {
  const context = useContext(MailStoreContext);
  if (!context) throw new Error("useMailStore must be used inside <MailStoreProvider>");
  return context;
}
