import { useCallback, useEffect, useMemo, useState } from "react";
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
import { PgpScreen } from "@/screens/pgp-screen";
import { DesktopComposePage } from "@/desktop/compose-page";
import { isComposeWindow } from "@/lib/compose-bus";
import { useEscapeLayer } from "@/desktop/escape";
import { defineShortcuts, useShortcuts } from "@/lib/shortcuts";
import { ShortcutsOverlay } from "@/components/shortcuts-overlay";

export function DesktopApp() {
  if (isComposeWindow()) return <DesktopComposePage />;
  return <DesktopMain />;
}

function DesktopMain() {
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
  const [pgpOpen, setPgpOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

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

  const shortcuts = useMemo(
    () =>
      defineShortcuts([
        {
          id: "view-inbox",
          keys: "mod+1",
          group: "Navigation",
          label: "Boîte de réception",
          description: "Revenir aux messages",
          allowInInput: true,
          run: () => changeView("inbox"),
        },
        {
          id: "view-calendar",
          keys: "mod+2",
          group: "Navigation",
          label: "Agenda",
          description: "Ouvrir le calendrier",
          allowInInput: true,
          when: () => calendarEnabled,
          run: () => changeView("calendar"),
        },
        {
          id: "view-planning",
          keys: "mod+3",
          group: "Navigation",
          label: "Planification",
          description: "Ouvrir les tâches",
          allowInInput: true,
          when: () => planningEnabled,
          run: () => changeView("planning"),
        },
        {
          id: "view-settings",
          keys: "mod+4",
          group: "Navigation",
          label: "Réglages",
          description: "Ouvrir les réglages",
          allowInInput: true,
          run: () => changeView("settings"),
        },
        {
          id: "compose",
          keys: "mod+n",
          group: "Actions",
          label: "Nouveau message",
          description: "Ouvrir la rédaction",
          allowInInput: true,
          run: openComposer,
        },
        {
          id: "create",
          keys: "mod+shift+n",
          group: "Actions",
          label: view === "calendar" ? "Nouveau rendez-vous" : "Nouvelle tâche",
          description: view === "calendar" ? "Ajouter un rendez-vous à l’agenda" : "Ajouter une tâche",
          allowInInput: true,
          run: () => (view === "calendar" ? setNewEventOpen(true) : setNewTaskOpen(true)),
        },
        {
          id: "search",
          keys: "mod+k",
          group: "Actions",
          label: "Rechercher",
          description: "Chercher dans tous les comptes",
          allowInInput: true,
          run: () => setSearchOpen(true),
        },
        {
          id: "settings-shortcut",
          keys: "mod+,",
          group: "Actions",
          label: "Réglages",
          description: "Préférences et comptes",
          allowInInput: true,
          run: () => changeView("settings"),
        },
        {
          id: "help",
          keys: "mod+/",
          group: "Aide",
          label: "Raccourcis clavier",
          description: "Afficher ou masquer cette liste",
          allowInInput: true,
          run: toggleHelp,
        },
        {
          id: "help-question",
          keys: "?",
          group: "Aide",
          label: "Raccourcis clavier",
          description: "Afficher ou masquer cette liste",
          run: toggleHelp,
        },
      ]),
    [changeView, calendarEnabled, planningEnabled, view, openComposer, toggleHelp],
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
            {view === "inbox" && <DesktopInbox onOpenSearch={() => setSearchOpen(true)} />}
            {view === "calendar" && <DesktopCalendar onNewEvent={() => setNewEventOpen(true)} />}
            {view === "planning" && (
              <DesktopPlanning onNewTask={() => setNewTaskOpen(true)} onOpenSync={() => changeView("settings")} />
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
        shortcuts={shortcuts}
        mod={mod}
      />
    </div>
  );
}
