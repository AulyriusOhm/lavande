import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMailStore } from "@/lib/store";
import { useGoogleCalendarAutoAttach } from "@/lib/ics";
import { usePrefs } from "@/lib/prefs";
import { Notice } from "@/components/ui/notice";
import { AccountRemoveDialog, BackendBanner, BackendLoading, ReadOnlyBanner } from "@/components/backend-status";
import { ConnectScreen } from "@/screens/connect-screen";
import { DESKTOP_TABS, DesktopDock, type DesktopView } from "@/desktop/dock";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSearch } from "@/desktop/search";
import { DesktopCompose } from "@/desktop/compose";
import { DesktopCalendar, NewEventDialog, type NewEventInit } from "@/desktop/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import type { MailSuggestion } from "@/lib/tasks";
import { DesktopPlanning, NewTaskDialog } from "@/desktop/planning";
import { DesktopSettings } from "@/desktop/settings";
import { PgpScreen } from "@/screens/pgp-screen";
import { McpApprovalHost } from "@/screens/mcp-screen";
import { DesktopComposePage } from "@/desktop/compose-page";
import { isComposeWindow } from "@/lib/compose-bus";
import { useEscapeLayer } from "@/desktop/escape";
import { useShortcuts } from "@/lib/shortcuts";
import { appShortcuts, type MailNavigation } from "@/lib/app-shortcuts";
import { ShortcutsOverlay } from "@/components/shortcuts-overlay";

export function DesktopApp() {
  if (isComposeWindow()) return <DesktopComposePage />;
  return <DesktopMain />;
}

