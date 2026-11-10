import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BatteryFull, Signal, Wifi } from "lucide-react";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { PrefsProvider } from "@/lib/prefs";
import type { Mail } from "@/lib/mail";
import { MAILS } from "@/lib/mail";
import { ALL_ACCOUNTS } from "@/lib/accounts";
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
import { EVENTS, type CalendarEvent } from "@/lib/calendar";
import { SettingsScreen } from "@/screens/settings-screen";
import { MessageScreen } from "@/screens/message-screen";
import { ComposeScreen } from "@/screens/compose-screen";
import { PgpScreen } from "@/screens/pgp-screen";
import { DotPattern, MeshGlow } from "@/components/ui/backdrops";

const ORDER: TabId[] = TABS.map((tab) => tab.id);

export default function App() {
  return (
    <ThemeProvider>
      <PrefsProvider>
        <Stage />
      </PrefsProvider>
    </ThemeProvider>
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
  const [composing, setComposing] = useState(false);
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

  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);

  const index = ORDER.indexOf(tab);
  const last = ORDER.length - 1;

  const toggleStar = useCallback((id: string) => {
    setMails((current) =>
      current.map((mail) => (mail.id === id ? { ...mail, starred: !mail.starred } : mail)),
    );
  }, []);

  const addSuggestion = useCallback((suggestion: MailSuggestion) => {
    setTasks((current) =>
      sortTasks([
        {
          id: "s-" + suggestion.id,
          title: suggestion.proposal,
          meta: "mail · " + suggestion.from,
          state: "todo" as const,
          due: suggestion.due,
          dueTone: suggestion.dueTone,
          description: suggestion.description,
          mailId: suggestion.mailId,
        },
        ...current,
      ]),
    );
    setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id));
  }, []);

  const handleMailAction = useCallback((kind: "delete" | "archive" | "read", mail: Mail) => {
    if (kind === "delete") {
      setMails((current) => current.filter((entry) => entry.id !== mail.id));
      return;
    }
    setMails((current) =>
      current.map((entry) =>
        entry.id !== mail.id
          ? entry
          : kind === "archive"
            ? { ...entry, folder: "archive" as const }
            : { ...entry, unread: !entry.unread },
      ),
    );
  }, []);

  const openMessage = useCallback((mail: Mail) => {
    setOpenMail({ ...mail, unread: false });
    setMails((current) => current.map((item) => (item.id === mail.id ? { ...item, unread: false } : item)));
  }, []);

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

    if (dx < -55 && index < last) setTab(ORDER[index + 1]);
    else if (dx > 55 && index > 0) setTab(ORDER[index - 1]);
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden pt-0 sm:pt-7">
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
              onReply={() => setComposing(true)}
            />
          </div>
          <div className="h-full w-full shrink-0">
            <CalendarScreen events={events} />
          </div>
          <div className="h-full w-full shrink-0">
            <PlanningScreen
              tasks={tasks}
              setTasks={setTasks}
              suggestions={suggestions}
              onAddSuggestion={addSuggestion}
              onDismissSuggestion={(suggestion) =>
                setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id))
              }
              onOpenTask={(task) => setDetail({ task })}
              onOpenSuggestion={(suggestion) =>
                setDetail({
                  task: {
                    id: "sugg-" + suggestion.id,
                    title: suggestion.proposal,
                    meta: "mail · " + suggestion.from,
                    state: "todo",
                    due: suggestion.due,
                    dueTone: suggestion.dueTone,
                    description: suggestion.description,
                    mailId: suggestion.mailId,
                  },
                  suggestion,
                })
              }
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
          onChange={setTab}
          onCompose={() => setComposing(true)}
          onNewTask={() => setTaskDraftOpen(true)}
          onNewEvent={() => setEventDraftOpen(true)}
        />

        <AnimatePresence>
          {openMail && (
            <motion.div
              key="message"
              className="absolute inset-0 z-30 bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <MessageScreen
                mail={openMail}
                onClose={() => setOpenMail(null)}
                onToggleStar={() => toggleStar(openMail.id)}
                onReply={() => {
                  setOpenMail(null);
                  setComposing(true);
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
                  setDetail(null);
                  openMessage(mail);
                }}
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
                onReply={() => setComposing(true)}
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
                  onClose={() => setEventDraftOpen(false)}
                  onCreate={(event) => setEvents((current) => [...current, event])}
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
                  onCreate={(task) => setTasks((current) => createTask(current, task))}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {composing && (
            <motion.div key="compose" className="absolute inset-0 z-[45]" initial={false}>
              <motion.div
                className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setComposing(false)}
              />
              <motion.div
                className="absolute inset-x-0 bottom-0 top-10 overflow-hidden rounded-t-[32px] border-t border-line bg-canvas shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              >
                <ComposeScreen onClose={() => setComposing(false)} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
