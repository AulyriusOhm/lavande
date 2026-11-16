import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { BatteryFull, PenLine, Signal, Wifi } from "lucide-react";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { sortTasks, taskFromSuggestion } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { insertAt } from "@/lib/draft";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { Dock, TABS, type TabId } from "@/components/dock";
import { AccountSwitchSheet, InboxScreen as InboxView, MailboxSheet } from "@/screens/inbox-screen";
import { SearchScreen } from "@/screens/search-screen";
import { CalendarScreen as CalendarView } from "@/screens/calendar-screen";
import { McpApprovalHost, McpScreen } from "@/screens/mcp-screen";
import { PlanningScreen as PlanningView } from "@/screens/planning-screen";
import { TaskScreen } from "@/screens/task-screen";
import { NewTaskSheet, createTask } from "@/screens/new-task-sheet";
import { NewEventSheet, type NewEventDraft } from "@/screens/new-event-sheet";
import { SettingsScreen as SettingsView } from "@/screens/settings-screen";
import { MessageScreen } from "@/screens/message-screen";
import { ComposeScreen } from "@/screens/compose-screen";
import { PgpScreen } from "@/screens/pgp-screen";
import { DotPattern, MeshGlow } from "@/components/ui/backdrops";
import { Notice } from "@/components/ui/notice";
import type { CalendarEvent } from "@/lib/calendar";
import { useCalendars, isExternalCalendar } from "@/lib/calendars";
import { externalCalendarEvents, useExternalCalendarRefresh, useGoogleCalendarAutoAttach } from "@/lib/ics";
import { useWidgetAgendaSync } from "@/lib/background-sync";
import { shellLayout } from "@/lib/native";
import { AccountRemoveDialog, BackendBanner, BackendLoading, ReadOnlyBanner } from "@/components/backend-status";
import { ConnectScreen } from "@/screens/connect-screen";
import { useShortcuts } from "@/lib/shortcuts";
import { appShortcuts, type MailNavigation } from "@/lib/app-shortcuts";
import { ShortcutsOverlay } from "@/components/shortcuts-overlay";
import { useExternalLinks } from "@/lib/open-external";

const InboxScreen = memo(InboxView);
const CalendarScreen = memo(CalendarView);
const PlanningScreen = memo(PlanningView);
const SettingsScreen = memo(SettingsView);
const DesktopShell = lazy(() =>
  import("@/desktop/desktop-shell").then((module) => ({ default: module.DesktopApp })),
);

const OVERLAY_STATE = { lavandeOverlay: true };

export default function App() {
  const layout = shellLayout();

  useExternalLinks();

  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <PrefsProvider>
          <PlanningProvider>
            <MailStoreProvider>
              <Suspense fallback={<div className="h-full w-full bg-canvas" />}>
                {layout === "desktop" ? (
                  <DesktopShell />
                ) : layout === "native" ? (
                  <NativeShell />
                ) : (
                  <Stage />
                )}
              </Suspense>
            </MailStoreProvider>
          </PlanningProvider>
        </PrefsProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}

function NativeShell() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas native-shell">
      <PhoneApp native />
    </div>
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

      {import.meta.env.VITE_DISTRIBUTION === "1" ? null : (
        <p className="pointer-events-none hidden shrink-0 text-[11.5px] font-semibold tracking-wide text-ink-muted sm:block">
          {brand} · maquette mobile · glisse horizontalement
        </p>
      )}
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

