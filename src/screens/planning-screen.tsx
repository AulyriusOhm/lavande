import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { Check, ChevronRight, EyeOff, ListChecks, Mail, Plus, Sparkles, UserRound } from "lucide-react";
import type { MailSuggestion, Task, TaskState } from "@/lib/tasks";
import { TASK_STATES, sortTasks, stateMeta } from "@/lib/tasks";
import { sourceAccountLabel } from "@/lib/accounts";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { BlurFade } from "@/components/ui/blur-fade";
import { SwipeAction } from "@/components/ui/swipe-action";
import { MeshGlow } from "@/components/ui/backdrops";
import { NumberTicker } from "@/components/ui/number-ticker";
import { AnimatedGradientText } from "@/components/ui/animated-text";
import { SyncBadge } from "@/components/sync-badge";

type Filter = TaskState | "all" | "suggestion";

const DUE_STYLE: Record<Task["dueTone"], string> = {
  late: "bg-red-500/12 text-red-700 dark:text-red-300",
  soon: "bg-accent-soft text-accent-ink",
  soft: "bg-surface-2 text-ink-soft",
  none: "bg-surface-2 text-ink-muted",
};

const CHIP =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11.5px] font-bold transition-all";

export function PlanningScreen({
  tasks,
  setTasks,
  suggestions,
  onAddSuggestion,
  onDismissSuggestion,
  onOpenTask,
  onOpenSuggestion,
  onNewTask,
  movingTask,
  onMovingChange,
  onOpenSync,
}: {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  suggestions: MailSuggestion[];
  onAddSuggestion: (suggestion: MailSuggestion) => void;
  onDismissSuggestion: (suggestion: MailSuggestion) => void;
  onOpenTask: (task: Task) => void;
  onOpenSuggestion: (suggestion: MailSuggestion) => void;
  onNewTask?: () => void;
  movingTask?: Task | null;
  onMovingChange?: (task: Task | null) => void;
  onOpenSync?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  const { accounts, mails, openMessage } = useMailStore();
  const mailIndex = useMemo(() => new Map(mails.map((mail) => [mail.id, mail])), [mails]);
  const [localMoving, setLocalMoving] = useState<Task | null>(null);
  const [headerH, setHeaderH] = useState(0);
  const [edges, setEdges] = useState({ left: false, right: false });

  const moving = movingTask === undefined ? localMoving : movingTask;

  const setMoving = (task: Task | null) => {
    if (movingTask === undefined) setLocalMoving(task);
    onMovingChange?.(task);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const chips = useRef<Partial<Record<Filter, HTMLButtonElement | null>>>({});
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

  useEffect(() => {
    const element = filtersRef.current;
    if (!element) return;
    const update = () =>
      setEdges({
        left: element.scrollLeft > 4,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 4,
      });
    update();
    element.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      element.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    const container = filtersRef.current;
    const chip = chips.current[filter];
    if (!container || !chip) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      left: chip.offsetLeft - (container.clientWidth - chip.offsetWidth) / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [filter]);

  const countFor = (state: TaskState) => tasks.filter((task) => task.state === state).length;
  const assignees = useMemo(
    () => [...new Set(tasks.flatMap((task) => (task.assignee ? [task.assignee] : [])))],
    [tasks],
  );
  const activeAssignee =
    assigneeFilter !== null && assignees.includes(assigneeFilter) ? assigneeFilter : null;
  const stateTasks =
    filter === "all" ? tasks : filter === "suggestion" ? [] : tasks.filter((task) => task.state === filter);
  const visibleTasks = stateTasks.filter(
    (task) => activeAssignee === null || task.assignee === activeAssignee,
  );
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
              <div className="flex shrink-0 items-center gap-2">
                <SyncBadge onOpen={onOpenSync} />
                <span className="text-[11px] font-semibold text-ink-muted">
                  <NumberTicker value={tasks.filter((task) => task.state !== "done").length} /> ouvertes
                </span>
              </div>
            </div>
          </motion.header>
        </motion.div>

        <motion.div style={{ height: barSpace }} />

        <div className="relative">
          <div
            ref={filtersRef}
            className="mt-4 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar"
            style={{ touchAction: "pan-x", overscrollBehaviorX: "contain" }}
          >
            <button
              type="button"
              ref={(element) => {
                chips.current.all = element;
              }}
              onClick={() => setFilter("all")}
              aria-pressed={filter === "all"}
              className={cn(
                CHIP,
                filter === "all"
                  ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                  : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
              )}
            >
              Tâches
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-bold",
                  filter === "all" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
                )}
              >
                {tasks.length}
              </span>
            </button>

            <button
              type="button"
              ref={(element) => {
                chips.current.suggestion = element;
              }}
              onClick={() => setFilter("suggestion")}
              aria-pressed={filter === "suggestion"}
              className={cn(
                CHIP,
                filter === "suggestion"
                  ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                  : "border border-dashed border-accent-ring/80 bg-surface text-accent-ink hover:border-accent",
              )}
            >
              <Sparkles className="size-3" strokeWidth={2.4} />
              Suggestions
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-bold",
                  filter === "suggestion" ? "bg-ink/10 text-accent-contrast" : "bg-accent-soft text-accent-ink",
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
                  ref={(element) => {
                    chips.current[state.id] = element;
                  }}
                  onClick={() => setFilter(state.id)}
                  aria-pressed={active}
                  className={cn(
                    CHIP,
                    active
                      ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                      : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", active ? "bg-accent-contrast/80" : state.dot)} />
                  {state.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px] font-bold",
                      active ? "bg-ink/10 text-accent-contrast" : "bg-surface-2 text-ink-muted",
                    )}
                  >
                    {countFor(state.id)}
                  </span>
                </button>
              );
            })}

            {assignees.map((name) => {
              const active = activeAssignee === name;
              return (
                <button
                  key={name}
                  type="button"
                  data-testid={`assignee-filter-${name}`}
                  onClick={() => setAssigneeFilter(active ? null : name)}
                  aria-pressed={active}
                  className={cn(
                    CHIP,
                    active
                      ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                      : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                  )}
                >
                  <UserRound className={cn("size-3", active ? "text-accent-contrast" : "text-accent-ink")} strokeWidth={2.6} />
                  {name}
                </button>
              );
            })}
          </div>
          {edges.left && (
            <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-canvas to-transparent" />
          )}
          {edges.right && (
            <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas to-transparent" />
          )}
        </div>

        <div className="mt-3 space-y-1.5 px-4">
          {showSuggestions && suggestions.length > 0 ? (
            <p className="px-1 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Suggestions</p>
          ) : null}
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
                      label: "Ignorer",
                      icon: EyeOff,
                      tone: "neutral",
                      run: () => onDismissSuggestion(suggestion),
                    }}
                    trailing={{
                      label: "Ignorer",
                      icon: EyeOff,
                      tone: "neutral",
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
                        className="relative grid size-5 shrink-0 place-items-center rounded-md border-2 border-accent-ring bg-surface text-accent-ink transition-colors before:absolute before:-inset-3 before:rounded-full before:content-[''] hover:border-accent hover:bg-accent hover:text-accent-contrast"
                      >
                        <Plus className="size-3" strokeWidth={3.5} />
                      </button>
                      <div className="min-w-0 flex-1 leading-tight">
                        <p className="line-clamp-2 text-[12.5px] font-bold text-ink">{suggestion.proposal}</p>
                        <p className="mt-0.5 flex items-start gap-1 text-[12px] leading-snug font-medium text-ink-muted">
                          <Mail className="mt-0.5 size-2.5 shrink-0" />
                          <span className="line-clamp-2">{suggestion.subject}</span>
                        </p>
                        <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-ink-muted">
                          {suggestion.ai ? (
                            <span
                              data-testid="suggestion-ai"
                              title="Suggéré par l'IA"
                              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-bold text-accent-ink"
                            >
                              <Sparkles className="size-2.5" strokeWidth={2.6} />
                              IA
                            </span>
                          ) : null}
                          <span data-testid="suggestion-account" className="truncate">
                            {sourceAccountLabel(accounts, suggestion.account)}
                          </span>
                        </p>
                      </div>
                      {suggestion.due ? (
                        <span
                          data-testid="suggestion-due"
                          className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-extrabold whitespace-nowrap text-accent-ink"
                        >
                          {suggestion.due}
                        </span>
                      ) : null}
                      {mailIndex.has(suggestion.mailId) ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openMessage(suggestion.mailId);
                          }}
                          aria-label={`Voir le mail d'origine : ${suggestion.subject}`}
                          className="focus-ring grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-accent-ink transition-colors hover:bg-surface active:bg-surface"
                        >
                          <Mail className="size-3.5" strokeWidth={2.4} />
                        </button>
                      ) : null}
                    </div>
                  </SwipeAction>
                </motion.div>
              ))}
          </AnimatePresence>

          {filter === "all" && visibleTasks.length > 0 ? (
            <p className="px-1 pt-1.5 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Tâches</p>
          ) : null}

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
                    aria-pressed={done}
                    onClick={(event) => {
                      event.stopPropagation();
                      setState(task.id, done ? "todo" : "done");
                    }}
                    className={cn(
                      "relative grid size-5 shrink-0 place-items-center rounded-md border-2 transition-colors before:absolute before:-inset-3 before:rounded-full before:content-['']",
                      done ? "border-accent bg-accent text-accent-contrast" : "border-accent-ring/70 hover:border-accent",
                    )}
                  >
                    {done ? <Check className="size-3" strokeWidth={3.5} /> : null}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "line-clamp-2 text-[12.5px] leading-tight font-bold",
                        done ? "text-ink-muted line-through" : "text-ink",
                      )}
                    >
                      {task.title}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug font-medium text-ink-muted">{task.meta}</p>
                    {task.assignee ? (
                      <span
                        data-testid="assignee-chip"
                        title={`Assigné à ${task.assignee}`}
                        className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink"
                      >
                        <UserRound className="size-2.5 shrink-0" strokeWidth={2.8} />
                        <span className="truncate">{task.assignee}</span>
                      </span>
                    ) : null}
                    {typeof task.progress === "number" && !done ? (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <div
                          role="progressbar"
                          aria-label={"Progression de " + task.title}
                          aria-valuenow={task.progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2"
                        >
                          <div className="h-full rounded-full bg-accent" style={{ width: `${task.progress}%` }} />
                        </div>
                        <span className="shrink-0 text-[11px] font-bold tabular-nums text-ink-muted">
                          {task.progress} %
                        </span>
                      </div>
                    ) : null}
                  </div>

                  {task.dueTone !== "none" ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-1 text-[10.5px] font-extrabold whitespace-nowrap",
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
                      "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-extrabold",
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
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-medium text-ink-muted">
                {showSuggestions ? "Aucune suggestion pour l'instant." : "Aucune tâche dans ce filtre."}
              </p>
              {filter !== "all" && (
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="mt-3 rounded-full border border-line bg-surface px-3 py-1.5 text-[11.5px] font-bold text-accent-ink transition-colors hover:border-accent-ring"
                >
                  Réinitialiser le filtre
                </button>
              )}
            </div>
          )}

          {onNewTask ? (
            <button
              type="button"
              onClick={onNewTask}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-[12.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring hover:text-accent-ink"
            >
              <Plus className="size-4" />
              Nouvelle tâche
            </button>
          ) : null}
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
        <div className="absolute inset-0 z-50 flex items-end" role="dialog" aria-modal="true" aria-label="Changer l'état" data-swipe>
          <button
            type="button"
            aria-label="Fermer"
            onClick={() => setMoving(null)}
            className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
          />
          <div className="relative w-full rounded-t-[28px] border-t border-line bg-canvas px-4 pt-3 pb-28 shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
            <p className="px-1 pb-1 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Changer l'état</p>
            <p className="line-clamp-2 px-1 pb-3 text-[12.5px] font-bold text-ink">{moving.title}</p>
            <div className="space-y-1">
              {TASK_STATES.map((state) => (
                <button
                  key={state.id}
                  type="button"
                  aria-pressed={moving.state === state.id}
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
            <button
              type="button"
              onClick={() => setMoving(null)}
              className="mt-3 w-full rounded-full border border-line bg-surface py-2.5 text-[12.5px] font-bold text-ink-soft transition-colors hover:border-accent-ring"
            >
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
