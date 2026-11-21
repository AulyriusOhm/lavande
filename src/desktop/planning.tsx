import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Check, EyeOff, Mail, Plus, Sparkles, Trash2, UserRound, X } from "lucide-react";
import type { Mail as MailType } from "@/lib/mail";
import type { MailSuggestion, NewTaskDraft, Task, TaskState } from "@/lib/tasks";
export type { NewTaskDraft };
import {
  TASK_STATES,
  dueToneFor,
  formatDueDate,
  isoToday,
  sortTasks,
  stateMeta,
  taskFromSuggestion,
} from "@/lib/tasks";
import { capitalizeFirst } from "@/lib/calendar";
import { insertAt } from "@/lib/draft";
import { useMailStore } from "@/lib/store";
import { sourceAccountLabel } from "@/lib/accounts";
import { useEscapeLayer } from "@/desktop/escape";
import { cn } from "@/lib/utils";
import { Badge, DButton, DChip, DIconButton, PaneTitle, SectionLabel, TextArea, TextInput } from "@/desktop/ui";
import { SyncBadge } from "@/components/sync-badge";
import { TeamDatalist } from "@/components/team-datalist";
import { BorderBeam } from "@/components/ui/border-beam";
import { BlurFade } from "@/components/ui/blur-fade";
import { Avatar } from "@/components/ui/primitives";
import { createTask } from "@/screens/new-task-sheet";

type Tone = "rose" | "amber" | "neutral";

const DUE_TONE: Record<Task["dueTone"], Tone> = {
  late: "rose",
  soon: "amber",
  soft: "neutral",
  none: "neutral",
};

const LABEL = "block text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase";
const FIELD = "mt-1.5";
const FILTER_CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-bold transition-colors";

type Selection = { kind: "task"; id: string } | { kind: "suggestion"; suggestion: MailSuggestion } | null;

