import { useState } from "react";
import { Check } from "lucide-react";
import type { Task, TaskState } from "@/lib/tasks";
import { TASK_STATES, dueToneFor, formatDueDate, isoEndOfWeek, isoToday, sortTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { TeamDatalist } from "@/components/team-datalist";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const SHORTCUTS = [
  { label: "Aujourd'hui", iso: () => isoToday(0) },
  { label: "Demain", iso: () => isoToday(1) },
  { label: "Cette semaine", iso: () => isoEndOfWeek() },
];

export function NewTaskSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (task: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<TaskState>("todo");
  const [dueDate, setDueDate] = useState(isoToday(0));
  const [assignee, setAssignee] = useState("");

  const dueLabel = dueDate ? formatDueDate(dueDate) : "sans échéance";

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      id: "n-" + Date.now(),
      title: title.trim(),
      meta: "manuel",
      state,
      due: dueLabel,
      dueTone: dueDate ? dueToneFor(dueDate) : "none",
      dueDate: dueDate || undefined,
      description: description.trim() || undefined,
      assignee: assignee.trim() || undefined,
    });
    onClose();
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Nouvelle tâche</h2>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11.5px] font-bold text-accent-ink"
        >
          Annuler
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4">
        <label className="block text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase" htmlFor="task-title">
          Intitulé
        </label>
        <input
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Intitulé de la tâche"
          autoFocus
          className="mt-1.5 w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-[14px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-soft focus:border-accent-ring"
        />

        <label className="mt-3 block text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase" htmlFor="task-description">
          Description
        </label>
        <textarea
          id="task-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Description, contexte, liens…"
          className="mt-1.5 h-24 w-full resize-none rounded-2xl border border-line bg-surface px-3.5 py-3 text-[12.5px] leading-relaxed font-medium text-ink outline-none placeholder:text-ink-soft focus:border-accent-ring"
        />

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Échéance</p>
        <div className="flex flex-wrap gap-1.5">
          {SHORTCUTS.map((entry) => {
            const active = entry.iso() === dueDate;
            return (
              <button
                key={entry.label}
                type="button"
                aria-pressed={active}
                onClick={() => setDueDate(entry.iso())}
                className={cn(
                  "rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                {entry.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={dueDate === ""}
            onClick={() => setDueDate("")}
            className={cn(
              "rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
              dueDate === ""
                ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
            )}
          >
            Sans échéance
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <label className="text-[10.5px] font-semibold text-ink-muted" htmlFor="task-due">
            Choisir une date
          </label>
          <input
            id="task-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className="rounded-2xl border border-line bg-surface px-2.5 py-2 text-[12px] font-bold text-ink outline-none focus:border-accent-ring"
          />
        </div>
        <p className="mt-1.5 text-[10.5px] font-semibold text-ink-muted">
          {dueDate ? `Échéance retenue : ${formatDueDate(dueDate)}` : "Aucune échéance"}
        </p>

        <label
          className="mt-4 block text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase"
          htmlFor="task-assignee"
        >
          Assignée à
        </label>
        <input
          id="task-assignee"
          list="task-team-members"
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
          placeholder="Personne"
          className="mt-1.5 w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-[13px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-soft focus:border-accent-ring"
        />
        <TeamDatalist id="task-team-members" />

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">État</p>
        <div className="flex flex-wrap gap-1.5 pb-4">
          {TASK_STATES.map((entry) => {
            const active = entry.id === state;
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={active}
                onClick={() => setState(entry.id)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                <span className={cn("size-1.5 rounded-full", active ? "bg-accent-contrast/80" : entry.dot)} />
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-line/80 px-4 py-3 glass safe-bottom sm:pb-5">
        <ShimmerButton className="w-full" onClick={submit} disabled={!title.trim()}>
          <Check className="size-4" strokeWidth={3} />
          Créer la tâche
        </ShimmerButton>
      </div>
    </div>
  );
}

export function createTask(tasks: Task[], task: Task) {
  return sortTasks([task, ...tasks]);
}
