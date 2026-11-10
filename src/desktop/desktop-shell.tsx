import { useCallback, useEffect, useState } from "react";
import { useMailStore } from "@/lib/store";
import { usePrefs } from "@/lib/prefs";
import { Notice } from "@/components/ui/notice";
import { DESKTOP_TABS, DesktopDock, type DesktopView } from "@/desktop/dock";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSearch } from "@/desktop/search";
import { DesktopCompose } from "@/desktop/compose";
import { DesktopCalendar, NewEventDialog } from "@/desktop/calendar";
import { DesktopPlanning, NewTaskDialog } from "@/desktop/planning";
import { DesktopSettings } from "@/desktop/settings";

export function DesktopApp() {
  const { notices, dismissNotice, openComposer, openMail } = useMailStore();
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

  return (
    <div
      data-desktop
      className="relative flex h-full w-full flex-col overflow-hidden bg-canvas text-ink"
    >
      <main className="relative min-h-0 flex-1">
        {view === "inbox" && <DesktopInbox onOpenSearch={() => setSearchOpen(true)} />}
        {view === "calendar" && <DesktopCalendar onNewEvent={() => setNewEventOpen(true)} />}
        {view === "planning" && <DesktopPlanning onNewTask={() => setNewTaskOpen(true)} />}
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
    </div>
  );
}
