import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMailStore } from "@/lib/store";
import { usePrefs } from "@/lib/prefs";
import { Notice } from "@/components/ui/notice";
import { AccountRemoveDialog, BackendBanner, BackendLoading } from "@/components/backend-status";
import { ConnectScreen } from "@/screens/connect-screen";
import { DESKTOP_TABS, DesktopDock, type DesktopView } from "@/desktop/dock";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSearch } from "@/desktop/search";
import { DesktopCompose } from "@/desktop/compose";
import { DesktopCalendar, NewEventDialog } from "@/desktop/calendar";
import { DesktopPlanning, NewTaskDialog } from "@/desktop/planning";
import { DesktopSettings } from "@/desktop/settings";

export function DesktopApp() {
  const { notices, dismissNotice, openComposer, openMail, mode, phase, connectOpen, closeConnect } =
    useMailStore();
  const { calendarEnabled, planningEnabled } = usePrefs();
  const [view, setView] = useState<DesktopView>(() => {
    const initial = window.location.hash.slice(1) as DesktopView;
    return DESKTOP_TABS.some((tab) => tab.id === initial) ? initial : "inbox";
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newEventOpen, setNewEventOpen] = useState(false);

  useEffect(() => {
    if (openMail) setView("inbox");
  }, [openMail]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        <div className="h-[min(820px,100%)] w-[460px] max-w-full overflow-hidden rounded-[28px] border border-line bg-canvas shadow-[0_40px_100px_-50px_var(--accent)]">
          <ConnectScreen />
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
      <main className="relative min-h-0 flex-1">
        {view === "inbox" && <DesktopInbox onOpenSearch={() => setSearchOpen(true)} />}
        {view === "calendar" && <DesktopCalendar onNewEvent={() => setNewEventOpen(true)} />}
        {view === "planning" && (
          <DesktopPlanning onNewTask={() => setNewTaskOpen(true)} onOpenSync={() => changeView("settings")} />
        )}
        {view === "settings" && <DesktopSettings />}
      </main>

      <DesktopDock
        active={view}
        onChange={changeView}
        onCompose={openComposer}
        onNewTask={() => setNewTaskOpen(true)}
        onNewEvent={() => setNewEventOpen(true)}
        onSearch={() => setSearchOpen(true)}
      />

      <DesktopCompose />
      <DesktopSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} />
      <NewEventDialog open={newEventOpen} onClose={() => setNewEventOpen(false)} />
      <Notice notice={notices[0] ?? null} onClose={dismissNotice} />
      <AccountRemoveDialog variant="dialog" />

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
              className="h-[min(780px,100%)] w-[480px] max-w-full overflow-hidden rounded-[28px] border border-line bg-canvas shadow-[0_44px_96px_-48px_var(--accent)]"
            >
              <ConnectScreen onClose={closeConnect} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