export function DesktopPlanning({
  onNewTask,
  onOpenSync,
}: {
  onNewTask?: () => void;
  onOpenSync: () => void;
}) {
  const { tasks, setTasks, suggestions, addSuggestion, dismissSuggestion, notify, openMessage, mails, accounts } =
    useMailStore();
  const [selection, setSelection] = useState<Selection>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskState | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  const openTasks = tasks.filter((task) => task.state !== "done").length;
  const assignees = useMemo(
    () => [...new Set(tasks.flatMap((task) => (task.assignee ? [task.assignee] : [])))],
    [tasks],
  );
  const activeAssignee =
    assigneeFilter !== null && assignees.includes(assigneeFilter) ? assigneeFilter : null;
  const taskSuggestions = suggestions.filter((suggestion) => suggestion.kind !== "event");
  const mailIndex = useMemo(() => new Map(mails.map((mail) => [mail.id, mail])), [mails]);
  const selectedTask = selection?.kind === "task" ? tasks.find((task) => task.id === selection.id) : undefined;
  const selectedSuggestion = selection?.kind === "suggestion" ? selection.suggestion : undefined;
  const linkedMail = selectedTask?.mailId ? (mailIndex.get(selectedTask.mailId) ?? null) : null;
  const suggestionMail = selectedSuggestion?.mailId
    ? (mailIndex.get(selectedSuggestion.mailId) ?? null)
    : null;

  useEscapeLayer(Boolean(selection), () => setSelection(null));

  const changeState = (id: string, state: TaskState) => {
    setTasks((current) => sortTasks(current.map((task) => (task.id === id ? { ...task, state } : task))));
  };

  const patchTask = (id: string, changes: Partial<Task>) => {
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...changes } : task)));
  };

  const removeTask = (task: Task) => {
    const index = tasks.findIndex((entry) => entry.id === task.id);
    setTasks((current) => current.filter((entry) => entry.id !== task.id));
    setSelection(null);
    notify("Tâche supprimée", {
      label: "Annuler",
      run: () =>
        setTasks((current) =>
          current.some((entry) => entry.id === task.id) ? current : insertAt(current, index, task),
        ),
    });
  };

  const drop = (event: React.DragEvent<HTMLElement>, state: TaskState) => {
    event.preventDefault();
    setOver(null);
    const id = event.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    const task = tasks.find((entry) => entry.id === id);
    if (!task || task.state === state) return;
    const previous = task.state;
    changeState(task.id, state);
    notify(`Tâche déplacée · ${stateMeta(state).label}`, {
      label: "Annuler",
      run: () => changeState(task.id, previous),
    });
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden pb-[104px]">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3">
        <PaneTitle hint={`${openTasks} ouvertes`}>Planification</PaneTitle>
        <div className="ml-auto flex items-center gap-2">
          <SyncBadge onOpen={onOpenSync} />
          {taskSuggestions.length > 0 ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[11px] font-extrabold text-accent-ink">
              <Sparkles className="size-3" strokeWidth={2.8} />
              <span className="tabular-nums">{taskSuggestions.length}</span>
              <span className="font-bold">{taskSuggestions.length > 1 ? "suggestions" : "suggestion"}</span>
            </span>
          ) : null}
          {onNewTask ? (
            <DButton variant="primary" size="md" onClick={onNewTask}>
              <Plus className="size-3.5" strokeWidth={3} />
              Nouvelle tâche
            </DButton>
          ) : null}
        </div>
      </header>

      {taskSuggestions.length > 0 ? (
        <div className="mt-3.5 flex shrink-0 gap-2.5 overflow-x-auto px-5 pb-1">
          {taskSuggestions.map((suggestion, index) => (
            <motion.article
              key={suggestion.id}
              data-testid="suggestion-card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
              className="relative w-[276px] shrink-0 rounded-[20px] border border-dashed border-accent-ring/70 bg-accent-soft/40 p-3 transition-colors duration-200 hover:border-accent-ring hover:bg-accent-soft/70"
            >
              {index === 0 ? <BorderBeam /> : null}
              <button
                type="button"
                onClick={() => setSelection({ kind: "suggestion", suggestion })}
                className="focus-ring block w-full cursor-pointer text-left"
              >
                <span className="flex items-center gap-1.5">
                  <span
                    data-testid="suggestion-account"
                    className="inline-flex h-[20px] shrink-0 items-center rounded-full bg-surface px-1.5 text-[10.5px] font-extrabold whitespace-nowrap text-accent-ink"
                  >
                    {sourceAccountLabel(accounts, suggestion.account)}
                  </span>
                  {suggestion.ai ? (
                    <span
                      data-testid="suggestion-ai"
                      title="Suggéré par l'IA"
                      className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface text-accent-ink"
                    >
                      <Sparkles className="size-2.5" strokeWidth={2.6} />
                      <span className="sr-only">Suggéré par l'IA</span>
                    </span>
                  ) : null}
                  <span className="truncate text-[11px] font-bold text-ink">{suggestion.from}</span>
                </span>
                <span className="mt-1 line-clamp-2 block text-[11.5px] leading-snug font-medium text-ink-muted">
                  {suggestion.subject}
                </span>
                <span className="mt-1.5 block text-[13px] leading-tight font-extrabold tracking-[-0.02em] text-ink">
                  {suggestion.proposal}
                </span>
                {suggestion.due ? (
                  <span data-testid="suggestion-due" className="mt-2 flex items-center gap-1.5">
                    <Badge tone={DUE_TONE[suggestion.dueTone]}>{suggestion.due}</Badge>
                  </span>
                ) : null}
              </button>
              <div className="mt-2.5 flex items-center gap-1.5">
                <DButton
                  size="sm"
                  variant="soft"
                  onClick={() => addSuggestion(suggestion)}
                  aria-label={`Ajouter : ${suggestion.proposal}`}
                >
                  <Plus className="size-3.5" strokeWidth={3} />
                  Ajouter
                </DButton>
                {mailIndex.has(suggestion.mailId) ? (
                  <DIconButton
                    label={`Voir le mail d'origine : ${suggestion.subject}`}
                    className="size-8"
                    onClick={() => openMessage(suggestion.mailId)}
                  >
                    <Mail className="size-3.5" />
                  </DIconButton>
                ) : null}
                <DIconButton
                  label="Masquer la suggestion"
                  className="size-8"
                  onClick={() => dismissSuggestion(suggestion)}
                >
                  <EyeOff className="size-3.5" />
                </DIconButton>
              </div>
            </motion.article>
          ))}
        </div>
      ) : null}

      {assignees.length > 0 ? (
        <div className="mt-3 flex shrink-0 flex-wrap items-center gap-1.5 px-5">
          <button
            type="button"
            onClick={() => setAssigneeFilter(null)}
            aria-pressed={activeAssignee === null}
            className={cn(
              FILTER_CHIP,
              assigneeFilter === null
                ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
            )}
          >
            Tous
          </button>
          {assignees.map((name) => (
            <button
              key={name}
              type="button"
              data-testid={`assignee-filter-${name}`}
              onClick={() => setAssigneeFilter(name)}
              aria-pressed={activeAssignee === name}
              className={cn(
                FILTER_CHIP,
                assigneeFilter === name
                  ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                  : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
              )}
            >
              <UserRound className="size-2.5" strokeWidth={2.8} />
              {name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-[repeat(5,minmax(220px,1fr))] gap-3.5 overflow-x-auto px-5 pb-2">
        {TASK_STATES.map((state) => {
          const columnTasks = tasks.filter(
            (task) => task.state === state.id && (activeAssignee === null || task.assignee === activeAssignee),
          );
          const active = over === state.id;
          return (
            <section
              key={state.id}
              aria-label={state.label}
              data-testid={`column-${state.id}`}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(state.id);
              }}
              onDragLeave={() => setOver((current) => (current === state.id ? null : current))}
              onDrop={(event) => drop(event, state.id)}
              className={cn(
                "flex min-h-0 flex-col rounded-[24px] border p-2 transition-[background-color,border-color,box-shadow] duration-200",
                active
                  ? "border-accent-ring bg-accent-soft/60 shadow-[0_18px_40px_-34px_var(--accent)]"
                  : "border-line/80 bg-surface-2/40",
              )}
            >
              <div className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-2">
                <span className={cn("size-2 shrink-0 rounded-full", state.dot)} />
                <SectionLabel className="truncate tracking-[0.1em]">{state.label}</SectionLabel>
                <span
                  className={cn(
                    "ml-auto grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1 text-[10px] font-extrabold tabular-nums transition-colors duration-200",
                    columnTasks.length > 0 ? state.chip : "bg-surface text-ink-muted",
                  )}
                >
                  {columnTasks.length}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
                {columnTasks.map((task, index) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    index={index}
                    dragging={dragging === task.id}
                    onOpen={() => setSelection({ kind: "task", id: task.id })}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", task.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(task.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                  />
                ))}
                {columnTasks.length === 0 ? (
                  <p
                    className={cn(
                      "grid place-items-center rounded-[18px] border border-dashed px-2 py-4 text-center text-[10.5px] font-semibold transition-colors duration-200",
                      active ? "border-accent-ring text-accent-ink" : "border-line text-ink-muted/80",
                    )}
                  >
                    Aucune tâche
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {selectedTask ? (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          mail={linkedMail}
          onClose={() => setSelection(null)}
          onStateChange={(state) => changeState(selectedTask.id, state)}
          onPatch={(changes) => patchTask(selectedTask.id, changes)}
          onDelete={() => removeTask(selectedTask)}
          onOpenMail={(mail) => {
            openMessage(mail);
            setSelection(null);
          }}
        />
      ) : null}

      {selectedSuggestion ? (
        <SuggestionDetail
          suggestion={selectedSuggestion}
          account={sourceAccountLabel(accounts, selectedSuggestion.account)}
          mail={suggestionMail}
          onClose={() => setSelection(null)}
          onAdd={() => {
            addSuggestion(selectedSuggestion);
            setSelection(null);
          }}
          onDismiss={() => {
            dismissSuggestion(selectedSuggestion);
            setSelection(null);
          }}
          onOpenMail={(mail) => {
            openMessage(mail);
            setSelection(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TaskCard({
  task,
  index,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  index: number;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  const done = task.state === "done";
  const subtasks = task.subtasks ?? [];
  const doneCount = subtasks.filter((subtask) => subtask.done).length;

  return (
    <BlurFade delay={Math.min(index, 8) * 0.04} yOffset={8}>
      <button
        type="button"
        draggable
        data-testid="task-card"
        data-task-id={task.id}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        className={cn(
          "focus-ring w-full cursor-grab rounded-[18px] border border-line bg-surface px-3 py-2.5 text-left transition-[border-color,box-shadow,background-color,transform] duration-200 active:cursor-grabbing",
          dragging
            ? "rotate-[-0.75deg] border-accent-ring opacity-70 shadow-[0_22px_44px_-26px_var(--accent)]"
            : "hover:-translate-y-px hover:border-accent-ring hover:shadow-[0_16px_34px_-28px_var(--accent)]",
          done && "bg-surface-2/60",
        )}
      >
        <span className="flex items-start gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 text-[12.5px] leading-snug font-extrabold tracking-[-0.02em]",
              done ? "text-ink-muted line-through" : "text-ink",
            )}
          >
            {task.title}
          </span>
          {task.mailId ? (
            <span
              title="Issu d'un mail"
              className="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink"
            >
              <Mail className="size-2.5" strokeWidth={2.6} />
              <span className="sr-only">Issu d'un mail</span>
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-[11px] font-semibold text-ink-muted">{task.meta}</span>
        {typeof task.progress === "number" ? (
          <span className="mt-2 flex items-center gap-2">
            <span
              role="progressbar"
              aria-label={`Progression de ${task.title}`}
              aria-valuenow={task.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              className="block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
            >
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${task.progress}%` }}
              />
            </span>
            <span className="shrink-0 text-[10px] font-extrabold text-ink-muted tabular-nums">
              {task.progress}%
            </span>
          </span>
        ) : null}
        <span className="mt-2 flex items-center gap-1.5">
          <Badge tone={DUE_TONE[task.dueTone]}>{task.due}</Badge>
          {subtasks.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold text-ink-muted tabular-nums">
              <Check className="size-2.5" strokeWidth={3.2} />
              {doneCount}/{subtasks.length}
            </span>
          ) : null}
          {task.assignee ? (
            <span
              data-testid="assignee-chip"
              title={`Assigné à ${task.assignee}`}
              className="ml-auto inline-flex min-w-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink"
            >
              <UserRound className="size-2.5 shrink-0" strokeWidth={2.8} />
              <span className="truncate">{task.assignee}</span>
            </span>
          ) : null}
        </span>
      </button>
    </BlurFade>
  );
}

function Panel({
  label,
  dot,
  onClose,
  children,
}: {
  label: string;
  dot?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <motion.aside
      initial={{ x: 430 }}
      animate={{ x: 0 }}
      transition={{ type: "spring", stiffness: 340, damping: 34 }}
      className="absolute inset-y-0 right-0 z-[25] flex w-[430px] flex-col border-l border-line bg-surface shadow-[-34px_0_80px_-56px_var(--accent)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        {dot ? <span className={cn("size-2 shrink-0 rounded-full", dot)} /> : null}
        <SectionLabel>{label}</SectionLabel>
        <DIconButton label="Fermer le panneau" className="ml-auto size-8" onClick={onClose}>
          <X className="size-4" />
        </DIconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-[104px]">{children}</div>
    </motion.aside>
  );
}

function TaskDetail({
  task,
  mail,
  onClose,
  onStateChange,
  onPatch,
  onDelete,
  onOpenMail,
}: {
  task: Task;
  mail: MailType | null;
  onClose: () => void;
  onStateChange: (state: TaskState) => void;
  onPatch: (changes: Partial<Task>) => void;
  onDelete: () => void;
  onOpenMail: (mail: MailType) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const subtasks = task.subtasks ?? [];
  const doneCount = subtasks.filter((subtask) => subtask.done).length;

  const setDue = (value: string) => {
    onPatch(
      value
        ? { dueDate: value, due: formatDueDate(value), dueTone: dueToneFor(value) }
        : { dueDate: undefined, due: "sans échéance", dueTone: "none" },
    );
  };

  const toggleSubtask = (index: number) => {
    onPatch({
      subtasks: subtasks.map((subtask, position) =>
        position === index ? { ...subtask, done: !subtask.done } : subtask,
      ),
    });
  };

  return (
    <Panel label="Tâche" dot={stateMeta(task.state).dot} onClose={onClose}>
      <div className="flex flex-wrap gap-1.5 rounded-[18px] border border-line bg-surface-2/40 p-2">
        {TASK_STATES.map((state) => {
          const active = state.id === task.state;
          return (
            <DChip key={state.id} active={active} onClick={() => onStateChange(state.id)}>
              <span
                className={cn("size-1.5 rounded-full", active ? "bg-accent-contrast/80" : state.dot)}
              />
              {state.label}
            </DChip>
          );
        })}
      </div>

      <label className={cn(LABEL, "mt-4")} htmlFor="desk-task-title">
        Intitulé
      </label>
      <TextInput
        id="desk-task-title"
        className={FIELD}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          if (event.target.value.trim()) onPatch({ title: event.target.value });
        }}
        onBlur={() => {
          if (!title.trim()) setTitle(task.title);
          else if (title !== title.trim()) {
            setTitle(title.trim());
            onPatch({ title: title.trim() });
          }
        }}
      />

      <label className={cn(LABEL, "mt-4")} htmlFor="desk-task-due">
        Échéance
      </label>
      <div className={cn(FIELD, "flex items-center gap-2")}>
        <TextInput
          id="desk-task-due"
          type="date"
          className="min-w-0 flex-1"
          value={task.dueDate ?? ""}
          onChange={(event) => setDue(event.target.value)}
        />
        <Badge tone={DUE_TONE[task.dueTone]}>{task.due}</Badge>
      </div>
      <p className="mt-1.5 text-[10.5px] font-semibold text-ink-muted">
        {task.dueDate ? capitalizeFirst(formatDueDate(task.dueDate)) : "Aucune échéance"}
      </p>

      <label className={cn(LABEL, "mt-4")} htmlFor="desk-task-assignee">
        Assignée à
      </label>
      <TextInput
        id="desk-task-assignee"
        className={FIELD}
        list="desk-team-members"
        value={task.assignee ?? ""}
        placeholder="Personne"
        onChange={(event) => onPatch({ assignee: event.target.value || undefined })}
        onBlur={() => onPatch({ assignee: task.assignee?.trim() || undefined })}
      />
      <TeamDatalist id="desk-team-members" />

      <label className={cn(LABEL, "mt-4")} htmlFor="desk-task-description">
        Description
      </label>
      <TextArea
        id="desk-task-description"
        className={cn(FIELD, "h-24")}
        value={task.description ?? ""}
        placeholder="Contexte, liens, points bloquants…"
        onChange={(event) => onPatch({ description: event.target.value || undefined })}
      />

      {subtasks.length > 0 ? (
        <>
          <div className="mt-4 flex items-baseline justify-between">
            <SectionLabel>Sous-tâches</SectionLabel>
            <span className="text-[10px] font-bold text-ink-muted tabular-nums">
              {doneCount}/{subtasks.length}
            </span>
          </div>
          <div className="mt-2 space-y-1.5">
            {subtasks.map((subtask, index) => (
              <button
                key={subtask.title}
                type="button"
                onClick={() => toggleSubtask(index)}
                aria-pressed={subtask.done}
                className="focus-ring flex w-full items-center gap-2.5 rounded-[16px] border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:border-accent-ring/70"
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-md border-2 transition-colors",
                    subtask.done
                      ? "border-accent bg-accent text-accent-contrast"
                      : "border-accent-ring/70",
                  )}
                >
                  {subtask.done ? <Check className="size-2.5" strokeWidth={3.5} /> : null}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12px] font-semibold",
                    subtask.done ? "text-ink-muted line-through" : "text-ink",
                  )}
                >
                  {subtask.title}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {mail ? (
        <>
          <SectionLabel className="mt-4">Mail lié</SectionLabel>
          <div className="mt-2 overflow-hidden rounded-[18px] border border-line bg-surface">
            <div className="flex items-start gap-2.5 px-3 pt-2.5">
              <Avatar name={mail.name} tone={mail.tone} size={32} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[12px] font-bold text-ink">{mail.name}</p>
                <p className="truncate text-[10px] font-medium text-ink-muted">{mail.time}</p>
              </div>
            </div>
            <p className="mt-2 px-3 text-[12px] font-bold text-ink">{mail.subject}</p>
            <p className="mt-1 line-clamp-2 px-3 text-[11px] leading-relaxed font-medium text-ink-muted">
              {mail.preview}
            </p>
            <button
              type="button"
              onClick={() => onOpenMail(mail)}
              className="focus-ring mt-2.5 flex w-full items-center gap-2 border-t border-line bg-accent-soft/50 px-3 py-2.5 text-left text-[11.5px] font-extrabold text-accent-ink transition-colors hover:bg-accent-soft"
            >
              <Mail className="size-3.5" />
              Ouvrir le mail
            </button>
          </div>
        </>
      ) : null}

      <DButton variant="danger" className="mt-5 w-full" onClick={onDelete}>
        <Trash2 className="size-3.5" />
        Supprimer
      </DButton>
    </Panel>
  );
}

function SuggestionDetail({
  suggestion,
  account,
  mail,
  onClose,
  onAdd,
  onDismiss,
  onOpenMail,
}: {
  suggestion: MailSuggestion;
  account: string;
  mail: MailType | null;
  onClose: () => void;
  onAdd: () => void;
  onDismiss: () => void;
  onOpenMail: (mail: MailType) => void;
}) {
  const task = taskFromSuggestion(suggestion, `sugg-${suggestion.id}`);

  return (
    <Panel label="Suggestion issue d'un mail" onClose={onClose}>
      <div className="rounded-[18px] border border-dashed border-accent-ring/70 bg-accent-soft/40 p-3">
        <div className="flex items-center gap-2">
          <Avatar name={suggestion.from} tone={suggestion.tone} size={30} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-surface px-1.5 text-[10px] font-extrabold whitespace-nowrap text-accent-ink">
                {account}
              </span>
              <p className="min-w-0 truncate text-[12px] font-bold text-ink">{suggestion.from}</p>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] font-medium text-ink-muted">{suggestion.subject}</p>
          </div>
          {suggestion.due ? <Badge tone={DUE_TONE[suggestion.dueTone]}>{suggestion.due}</Badge> : null}
        </div>
        <p className="mt-3 text-[13px] leading-tight font-extrabold tracking-[-0.02em] text-ink">
          {task.title}
        </p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed font-medium text-ink-soft">
          {task.description}
        </p>
        <p className="mt-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">{task.meta}</p>
      </div>

      <DButton variant="primary" className="mt-4 w-full" onClick={onAdd}>
        <Plus className="size-4" strokeWidth={3} />
        Ajouter à la planification
      </DButton>
      {mail ? (
        <DButton variant="soft" className="mt-2 w-full" onClick={() => onOpenMail(mail)}>
          <Mail className="size-3.5" />
          Ouvrir le mail
        </DButton>
      ) : null}
      <DButton variant="ghost" className="mt-2 w-full" onClick={onDismiss}>
        <EyeOff className="size-3.5" />
        Ignorer
      </DButton>
    </Panel>
  );
}

const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function NewTaskDialog({
  open,
  draft,
  onClose,
}: {
  open: boolean;
  draft?: NewTaskDraft;
  onClose: () => void;
}) {
  const { setTasks, notify } = useMailStore();
  if (!open) return null;

  const submit = (task: Task) => {
    setTasks((current) => createTask(current, task));
    notify("Tâche créée");
    onClose();
  };

  return <NewTaskForm draft={draft} onCreate={submit} onClose={onClose} />;
}

function NewTaskForm({
  draft,
  onCreate,
  onClose,
}: {
  draft?: NewTaskDraft;
  onCreate: (task: Task) => void;
  onClose: () => void;
}) {
  const initialDue = draft
    ? draft.dueDate && ISO_DAY.test(draft.dueDate)
      ? draft.dueDate
      : isoToday(0)
    : isoToday(1);
  const [title, setTitle] = useState(draft?.title ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [state, setState] = useState<TaskState>("todo");
  const [dueDate, setDueDate] = useState(initialDue);
  const [assignee, setAssignee] = useState(draft?.assignee ?? "");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const valid = title.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onCreate({
      id: `t-${Date.now()}`,
      title: title.trim(),
      meta: draft?.mailFrom ? `mail · ${draft.mailFrom}` : "manuel",
      state,
      due: dueDate ? formatDueDate(dueDate) : "sans échéance",
      dueTone: dueDate ? dueToneFor(dueDate) : "none",
      dueDate: dueDate || undefined,
      description: description.trim() || undefined,
      assignee: assignee.trim() || undefined,
      ...(draft?.mailId ? { mailId: draft.mailId } : {}),
    });
  };

  return (
    <div className="absolute inset-0 z-40 grid place-items-center">
      <button
        type="button"
        aria-label="Fermer la fenêtre"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
      />
      <motion.div
        role="dialog"
        aria-modal
        aria-label="Nouvelle tâche"
        initial={{ opacity: 0, y: 10, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-[520px] rounded-[26px] border border-line bg-surface p-5 shadow-[0_44px_96px_-48px_var(--accent)]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
            Nouvelle tâche
          </h2>
          <DIconButton label="Fermer" className="size-8" onClick={onClose}>
            <X className="size-4" />
          </DIconButton>
        </div>

        {draft?.mailId ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-[16px] border border-accent-ring/50 bg-accent-soft/45 px-3 py-2">
            <Mail className="mt-0.5 size-3.5 shrink-0 text-accent-ink" strokeWidth={2.4} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[10px] font-bold tracking-[0.14em] text-accent-ink uppercase">
                Mail lié
              </p>
              {draft.mailFrom ? (
                <p className="mt-0.5 truncate text-[12px] font-bold text-ink">{draft.mailFrom}</p>
              ) : null}
              {draft.mailSubject ? (
                <p className="truncate text-[11.5px] font-medium text-ink-soft">{draft.mailSubject}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        <label className={cn(LABEL, "mt-3")} htmlFor="new-task-title">
          Intitulé
        </label>
        <TextInput
          id="new-task-title"
          autoFocus
          className={FIELD}
          value={title}
          placeholder="Relancer Marc pour les accès serveur"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />

        <label className={cn(LABEL, "mt-4")} htmlFor="new-task-due">
          Échéance
        </label>
        <div className={cn(FIELD, "flex items-center gap-2")}>
          <TextInput
            id="new-task-due"
            type="date"
            className="min-w-0 flex-1"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
          <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[10.5px] font-bold text-ink-soft">
            {dueDate ? formatDueDate(dueDate) : "sans échéance"}
          </span>
        </div>

        <label className={cn(LABEL, "mt-4")} htmlFor="new-task-assignee">
          Assignée à
        </label>
        <TextInput
          id="new-task-assignee"
          className={FIELD}
          list="new-task-team-members"
          value={assignee}
          placeholder="Personne"
          onChange={(event) => setAssignee(event.target.value)}
        />
        <TeamDatalist id="new-task-team-members" />

        <p className={cn(LABEL, "mt-4")}>État</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {TASK_STATES.map((entry) => {
            const active = entry.id === state;
            return (
              <DChip key={entry.id} active={active} onClick={() => setState(entry.id)}>
                <span
                  className={cn("size-1.5 rounded-full", active ? "bg-accent-contrast/80" : entry.dot)}
                />
                {entry.label}
              </DChip>
            );
          })}
        </div>

        <label className={cn(LABEL, "mt-4")} htmlFor="new-task-description">
          Description
        </label>
        <TextArea
          id="new-task-description"
          className={cn(FIELD, "h-20")}
          value={description}
          placeholder="Contexte, liens, pièces jointes…"
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="mt-5 flex items-center justify-end gap-2">
          <DButton variant="plain" onClick={onClose}>
            Annuler
          </DButton>
          <DButton variant="primary" onClick={submit} disabled={!valid}>
            <Check className="size-4" strokeWidth={3} />
            Créer la tâche
          </DButton>
        </div>
      </motion.div>
    </div>
  );
}