function PhoneApp({ native }: { native?: boolean }) {
  const prefs = usePrefs();
  const { calendarEnabled, planningEnabled } = prefs;
  const {
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
    composeSending,
    composeSendError,
    resumeCompose,
    setAccount,
    setFolder,
    setTasks,
    setEvents,
    setSelectedDate,
    setComposeDraft,
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
    bodyFetching,
    resumeDraft,
    openComposer,
    minimizeCompose,
    closeCompose,
    replyTo,
    forwardMail,
    sendDraft,
    mode,
    readOnly,
    phase,
    connectOpen,
    closeConnect,
    removeTarget,
    cancelRemoveAccount,
  } = useMailStore();
  const order = useMemo<TabId[]>(
    () =>
      TABS.filter((tab) =>
        tab.id === "calendar" ? calendarEnabled : tab.id === "planning" ? planningEnabled : true,
      ).map((tab) => tab.id),
    [calendarEnabled, planningEnabled],
  );

  const [tab, setTab] = useState<TabId>(
    () => order.find((id) => id === window.location.hash.slice(1)) ?? "inbox",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [pgpOpen, setPgpOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [detail, setDetail] = useState<{ task: Task; suggestion?: MailSuggestion } | null>(null);
  const [taskDraftOpen, setTaskDraftOpen] = useState(false);
  const [eventDraftOpen, setEventDraftOpen] = useState(false);
  const [eventDraft, setEventDraft] = useState<NewEventDraft | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [movingTask, setMovingTask] = useState<Task | null>(null);

  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
  const mailNav = useRef<MailNavigation | null>(null);

  const index = Math.max(order.indexOf(tab), 0);
  const last = order.length - 1;


  useEffect(() => {
    if (!order.includes(tab)) setTab("inbox");
  }, [order, tab]);

  const closeEventDraft = useCallback(() => {
    setEventDraftOpen(false);
    setEventDraft(null);
  }, []);

  const layers: [boolean, () => void][] = [
    [helpOpen, () => setHelpOpen(false)],
    [Boolean(removeTarget), cancelRemoveAccount],
    [connectOpen, closeConnect],
    [composeOpen, minimizeCompose],
    [eventDraftOpen, () => closeEventDraft()],
    [taskDraftOpen, () => setTaskDraftOpen(false)],
    [accountsOpen, () => setAccountsOpen(false)],
    [foldersOpen, () => setFoldersOpen(false)],
    [Boolean(movingTask), () => setMovingTask(null)],
    [Boolean(openMail), () => closeMessage()],
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

  const changeTab = useCallback((next: TabId) => {
    setTab(next);
    setMovingTask(null);
  }, []);

  const openAccounts = useCallback(() => setAccountsOpen(true), []);
  const openFolders = useCallback(() => setFoldersOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const openPgp = useCallback(() => setPgpOpen(true), []);
  const openMcp = useCallback(() => setMcpOpen(true), []);
  const openTaskDraft = useCallback(() => {
    if (readOnly) return;
    setTaskDraftOpen(true);
  }, [readOnly]);
  const openTask = useCallback((task: Task) => setDetail({ task }), []);
  const openSuggestion = useCallback(
    (suggestion: MailSuggestion) =>
      setDetail({ task: taskFromSuggestion(suggestion, "sugg-" + suggestion.id), suggestion }),
    [],
  );
  const openEventDraft = useCallback(
    (init?: string | NewEventDraft) => {
      if (readOnly) return;
      if (typeof init === "string") {
        setSelectedDate(init);
        setEventDraft(null);
      } else {
        if (init?.date) setSelectedDate(init.date);
        setEventDraft(init ?? null);
      }
      setEventDraftOpen(true);
    },
    [readOnly, setSelectedDate],
  );
  const openMailFromEvent = useCallback(
    (event: CalendarEvent) => {
      const mail = mails.find((entry) => entry.id === event.mailId);
      if (mail) openMessage(mail);
    },
    [mails, openMessage],
  );
  const availableMailIds = useMemo(() => new Set(mails.map((mail) => mail.id)), [mails]);

  const [calendars] = useCalendars();
  const { ics } = useExternalCalendarRefresh(calendars, notify);
  const externalEvents = useMemo(() => externalCalendarEvents(ics, calendars), [ics, calendars]);
  const sourceCount = useMemo(() => calendars.filter(isExternalCalendar).length, [calendars]);

  const widgetEvents = useMemo(() => [...events, ...externalEvents], [events, externalEvents]);
  useWidgetAgendaSync(widgetEvents, calendars);
  useGoogleCalendarAutoAttach(notify);

  const shortcutActions = useMemo(
    () => ({
      navigate: changeTab,
      calendarEnabled,
      planningEnabled,
      calendarActive: tab === "calendar",
      compose: openComposer,
      newTask: openTaskDraft,
      newEvent: openEventDraft,
      search: openSearch,
      toggleHelp: () => setHelpOpen((current) => !current),
      mail: {
        canMove: () => mailNav.current?.canMove() ?? false,
        canOpen: () => mailNav.current?.canOpen() ?? false,
        canAct: () => tab === "inbox" && depthRef.current === 0 && (mailNav.current?.canAct() ?? false),
        current: () => mailNav.current?.current() ?? null,
        next: () => mailNav.current?.next(),
        previous: () => mailNav.current?.previous(),
        open: () => mailNav.current?.open(),
        deleteSelected: () => mailNav.current?.deleteSelected(),
        archiveSelected: () => mailNav.current?.archiveSelected(),
        toggleStarSelected: () => mailNav.current?.toggleStarSelected(),
        toggleReadSelected: () => mailNav.current?.toggleReadSelected(),
        replySelected: () => mailNav.current?.replySelected(),
        forwardSelected: () => mailNav.current?.forwardSelected(),
      },
    }),
    [changeTab, calendarEnabled, planningEnabled, tab, openComposer, openSearch, openTaskDraft, openEventDraft],
  );
  const shortcuts = useMemo(() => appShortcuts(shortcutActions), [shortcutActions]);
  const helpShortcuts = useMemo(
    () => appShortcuts({ ...shortcutActions, mail: { ...shortcutActions.mail, canAct: () => true } }),
    [shortcutActions],
  );
  const mod = useShortcuts(shortcuts);

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

    if (dx < -55 && index < last) changeTab(order[index + 1]);
    else if (dx > 55 && index > 0) changeTab(order[index - 1]);
  };

  if (mode === "api" && phase === "loading") {
    return <BackendLoading />;
  }

  if (mode === "api" && phase === "empty") {
    return (
      <div className="h-full w-full pt-[env(safe-area-inset-top,0px)]">
        <ConnectScreen />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-full flex-col overflow-hidden",
        !native && "pt-[env(safe-area-inset-top,0px)] sm:pt-7",
      )}
    >
      <BackendBanner />
      <ReadOnlyBanner />
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
          {order.map((id) => (
            <div key={id} className="h-full w-full shrink-0">
              {id === "inbox" && (
                <InboxScreen
                  mails={mails}
                  account={account}
                  folder={folder}
                  active={tab === "inbox"}
                  navigationRef={mailNav}
                  onOpenAccounts={openAccounts}
                  onOpenFolders={openFolders}
                  onOpen={openMessage}
                  onToggleStar={toggleStar}
                  onSearch={openSearch}
                  onMailAction={mailAction}
                  onReply={replyTo}
                  onForward={forwardMail}
                  onNotSpam={moveToInbox}
                  onRestore={restoreMail}
                />
              )}
              {id === "calendar" && (
                <CalendarScreen
                  events={events}
                  externalEvents={externalEvents}
                  sourceCount={sourceCount}
                  availableMailIds={availableMailIds}
                  suggestions={suggestions}
                  onNewEvent={readOnly ? undefined : openEventDraft}
                  onAcceptSuggestion={openEventDraft}
                  onDismissSuggestion={dismissSuggestion}
                  onOpenMail={openMailFromEvent}
                  onSelectedDateChange={setSelectedDate}
                />
              )}
              {id === "planning" && (
                <PlanningScreen
                  tasks={tasks}
                  setTasks={setTasks}
                  suggestions={suggestions}
                  onAddSuggestion={addSuggestion}
                  onDismissSuggestion={dismissSuggestion}
                  onOpenTask={openTask}
                  onOpenSuggestion={openSuggestion}
                  onNewTask={readOnly ? undefined : openTaskDraft}
                  movingTask={movingTask}
                  onMovingChange={setMovingTask}
                  onOpenSync={() => changeTab("settings")}
                />
              )}
              {id === "settings" && (
                <SettingsScreen
                  mails={mails}
                  account={account}
                  onOpenAccounts={openAccounts}
                  onOpenPgp={openPgp}
                  onOpenMcp={openMcp}
                />
              )}
            </div>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 bg-gradient-to-t from-canvas via-canvas/80 to-transparent" />

        <Dock
          active={tab}
          onChange={changeTab}
          onCompose={openComposer}
          onNewTask={() => setTaskDraftOpen(true)}
          onNewEvent={() => openEventDraft()}
          readOnly={readOnly}
        />

        {composeDraft && !composeOpen && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+9.5rem)] z-[44] flex justify-center px-4">
            <button
              type="button"
              onClick={resumeCompose}
              className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[11.5px] font-bold text-accent-ink glass shadow-[0_14px_34px_-20px_var(--accent)] transition-transform duration-200 active:scale-95"
            >
              <PenLine className="size-3.5" strokeWidth={2.4} />
              Reprendre le brouillon
            </button>
          </div>
        )}

        <AnimatePresence>
          {openMail && openThread && (
            <motion.div
              key="message"
              className="absolute inset-0 z-[36] bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <MessageScreen
                thread={openThread}
                readOnly={readOnly}
                bodyLoading={bodyFetching === openMail.id}
                onClose={() => closeMessage()}
                onToggleStar={() => toggleStar(openMail.id)}
                onReply={replyTo}
                onForward={forwardMail}
                onResume={resumeDraft}
                onArchive={(mail) => {
                  mailAction("archive", mail);
                  closeMessage();
                }}
                onDelete={(mail) => {
                  mailAction("delete", mail);
                  closeMessage();
                }}
                onNotSpam={(mail) => {
                  moveToInbox(mail);
                  closeMessage();
                }}
                onRestore={(mail) => {
                  restoreMail(mail);
                  closeMessage();
                }}
                onOpenPgp={() => {
                  closeMessage();
                  openPgp();
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
                  detail.suggestion || readOnly
                    ? undefined
                    : (next) => {
                        setTasks((current) =>
                          sortTasks(current.map((task) => (task.id === next.id ? next : task))),
                        );
                        setDetail((current) => (current ? { ...current, task: next } : current));
                      }
                }
                onDelete={
                  detail.suggestion || readOnly
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
                onOpen={openMessage}
                onToggleStar={toggleStar}
                onMailAction={mailAction}
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
                onClick={closeEventDraft}
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
                  draft={eventDraft ?? undefined}
                  onClose={closeEventDraft}
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
          {connectOpen && (
            <motion.div
              key="connect"
              className="absolute inset-0 z-[60] bg-canvas"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <ConnectScreen onClose={closeConnect} />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {composeOpen && composeDraft && (
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
                  draft={composeDraft}
                  onDraftChange={setComposeDraft}
                  onSend={sendDraft}
                  sending={composeSending}
                  sendError={composeSendError}
                  onMinimize={minimizeCompose}
                  onClose={closeCompose}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Notice notice={notices[0] ?? null} onClose={dismissNotice} />
      <AccountRemoveDialog />
      <McpApprovalHost />
      <ShortcutsOverlay
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        shortcuts={helpShortcuts}
        mod={mod}
      />
    </div>
  );
}