function DesktopMain() {
  const {
    notices,
    notify,
    readOnly,
    dismissNotice,
    openComposer,
    openMail,
    mode,
    phase,
    connectOpen,
    closeConnect,
    composeOpen,
    removeTarget,
    dismissSuggestion,
  } = useMailStore();
  const { calendarEnabled, planningEnabled } = usePrefs();
  const [view, setView] = useState<DesktopView>(() => {
    const initial = window.location.hash.slice(1) as DesktopView;
    return DESKTOP_TABS.some((tab) => tab.id === initial) ? initial : "inbox";
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [pendingInit, setPendingInit] = useState<string | undefined>(undefined);
  const [pendingDraft, setPendingDraft] = useState<NewEventInit | undefined>(undefined);
  const [pendingSuggestion, setPendingSuggestion] = useState<MailSuggestion | null>(null);
  const [pgpOpen, setPgpOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const mailNav = useRef<MailNavigation | null>(null);

  useGoogleCalendarAutoAttach(notify);

  const openMailId = openMail?.id ?? null;
  useEffect(() => {
    if (openMailId) setView("inbox");
  }, [openMailId]);

  const changeView = useCallback((next: DesktopView) => {
    setView(next);
    window.history.replaceState(null, "", `?desktop#${next}`);
  }, []);

  useEffect(() => {
    if (view === "calendar" && !calendarEnabled) changeView("inbox");
    if (view === "planning" && !planningEnabled) changeView("inbox");
  }, [view, calendarEnabled, planningEnabled, changeView]);

  useEffect(() => {
    const onHashChange = () => {
      const next = window.location.hash.slice(1) as DesktopView;
      if (DESKTOP_TABS.some((tab) => tab.id === next)) setView(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const toggleHelp = useCallback(() => setHelpOpen((current) => !current), []);

  const openNewEvent = useCallback(
    (init?: string | NewEventInit, suggestion?: MailSuggestion) => {
      if (readOnly) return;
      setEditingEvent(null);
      setPendingInit(typeof init === "string" ? init : undefined);
      setPendingDraft(typeof init === "string" ? undefined : init);
      setPendingSuggestion(suggestion ?? null);
      setNewEventOpen(true);
    },
    [readOnly],
  );

  const overlayOpen =
    searchOpen ||
    newTaskOpen ||
    newEventOpen ||
    pgpOpen ||
    helpOpen ||
    connectOpen ||
    composeOpen ||
    Boolean(removeTarget);

  const shortcutActions = useMemo(
    () => ({
      navigate: changeView,
      calendarEnabled,
      planningEnabled,
      calendarActive: view === "calendar",
      compose: openComposer,
      newTask: () => setNewTaskOpen(true),
      newEvent: () => openNewEvent(),
      search: () => setSearchOpen(true),
      toggleHelp,
      mail: {
        canMove: () => mailNav.current?.canMove() ?? false,
        canOpen: () => mailNav.current?.canOpen() ?? false,
        canAct: () => view === "inbox" && !overlayOpen && (mailNav.current?.canAct() ?? false),
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
    [changeView, calendarEnabled, planningEnabled, view, overlayOpen, openComposer, toggleHelp, openNewEvent],
  );
  const shortcuts = useMemo(() => appShortcuts(shortcutActions), [shortcutActions]);
  const helpShortcuts = useMemo(
    () => appShortcuts({ ...shortcutActions, mail: { ...shortcutActions.mail, canAct: () => true } }),
    [shortcutActions],
  );
  const mod = useShortcuts(shortcuts);

  useEscapeLayer(connectOpen, closeConnect);
  useEscapeLayer(pgpOpen, () => setPgpOpen(false));
  useEscapeLayer(helpOpen, () => setHelpOpen(false));

  if (mode === "api" && phase === "loading") {
    return (
      <div data-desktop className="grid h-full w-full place-items-center bg-canvas">
        <BackendLoading />
      </div>
    );
  }

  if (mode === "api" && phase === "empty") {
    return (
      <div data-desktop className="grid h-full w-full place-items-center bg-canvas p-6">
        <div className="h-[min(760px,100%)] w-[min(900px,100%)] overflow-hidden rounded-[28px] border border-line bg-canvas shadow-[0_40px_100px_-50px_var(--accent)]">
          <ConnectScreen variant="desktop" />
        </div>
      </div>
    );
  }

  return (
    <div
      data-desktop
      className="relative flex h-full w-full flex-col overflow-hidden bg-canvas text-ink"
    >
      <BackendBanner variant="desktop" />
      <ReadOnlyBanner variant="desktop" />
      <main className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="h-full min-h-0"
          >
            {view === "inbox" && (
              <DesktopInbox
                onOpenSearch={() => setSearchOpen(true)}
                navigationRef={mailNav}
                onOpenPgp={() => changeView("settings")}
              />
            )}
            {view === "calendar" && (
              <DesktopCalendar
                onNewEvent={openNewEvent}
                onEditEvent={(event) => {
                  setEditingEvent(event);
                  setNewEventOpen(true);
                }}
              />
            )}
            {view === "planning" && (
              <DesktopPlanning
                onNewTask={readOnly ? undefined : () => setNewTaskOpen(true)}
                onOpenSync={() => changeView("settings")}
              />
            )}
            {view === "settings" && <DesktopSettings onOpenPgp={() => setPgpOpen(true)} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <DesktopDock
        active={view}
        onChange={changeView}
        onCompose={openComposer}
        onNewTask={() => setNewTaskOpen(true)}
        onNewEvent={() => openNewEvent()}
        onSearch={() => setSearchOpen(true)}
      />

      <DesktopCompose />
      <DesktopSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} />
      <NewEventDialog
        open={newEventOpen}
        event={editingEvent}
        initialDate={pendingInit}
        draft={pendingDraft}
        onCreated={() => {
          if (pendingSuggestion) dismissSuggestion(pendingSuggestion);
        }}
        onClose={() => {
          setNewEventOpen(false);
          setEditingEvent(null);
          setPendingInit(undefined);
          setPendingDraft(undefined);
          setPendingSuggestion(null);
        }}
      />
      <Notice notice={notices[0] ?? null} onClose={dismissNotice} />
      <AccountRemoveDialog variant="dialog" />
      <McpApprovalHost />

      <AnimatePresence>
        {pgpOpen && (
          <motion.div
            key="pgp"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 z-[60] grid place-items-center bg-ink/25 p-6 backdrop-blur-[2px]"
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="h-[min(760px,100%)] w-[min(900px,100%)] overflow-hidden rounded-[28px] border border-line bg-canvas shadow-[0_44px_96px_-48px_var(--accent)]"
            >
              <PgpScreen onClose={() => setPgpOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {connectOpen && (
          <motion.div
            key="connect"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 z-[60] grid place-items-center bg-ink/25 p-6 backdrop-blur-[2px]"
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="h-[min(760px,100%)] w-[min(900px,100%)] overflow-hidden rounded-[28px] border border-line bg-canvas shadow-[0_44px_96px_-48px_var(--accent)]"
            >
              <ConnectScreen variant="desktop" onClose={closeConnect} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ShortcutsOverlay
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        shortcuts={helpShortcuts}
        mod={mod}
      />
    </div>
  );
}
