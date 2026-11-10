import { useState } from "react";
import { Check } from "lucide-react";
import type { Task, TaskState } from "@/lib/tasks";
import { TASK_STATES, sortTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const DUES: { label: string; due: string; tone: Task["dueTone"] }[] = [
  { label: "Aujourd'hui", due: "aujourd'hui", tone: "late" },
  { label: "Demain", due: "demain", tone: "soon" },
  { label: "Cette semaine", due: "cette semaine", tone: "soft" },
  { label: "Sans échéance", due: "—", tone: "none" },
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
  const [due, setDue] = useState(DUES[0]);

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      id: "n-" + Date.now(),
      title: title.trim(),
      meta: "manuel",
      state,
      due: due.due,
      dueTone: due.tone,
      description: description.trim() || undefined,
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
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Intitulé de la tâche"
          autoFocus
          className="w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-[14px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-muted/70 focus:border-accent-ring"
        />

        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Description, contexte, liens…"
          className="mt-2 h-24 w-full resize-none rounded-2xl border border-line bg-surface px-3.5 py-3 text-[12.5px] leading-relaxed font-medium text-ink outline-none placeholder:text-ink-muted/70 focus:border-accent-ring"
        />

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Échéance</p>
        <div className="flex flex-wrap gap-1.5">
          {DUES.map((entry) => {
            const active = entry.label === due.label;
            return (
              <button
                key={entry.label}
                type="button"
                onClick={() => setDue(entry)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">État</p>
        <div className="flex flex-wrap gap-1.5 pb-4">
          {TASK_STATES.map((entry) => {
            const active = entry.id === state;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setState(entry.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                <span className={cn("size-1.5 rounded-full", active ? "bg-white/80" : entry.dot)} />
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
