import { AnimatePresence, motion } from "motion/react";
import { CalendarDays, CalendarPlus, Inbox, ListChecks, PenLine, Plus, Search, Settings2 } from "lucide-react";
import { useMailStore } from "@/lib/store";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { Kbd } from "@/desktop/ui";

export const DESKTOP_TABS = [
  { id: "inbox", label: "Boîte", icon: Inbox },
  { id: "calendar", label: "Agenda", icon: CalendarDays },
  { id: "planning", label: "Planification", icon: ListChecks },
  { id: "settings", label: "Réglages", icon: Settings2 },
] as const;

export type DesktopView = (typeof DESKTOP_TABS)[number]["id"];

export function DesktopDock({
  active,
  onChange,
  onCompose,
  onNewTask,
  onNewEvent,
  onSearch,
}: {
  active: DesktopView;
  onChange: (view: DesktopView) => void;
  onCompose: () => void;
  onNewTask: () => void;
  onNewEvent: () => void;
  onSearch: () => void;
}) {
  const { calendarEnabled, planningEnabled } = usePrefs();
  const { folderStats, readOnly } = useMailStore();
  const unread = folderStats("inbox").unread;
  const tabs = DESKTOP_TABS.filter((tab) =>
    tab.id === "calendar" ? calendarEnabled : tab.id === "planning" ? planningEnabled : true,
  );
  const fab =
    readOnly || active === "settings"
      ? null
      : active === "planning"
        ? { icon: Plus, label: "Nouvelle tâche", run: onNewTask }
        : active === "calendar"
          ? { icon: CalendarPlus, label: "Nouveau rendez-vous", run: onNewEvent }
          : { icon: PenLine, label: "Nouveau message", run: onCompose };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-6 pb-6">
      <div className="relative flex justify-center">
        <span aria-hidden="true" className="dock-aura" />
        <span aria-hidden="true" className="dock-halo" />
        <div className="pointer-events-auto relative flex items-center gap-1 rounded-full p-1.5 dock-glass shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_16%,transparent),0_28px_64px_-24px_var(--accent),0_12px_28px_-18px_var(--accent)]">
          {tabs.map((tab) => {
            const isActive = active === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onChange(tab.id)}
                aria-current={isActive}
                className={cn(
                  "focus-ring relative flex h-10 items-center gap-2 rounded-full px-3.5 transition-colors duration-300",
                  isActive ? "text-accent-ink" : "text-ink-soft hover:text-ink",
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="desktop-dock-pill"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className="absolute inset-0 rounded-full bg-accent-soft inset-ring-1 inset-ring-accent-ring"
                  />
                )}
                <Icon className="relative z-10 size-[18px]" strokeWidth={isActive ? 2.4 : 1.9} />
                <span className="relative z-10 text-[12.5px] font-semibold whitespace-nowrap">{tab.label}</span>
                {tab.id === "inbox" && unread > 0 && (
                  <span className="relative z-10 rounded-full bg-accent px-1.5 py-0.5 text-[9.5px] font-bold text-accent-contrast tabular-nums">
                    {unread}
                  </span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            onClick={onSearch}
            className="focus-ring ml-1 flex h-10 items-center gap-2 rounded-full px-3 text-ink-soft transition-colors hover:text-ink"
            aria-label="Rechercher"
            title="Rechercher (⌘K)"
          >
            <Search className="size-[17px]" strokeWidth={1.9} />
            <Kbd>⌘K</Kbd>
          </button>

          <AnimatePresence initial={false}>
            {fab && (
              <motion.div
                key="fab"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                className="flex items-center"
              >
                <div className="mx-1.5 h-6 w-px shrink-0 bg-accent-ring" />
                <button
                  type="button"
                  onClick={fab.run}
                  aria-label={fab.label}
                  title={fab.label}
                  className="focus-ring grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-contrast ring-1 ring-accent-ring shadow-[0_12px_28px_-10px_var(--accent)] transition-transform duration-200 active:scale-90"
                >
                  <fab.icon className="size-[18px]" strokeWidth={2.4} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
