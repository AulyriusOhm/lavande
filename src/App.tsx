import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { BatteryFull, PenLine, Signal, Wifi } from "lucide-react";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import type { Mail } from "@/lib/mail";
import { MAILS, folderLabel } from "@/lib/mail";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { MAIL_SUGGESTIONS, TASKS, sortTasks } from "@/lib/tasks";
import type { FolderId } from "@/lib/mail";
import { cn } from "@/lib/utils";
import { Dock, TABS, type TabId } from "@/components/dock";
import { AccountSwitchSheet, InboxScreen, MailboxSheet } from "@/screens/inbox-screen";
import { SearchScreen } from "@/screens/search-screen";
import { CalendarScreen } from "@/screens/calendar-screen";
import { McpScreen } from "@/screens/mcp-screen";
import { PlanningScreen } from "@/screens/planning-screen";
import { TaskScreen } from "@/screens/task-screen";
import { NewTaskSheet, createTask } from "@/screens/new-task-sheet";
import { NewEventSheet } from "@/screens/new-event-sheet";
import { EVENTS, TODAY_ISO, type CalendarEvent } from "@/lib/calendar";
import { SettingsScreen } from "@/screens/settings-screen";
import { MessageScreen } from "@/screens/message-screen";
import { ComposeScreen, type ComposeDraft } from "@/screens/compose-screen";
import { PgpScreen } from "@/screens/pgp-screen";
import { DotPattern, MeshGlow } from "@/components/ui/backdrops";
import { Notice, type NoticeData } from "@/components/ui/notice";

const ORDER: TabId[] = TABS.map((tab) => tab.id);
const OVERLAY_STATE = { lavandeOverlay: true };

function insertAt<T>(list: T[], index: number, item: T) {
  const at = index < 0 ? list.length : index;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

function firstRecipient(value: string) {
  return value.split(/[\s,;]+/).filter(Boolean)[0] ?? "";
}

function emptyDraft(draft: ComposeDraft) {
  return !draft.to.trim() && !draft.cc.trim() && !draft.cci.trim() && !draft.subject.trim() && !draft.body.trim();
}

function baseDraft(account: string, pgpEncrypt: boolean, pgpSign: boolean): ComposeDraft {
  return { to: "", cc: "", cci: "", subject: "", body: "", account, pgpEncrypt, pgpSign };
}

function suggestionTask(suggestion: MailSuggestion, id: string): Task {
  return {
    id,
    title: suggestion.proposal,
    meta: "mail · " + suggestion.from,
    state: "todo",
    due: suggestion.due,
    dueTone: suggestion.dueTone,
    description: suggestion.description,
    mailId: suggestion.mailId,
  };
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <PrefsProvider>
          <Stage />
        </PrefsProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}

function Stage() {
  const { brand } = useTheme();

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden bg-canvas">
      <div className="absolute inset-0 hidden sm:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,var(--accent-soft),transparent_60%)]" />
        <MeshGlow />
        <DotPattern className="text-accent opacity-[0.07]" size={22} radius={1} />
      </div>

      <div className="relative h-full w-full overflow-hidden bg-canvas sm:h-[838px] sm:max-h-[84vh] sm:w-[392px] sm:rounded-[46px] sm:border-[9px] sm:border-[#191322] sm:shadow-[0_40px_100px_-30px_var(--accent),0_0_0_1px_rgba(0,0,0,0.05)]">
        <StatusBar />
        <PhoneApp />
      </div>

      <p className="pointer-events-none hidden shrink-0 text-[11.5px] font-semibold tracking-wide text-ink-muted sm:block">
        {brand} · maquette mobile · glisse horizontalement
      </p>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 hidden items-center justify-between px-7 pt-2.5 text-ink sm:flex">
      <span className="text-[11.5px] font-bold tracking-tight">09:41</span>
      <div className="flex items-center gap-1.5">
        <Signal className="size-3.5" strokeWidth={2.6} />
        <Wifi className="size-3.5" strokeWidth={2.6} />
        <BatteryFull className="size-4" strokeWidth={2.2} />
      </div>
    </div>
  );
}

