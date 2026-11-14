import { AnimatePresence, motion } from "motion/react";
import { CalendarDays, CalendarPlus, Inbox, ListChecks, PenLine, Plus, Settings2 } from "lucide-react";
import { isNativeShell } from "@/lib/native";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";

export const TABS = [
  { id: "inbox", label: "Boîte", icon: Inbox },
  { id: "calendar", label: "Agenda", icon: CalendarDays },
  { id: "planning", label: "Planif.", icon: ListChecks },
  { id: "settings", label: "Réglages", icon: Settings2 },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export function Dock({
  active,
  onChange,
  onCompose,
  onNewTask,
  onNewEvent,
  readOnly = false,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  onCompose: () => void;
  onNewTask: () => void;
  onNewEvent: () => void;
  readOnly?: boolean;
}) {
  const native = isNativeShell();
  const { calendarEnabled, planningEnabled } = usePrefs();
  const tabs = TABS.filter((tab) =>
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
  const fabButton = fab ? (
    <>
      <div className="mx-1 h-6 w-px shrink-0 bg-line" />
      <button
        type="button"
        onClick={fab.run}
        aria-label={fab.label}
        className={cn(
          "focus-ring group relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-full",
          "bg-accent text-accent-contrast",
          native
            ? undefined
            : "shadow-[0_10px_24px_-10px_var(--accent)] transition-transform duration-200 active:scale-90",
        )}
      >
        <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-br from-white/25 via-white/5 to-transparent" />
        <fab.icon className="relative z-10 size-[18px]" strokeWidth={2.4} />
      </button>
    </>
  ) : null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+1.35rem)] sm:pb-7">
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-0.5 rounded-full border border-line p-1.5",
          "glass shadow-[0_20px_45px_-20px_var(--accent)]",
        )}
      >
        {tabs.map((tab) => {
          const isActive = active === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              aria-label={tab.label}
              aria-current={isActive}
              className={cn(
                "focus-ring relative flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 transition-colors duration-300",
                isActive ? "text-accent-ink" : "text-ink-muted hover:text-ink-soft",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="dock-pill"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  className="absolute inset-0 rounded-full bg-accent-soft"
                />
              )}
              <Icon className="relative z-10 size-[19px]" strokeWidth={isActive ? 2.4 : 1.9} />
              <span
                className={cn(
                  "relative z-10 overflow-hidden text-[12.5px] font-semibold whitespace-nowrap transition-all duration-300",
                  isActive ? "max-w-24 opacity-100" : "max-w-0 opacity-0",
                )}
              >
                {tab.label}
              </span>
            </button>
          );
        })}

        {native ? (
          fabButton && <div className="flex items-center overflow-hidden">{fabButton}</div>
        ) : (
          <AnimatePresence initial={false}>
            {fabButton && (
              <motion.div
                key="fab"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "auto", opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 34 }}
                className="flex items-center overflow-hidden"
              >
                {fabButton}
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
