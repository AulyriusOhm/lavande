import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { Check, ChevronRight, ListChecks, Mail, Plus, Sparkles, Trash2 } from "lucide-react";
import type { MailSuggestion, Task, TaskState } from "@/lib/tasks";
import { TASK_STATES, sortTasks, stateMeta } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { BlurFade } from "@/components/ui/blur-fade";
import { SwipeAction } from "@/components/ui/swipe-action";
import { MeshGlow } from "@/components/ui/backdrops";
import { NumberTicker } from "@/components/ui/number-ticker";
import { AnimatedGradientText } from "@/components/ui/animated-text";

type Filter = TaskState | "all" | "suggestion";

const DUE_STYLE: Record<Task["dueTone"], string> = {
  late: "bg-red-500/12 text-red-700 dark:text-red-300",
  soon: "bg-accent-soft text-accent-ink",
  soft: "bg-surface-2 text-ink-soft",
  none: "bg-surface-2 text-ink-muted",
};

export function PlanningScreen({
  tasks,
  setTasks,
  suggestions,
  onAddSuggestion,
  onDismissSuggestion,
  onOpenTask,
  onOpenSuggestion,
}: {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  suggestions: MailSuggestion[];
  onAddSuggestion: (suggestion: MailSuggestion) => void;
  onDismissSuggestion: (suggestion: MailSuggestion) => void;
  onOpenTask: (task: Task) => void;
  onOpenSuggestion: (suggestion: MailSuggestion) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [moving, setMoving] = useState<Task | null>(null);
  const [headerH, setHeaderH] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const raw = useMotionValue(0);
  const progress = useSpring(raw, { stiffness: 220, damping: 30, mass: 0.9 });

  const headerHeight = useTransform(progress, [0, 0.8], [headerH, 0]);
  const headerOpacity = useTransform(progress, [0, 0.5], [1, 0]);
  const headerScale = useTransform(progress, [0, 1], [1, 0.97]);
  const barOpacity = useTransform(progress, [0.5, 0.95], [0, 1]);
  const barY = useTransform(progress, [0.5, 0.95], [-12, 0]);
  const barSpace = useTransform(progress, [0.5, 1], [0, 52]);

  useLayoutEffect(() => {
    const measure = () => setHeaderH(headerRef.current?.offsetHeight ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => raw.set(Math.min(1, Math.max(0, element.scrollTop / 80)));
    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [raw]);

  const countFor = (state: TaskState) => tasks.filter((task) => task.state === state).length;
  const visibleTasks =
    filter === "all" ? tasks : filter === "suggestion" ? [] : tasks.filter((task) => task.state === filter);
  const showSuggestions = filter === "all" || filter === "suggestion";

  const setState = (id: string, state: TaskState) => {
    setTasks((current) => sortTasks(current.map((task) => (task.id === id ? { ...task, state } : task))));
    setMoving(null);
  };

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-y-auto no-scrollbar pb-32">
        <MeshGlow className="h-40" />

        <motion.div style={{ height: headerHeight, opacity: headerOpacity }} className="overflow-hidden">
          <motion.header
            ref={headerRef}
            style={{ scale: headerScale }}
            className="relative origin-top px-5 pt-4"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h1 className="text-[26px] leading-none font-extrabold tracking-[-0.035em] text-ink">
                <AnimatedGradientText>Planification</AnimatedGradientText>
              </h1>
              <span className="shrink-0 text-[11px] font-semibold text-ink-muted">
                <NumberTicker value={tasks.filter((task) => task.state !== "done").length} /> ouvertes
              </span>
            </div>
          </motion.header>
        </motion.div>

        <motion.div style={{ height: barSpace }} />

        <div className="relative">
          <div
            className="mt-4 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar"
            style={{ touchAction: "pan-x", overscrollBehaviorX: "contain" }}
          >
            <button
            type="button"
            onClick={() => setFilter("all")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11.5px] font-bold transition-all",
              filter === "all"
                ? "bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]"
                : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
            )}
          >
            Toutes
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "all" ? "bg-white/25 text-white" : "bg-accent-soft text-accent-ink",
              )}
            >
              {tasks.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter("suggestion")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11.5px] font-bold transition-all",
              filter === "suggestion"
                ? "bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]"
                : "border border-dashed border-accent-ring/80 bg-surface text-accent-ink hover:border-accent",
            )}
          >
            <Sparkles className="size-3" strokeWidth={2.4} />
            Suggestions
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                filter === "suggestion" ? "bg-white/25 text-white" : "bg-accent-soft text-accent-ink",
              )}
            >
              {suggestions.length}
            </span>
          </button>

          {TASK_STATES.map((state) => {
            const active = filter === state.id;
            return (
              <button
                key={state.id}
                type="button"
                onClick={() => setFilter(state.id)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                <span className={cn("size-1.5 rounded-full", active ? "bg-white/80" : state.dot)} />
                {state.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-bold",
                    active ? "bg-white/25 text-white" : "bg-surface-2 text-ink-muted",
                  )}
                >
                  {countFor(state.id)}
                </span>
              </button>
            );
          })}
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas to-transparent" />
        </div>

        <div className="mt-3 space-y-1.5 px-4">
          <AnimatePresence initial={false}>
            {showSuggestions &&
              suggestions.map((suggestion) => (
                <motion.div
                  key={suggestion.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <SwipeAction
                    leading={{
                      label: "Supprimer",
                      icon: Trash2,
                      tone: "danger",
                      run: () => onDismissSuggestion(suggestion),
                    }}
                    trailing={{
                      label: "Supprimer",
                      icon: Trash2,
                      tone: "danger",
                      run: () => onDismissSuggestion(suggestion),
                    }}
                  >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenSuggestion(suggestion)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onOpenSuggestion(suggestion);
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded-2xl border border-dashed border-accent-ring/70 bg-accent-soft/50 px-3 py-2.5 transition-colors hover:border-accent hover:bg-accent-soft"
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAddSuggestion(suggestion);
                      }}
                      aria-label={"Ajouter : " + suggestion.proposal}
                      className="grid size-5 shrink-0 place-items-center rounded-md border-2 border-accent-ring bg-surface text-accent-ink transition-colors hover:border-accent hover:bg-accent hover:text-white"
                    >
                      <Plus className="size-3" strokeWidth={3.5} />
                    </button>
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="truncate text-[12.5px] font-bold text-ink">{suggestion.proposal}</p>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] font-medium text-ink-muted">
                        <Mail className="size-2.5 shrink-0" />
                        {suggestion.subject}
                      </p>
                    </div>
                    <span className="shrink-0 text-[9.5px] font-extrabold text-accent-ink">{suggestion.due}</span>
                  </div>
                  </SwipeAction>
                </motion.div>
              ))}
          </AnimatePresence>

          {visibleTasks.map((task, index) => {
            const meta = stateMeta(task.state);
            const done = task.state === "done";
            return (
              <BlurFade key={task.id} delay={Math.min(0.3, index * 0.04)} yOffset={10}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenTask(task)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onOpenTask(task);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2.5 transition-colors",
                    done ? "border-line/70 bg-surface/60" : "border-line bg-surface hover:border-accent-ring/70",
                  )}
                >
                  <button
                    type="button"
                    aria-label={done ? "Rouvrir la tâche" : "Marquer comme faite"}
                    onClick={(event) => {
                      event.stopPropagation();
                      setState(task.id, done ? "todo" : "done");
                    }}
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-md border-2 transition-colors",
                      done ? "border-accent bg-accent text-white" : "border-accent-ring/70 hover:border-accent",
                    )}
                  >
                    {done ? <Check className="size-3" strokeWidth={3.5} /> : null}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-[12.5px] leading-tight font-bold",
                        done ? "text-ink-muted line-through" : "text-ink",
                      )}
                    >
                      {task.title}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] font-medium text-ink-muted">{task.meta}</p>
                    {typeof task.progress === "number" && !done ? (
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${task.progress}%` }} />
                      </div>
                    ) : null}
                  </div>

                  {task.dueTone !== "none" ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-extrabold",
                        DUE_STYLE[task.dueTone],
                      )}
                    >
                      {task.due}
                    </span>
                  ) : null}

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMoving(task);
                    }}
                    aria-label={`Changer l'état de ${task.title}`}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[9.5px] font-extrabold",
                      meta.chip,
                    )}
                  >
                    {meta.label}
                    <ChevronRight className="size-2.5 opacity-70" />
                  </button>
                </div>
              </BlurFade>
            );
          })}

          {visibleTasks.length === 0 && !(showSuggestions && suggestions.length > 0) && (
            <p className="px-6 py-12 text-center text-[13px] font-medium text-ink-muted">
              Aucune tâche dans cet état.
            </p>
          )}

          <button
            type="button"
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-[12.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
          >
            <Plus className="size-4" />
            Nouvelle tâche
          </button>
        </div>
      </div>

      <motion.div
        style={{ opacity: barOpacity, y: barY }}
        className="pointer-events-none absolute inset-x-0 top-0 z-30"
      >
        <div className="glass flex items-center gap-2.5 border-b border-line/70 px-4 pt-2.5 pb-2">
          <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-accent-ink">
            <ListChecks className="size-3.5" strokeWidth={2.4} />
          </span>
          <p className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-ink">Planification</p>
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
            {tasks.filter((task) => task.state !== "done").length} ouvertes
          </span>
        </div>
      </motion.div>

      {moving && (
        <div className="absolute inset-0 z-50 flex items-end" role="dialog" aria-label="Changer l'état">
          <button
            type="button"
            aria-label="Fermer"
            onClick={() => setMoving(null)}
            className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
          />
          <div className="relative w-full rounded-t-[28px] border-t border-line bg-canvas px-4 pt-3 pb-28 shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
            <p className="px-1 pb-1 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">
              Déplacer vers
            </p>
            <p className="truncate px-1 pb-3 text-[12.5px] font-bold text-ink">{moving.title}</p>
            <div className="space-y-1">
              {TASK_STATES.map((state) => (
                <button
                  key={state.id}
                  type="button"
                  onClick={() => setState(moving.id, state.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[12.5px] font-semibold transition-colors",
                    moving.state === state.id ? "bg-accent-soft text-accent-ink" : "hover:bg-surface-2",
                  )}
                >
                  <span className={cn("size-2 rounded-full", state.dot)} />
                  {state.label}
                  {moving.state === state.id ? <Check className="ml-auto size-3.5" /> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