function PhoneApp() {
  const [tab, setTab] = useState<TabId>(
    () => ORDER.find((id) => id === window.location.hash.slice(1)) ?? "inbox",
  );
  const [mails, setMails] = useState<Mail[]>(MAILS);
  const [account, setAccount] = useState<string>(ALL_ACCOUNTS);
  const [openMail, setOpenMail] = useState<Mail | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const [composeTitle, setComposeTitle] = useState("Nouveau message");
  const [selectedDate, setSelectedDate] = useState(TODAY_ISO);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pgpOpen, setPgpOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>(() => sortTasks(TASKS));
  const [suggestions, setSuggestions] = useState<MailSuggestion[]>(MAIL_SUGGESTIONS);
  const [detail, setDetail] = useState<{ task: Task; suggestion?: MailSuggestion } | null>(null);
  const [taskDraftOpen, setTaskDraftOpen] = useState(false);
  const [eventDraftOpen, setEventDraftOpen] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>(EVENTS);
  const [folder, setFolder] = useState<FolderId>("inbox");
  const [notices, setNotices] = useState<NoticeData[]>([]);
  const [movingTask, setMovingTask] = useState<Task | null>(null);

  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);

  const index = ORDER.indexOf(tab);
  const last = ORDER.length - 1;
  const prefs = usePrefs();
  const noticeId = useRef(0);

  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    noticeId.current += 1;
    const entry = { id: noticeId.current, message, actionLabel: action?.label, onAction: action?.run };
    setNotices((current) => [...current, entry]);
  }, []);

  const dismissNotice = useCallback(() => setNotices((current) => current.slice(1)), []);

  const changeTab = useCallback((next: TabId) => {
    setTab(next);
    setMovingTask(null);
  }, []);

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
          : sortTasks([suggestionTask(suggestion, id), ...current]),
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

  const handleMailAction = useCallback(
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

  const replyTo = useCallback(
    (mail: Mail) => {
      const quoted = mail.body
        .join("\n")
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
      setComposeDraft({
        ...baseDraft(mail.account, prefs.pgpEncrypt, prefs.pgpSign),
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

  const layers: [boolean, () => void][] = [
    [composeOpen, minimizeCompose],
    [eventDraftOpen, () => setEventDraftOpen(false)],
    [taskDraftOpen, () => setTaskDraftOpen(false)],
    [accountsOpen, () => setAccountsOpen(false)],
    [foldersOpen, () => setFoldersOpen(false)],
    [Boolean(movingTask), () => setMovingTask(null)],
    [Boolean(openMail), () => setOpenMail(null)],
    [Boolean(detail), () => setDetail(null)],
    [pgpOpen, () => setPgpOpen(false)],
    [mcpOpen, () => setMcpOpen(false)],
    [searchOpen, () => setSearchOpen(false)],
  ];
  const depth = layers.filter(([open]) => open).length;
  const layerStack = useRef(layers);
  layerStack.current = layers;
  const depthRef = useRef(depth);
  depthRef.current = depth;
  const sentinel = useRef(false);

  useEffect(() => {
    const closeTop = () => layerStack.current.find(([open]) => open)?.[1]();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || depthRef.current === 0) return;
      event.preventDefault();
      closeTop();
    };

    const onPopState = () => {
      if (depthRef.current === 0) return;
      closeTop();
      if (depthRef.current > 1) window.history.pushState(OVERLAY_STATE, "");
      else sentinel.current = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (depth === 0) {
      if (!sentinel.current) return;
      sentinel.current = false;
      window.history.back();
      return;
    }
    if (sentinel.current) return;
    sentinel.current = true;
    window.history.pushState(OVERLAY_STATE, "");
  }, [depth]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-swipe]")) return;
    gesture.current = { x: event.clientX, y: event.clientY, axis: null };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = gesture.current;
    if (!state) return;

    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;

    if (!state.axis) {
      if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) {
        if (Math.abs(dy) > 10) state.axis = "y";
        return;
      }
      state.axis = "x";
      setDragging(true);
    }

    if (state.axis !== "x") return;

    const blocking = (index === 0 && dx > 0) || (index === last && dx < 0);
    setDragX(blocking ? dx * 0.25 : dx);
  };

  const endGesture = (event: React.PointerEvent) => {
    const state = gesture.current;
    gesture.current = null;
    setDragging(false);

    if (!state || state.axis !== "x") {
      setDragX(0);
      return;
    }

    const dx = event.clientX - state.x;
    setDragX(0);

    if (dx < -55 && index < last) changeTab(ORDER[index + 1]);
    else if (dx > 55 && index > 0) changeTab(ORDER[index - 1]);
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden pt-[env(safe-area-inset-top,0px)] sm:pt-7">
      <div
        className="relative flex-1 overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        style={{ touchAction: "pan-y" }}
      >
        <div
          className={cn(
            "flex h-full w-full",
            !dragging && "transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          )}
          style={{ transform: `translate3d(calc(${-index * 100}% + ${dragX}px), 0, 0)` }}
        >
          <div className="h-full w-full shrink-0">
            <InboxScreen
              mails={mails}
              account={account}
              folder={folder}
              onOpenAccounts={() => setAccountsOpen(true)}
              onOpenFolders={() => setFoldersOpen(true)}
              onOpen={openMessage}
              onToggleStar={toggleStar}
              onSearch={() => setSearchOpen(true)}
              onMailAction={handleMailAction}
              onReply={replyTo}
              onNotSpam={moveToInbox}
              onRestore={restoreMail}
            />
          </div>
          <div className="h-full w-full shrink-0">
            <CalendarScreen
              events={events}
              availableMailIds={new Set(mails.map((mail) => mail.id))}
              onNewEvent={(date) => {
                if (date) setSelectedDate(date);
                setEventDraftOpen(true);
              }}
              onOpenMail={(event) => {
                const mail = mails.find((entry) => entry.id === event.mailId);
                if (mail) openMessage(mail);
              }}
              onSelectedDateChange={setSelectedDate}
            />
          </div>
          <div className="h-full w-full shrink-0">
            <PlanningScreen
              tasks={tasks}
              setTasks={setTasks}
              suggestions={suggestions}
              onAddSuggestion={addSuggestion}
              onDismissSuggestion={dismissSuggestion}
              onOpenTask={(task) => setDetail({ task })}
              onOpenSuggestion={(suggestion) =>
                setDetail({
                  task: suggestionTask(suggestion, "sugg-" + suggestion.id),
                  suggestion,
                })
              }
              onNewTask={() => setTaskDraftOpen(true)}
              movingTask={movingTask}
              onMovingChange={setMovingTask}
            />
          </div>
          <div className="h-full w-full shrink-0">
            <SettingsScreen
              mails={mails}
              account={account}
              onOpenAccounts={() => setAccountsOpen(true)}
              onOpenPgp={() => setPgpOpen(true)}
              onOpenMcp={() => setMcpOpen(true)}
            />
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 bg-gradient-to-t from-canvas via-canvas/80 to-transparent" />

        <Dock
          active={tab}
          onChange={changeTab}
          onCompose={openComposer}
          onNewTask={() => setTaskDraftOpen(true)}
          onNewEvent={() => setEventDraftOpen(true)}
        />

        {composeDraft && !composeOpen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+9.5rem)] z-[44] flex justify-center px-4">
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[11.5px] font-bold text-accent-ink glass shadow-[0_14px_34px_-20px_var(--accent)] transition-transform duration-200 active:scale-95"
            >
              <PenLine className="size-3.5" strokeWidth={2.4} />
              Reprendre le brouillon
            </button>
          </div>
        )}

        <AnimatePresence>
          {openMail && (
            <motion.div
              key="message"
              className="absolute inset-0 z-[36] bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <MessageScreen
                mail={openMail}
                onClose={() => setOpenMail(null)}
                onToggleStar={() => toggleStar(openMail.id)}
                onReply={replyTo}
                onForward={forwardMail}
                onArchive={(mail) => {
                  handleMailAction("archive", mail);
                  setOpenMail(null);
                }}
                onDelete={(mail) => {
                  handleMailAction("delete", mail);
                  setOpenMail(null);
                }}
                onNotSpam={(mail) => {
                  moveToInbox(mail);
                  setOpenMail(null);
                }}
                onRestore={(mail) => {
                  restoreMail(mail);
                  setOpenMail(null);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {pgpOpen && (
            <motion.div
              key="pgp"
              className="absolute inset-0 z-[32] bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <PgpScreen onClose={() => setPgpOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {detail && (
            <motion.div
              key="task"
              className="absolute inset-0 z-[34] bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <TaskScreen
                task={detail.task}
                suggestion={Boolean(detail.suggestion)}
                mail={mails.find((mail) => mail.id === detail.task.mailId) ?? null}
                onClose={() => setDetail(null)}
                onAdd={() => {
                  if (detail.suggestion) addSuggestion(detail.suggestion);
                  setDetail(null);
                }}
                onChangeState={(state) => {
                  setTasks((current) =>
                    sortTasks(current.map((task) => (task.id === detail.task.id ? { ...task, state } : task))),
                  );
                  setDetail((current) => (current ? { ...current, task: { ...current.task, state } } : current));
                }}
                onToggleSubtask={(index) => {
                  const toggle = (task: Task): Task => ({
                    ...task,
                    subtasks: (task.subtasks ?? []).map((subtask, position) =>
                      position === index ? { ...subtask, done: !subtask.done } : subtask,
                    ),
                  });
                  setTasks((current) =>
                    current.map((task) => (task.id === detail.task.id ? toggle(task) : task)),
                  );
                  setDetail((current) => (current ? { task: toggle(current.task), suggestion: current.suggestion } : current));
                }}
                onOpenMail={() => {
                  const mail = mails.find((entry) => entry.id === detail.task.mailId);
                  if (!mail) return;
                  openMessage(mail);
                }}
                onEdit={
                  detail.suggestion
                    ? undefined
                    : (next) => {
                        setTasks((current) =>
                          sortTasks(current.map((task) => (task.id === next.id ? next : task))),
                        );
                        setDetail((current) => (current ? { ...current, task: next } : current));
                      }
                }
                onDelete={
                  detail.suggestion
                    ? undefined
                    : () => {
                        const removed = detail.task;
                        const at = tasks.findIndex((task) => task.id === removed.id);
                        setTasks((current) => current.filter((task) => task.id !== removed.id));
                        setDetail(null);
                        notify("Tâche supprimée", {
                          label: "Annuler",
                          run: () =>
                            setTasks((current) =>
                              current.some((task) => task.id === removed.id)
                                ? current
                                : insertAt(current, at, removed),
                            ),
                        });
                      }
                }
              />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {mcpOpen && (
            <motion.div
              key="mcp"
              className="absolute inset-0 z-[33] bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <McpScreen onClose={() => setMcpOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {searchOpen && (
            <motion.div
              key="search"
              className="absolute inset-0 z-30 bg-canvas"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                aria-label="Fermer la recherche"
                className="absolute top-3 right-4 z-10 rounded-full bg-surface px-3 py-1.5 text-[11.5px] font-bold text-ink-soft shadow-sm"
              >
                Fermer
              </button>
              <SearchScreen
                mails={mails}
                onOpen={openMessage}
                onToggleStar={toggleStar}
                onMailAction={handleMailAction}
                onReply={replyTo}
                onNotSpam={moveToInbox}
                onRestore={restoreMail}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {accountsOpen && (
            <motion.div key="accounts" className="absolute inset-0 z-40" initial={false}>
              <motion.div
                className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setAccountsOpen(false)}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 max-h-[70%] overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              >
                <AccountSwitchSheet
                  mails={mails}
                  active={account}
                  onSelect={setAccount}
                  onClose={() => setAccountsOpen(false)}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {foldersOpen && (
            <motion.div key="folders" className="absolute inset-0 z-40" initial={false}>
              <motion.div
                className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setFoldersOpen(false)}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 max-h-[70%] overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              >
                <MailboxSheet
                  mails={mails}
                  account={account}
                  folder={folder}
                  onSelect={setFolder}
                  onClose={() => setFoldersOpen(false)}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {eventDraftOpen && (
            <motion.div key="newevent" className="absolute inset-0 z-[45]" initial={false}>
              <motion.div
                className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setEventDraftOpen(false)}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 top-16 overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              >
                <NewEventSheet
                  initialDate={selectedDate}
                  events={events}
                  onClose={() => setEventDraftOpen(false)}
                  onCreate={(event) => {
                    setEvents((current) => [...current, event]);
                    notify("Rendez-vous créé");
                  }}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {taskDraftOpen && (
            <motion.div key="newtask" className="absolute inset-0 z-[45]" initial={false}>
              <motion.div
                className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setTaskDraftOpen(false)}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 top-16 overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              >
                <NewTaskSheet
                  onClose={() => setTaskDraftOpen(false)}
                  onCreate={(task) => {
                    setTasks((current) => createTask(current, task));
                    notify("Tâche créée");
                  }}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {composeOpen && (
            <motion.div key="compose" className="absolute inset-0 z-[45]" initial={false}>
              <motion.div
                className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={minimizeCompose}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 top-10 overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              >
                <ComposeScreen
                  title={composeTitle}
                  initialDraft={composeDraft ?? undefined}
                  onDraftChange={setComposeDraft}
                  onSend={sendDraft}
                  onMinimize={minimizeCompose}
                  onClose={closeCompose}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Notice notice={notices[0] ?? null} onClose={dismissNotice} />
    </div>
  );
}
