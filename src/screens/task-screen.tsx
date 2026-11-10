import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Clock, Mail, Plus, Trash2 } from "lucide-react";
import type { Mail as MailType } from "@/lib/mail";
import { accountById } from "@/lib/accounts";
import type { Task, TaskState } from "@/lib/tasks";
import { TASK_STATES, stateMeta } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { Avatar, SectionTitle } from "@/components/ui/primitives";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const DUE_STYLE: Record<Task["dueTone"], string> = {
  late: "bg-red-500/12 text-red-700 dark:text-red-300",
  soon: "bg-accent-soft text-accent-ink",
  soft: "bg-surface-2 text-ink-soft",
  none: "bg-surface-2 text-ink-muted",
};

export function TaskScreen({
  task,
  mail,
  suggestion = false,
  onClose,
  onChangeState,
  onToggleSubtask,
  onOpenMail,
  onAdd,
}: {
  task: Task;
  mail?: MailType | null;
  suggestion?: boolean;
  onClose: () => void;
  onChangeState?: (state: TaskState) => void;
  onToggleSubtask?: (index: number) => void;
  onOpenMail: () => void;
  onAdd?: () => void;
}) {
  const meta = stateMeta(task.state);
  const done = task.state === "done";
  const subtasks = task.subtasks ?? [];
  const doneCount = subtasks.filter((subtask) => subtask.done).length;

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <MeshGlow className="h-40" />

      <header className="relative z-10 flex items-center gap-1 px-2.5 pt-3 pb-1">
        <button
          type="button"
          onClick={onClose}
          aria-label="Retour"
          className="grid size-9 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-2"
        >
          <ArrowLeft className="size-4.5" />
        </button>
        <span
          className={cn(
            "ml-1 rounded-full px-2.5 py-1 text-[10px] font-extrabold",
            suggestion ? "bg-accent-soft text-accent-ink" : meta.chip,
          )}
        >
          {suggestion ? "Suggestion" : meta.label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {suggestion ? null : (
            <button
              type="button"
              aria-label="Supprimer la tâche"
              className="grid size-9 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-2"
            >
              <Trash2 className="size-4.5" />
            </button>
          )}
        </div>
      </header>

      <div className="relative flex-1 overflow-y-auto no-scrollbar px-5 pb-6">
        <BlurFade yOffset={6}>
          <h1
            className={cn(
              "mt-2 text-[22px] leading-[1.2] font-extrabold tracking-[-0.025em]",
              done ? "text-ink-muted line-through" : "text-ink",
            )}
          >
            {task.title}
          </h1>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[10.5px] font-bold text-ink-soft">
              <Clock className="size-3" />
              {task.due}
            </span>
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10.5px] font-semibold text-ink-soft">
              {task.meta}
            </span>
            {task.dueTone === "late" ? (
              <span className={cn("rounded-full px-2.5 py-1 text-[10.5px] font-extrabold", DUE_STYLE.late)}>
                en retard
              </span>
            ) : null}
          </div>
        </BlurFade>

        {!suggestion && <SectionTitle>État</SectionTitle>}
        <div className={cn("flex flex-wrap gap-1.5 px-5", suggestion && "hidden")}>
          {TASK_STATES.map((state) => {
            const active = state.id === task.state;
            return (
              <button
                key={state.id}
                type="button"
                onClick={() => onChangeState?.(state.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                <span className={cn("size-1.5 rounded-full", active ? "bg-white/80" : state.dot)} />
                {state.label}
              </button>
            );
          })}
        </div>

        <SectionTitle>Description</SectionTitle>
        <BlurFade delay={0.06}>
          <p className="px-5 text-[13px] leading-[1.7] font-medium text-ink-soft">
            {task.description ?? "Pas de description pour cette tâche."}
          </p>
        </BlurFade>

        {subtasks.length > 0 && (
          <>
            <SectionTitle hint={`${doneCount}/${subtasks.length}`}>Checklist</SectionTitle>
            <div className="mx-4 space-y-1.5">
              {subtasks.map((subtask, index) => (
                <button
                  key={subtask.title}
                  type="button"
                  onClick={() => onToggleSubtask?.(index)}
                  className="flex w-full items-center gap-2.5 rounded-2xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent-ring/70"
                >
                  <span
                    className={cn(
                      "grid size-4.5 shrink-0 place-items-center rounded-md border-2 transition-colors",
                      subtask.done ? "border-accent bg-accent text-white" : "border-accent-ring/70",
                    )}
                  >
                    {subtask.done ? <Check className="size-2.5" strokeWidth={3.5} /> : null}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[12.5px] font-semibold",
                      subtask.done ? "text-ink-muted line-through" : "text-ink",
                    )}
                  >
                    {subtask.title}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {mail ? (
          <>
            <SectionTitle>Mail lié</SectionTitle>
            <BlurFade delay={0.12}>
              <div className="mx-4 overflow-hidden rounded-3xl border border-line bg-surface">
                <div className="flex items-start gap-2.5 px-3.5 pt-3">
                  <Avatar name={mail.name} tone={mail.tone} size={34} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-[12px] font-bold text-ink">{mail.name}</p>
                    <p className="truncate text-[10px] font-medium text-ink-muted">{mail.time}</p>
                  </div>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[9.5px] font-bold text-ink-soft">
                    {accountById(mail.account)?.label ?? mail.account}
                  </span>
                </div>
                <p className="mt-2 px-3.5 text-[12.5px] font-bold text-ink">{mail.subject}</p>
                <p className="mt-1 line-clamp-2 px-3.5 text-[11.5px] leading-relaxed font-medium text-ink-muted">
                  {mail.preview}
                </p>
                <button
                  type="button"
                  onClick={onOpenMail}
                  className="mt-2.5 flex w-full items-center gap-2 border-t border-line/70 bg-accent-soft/50 px-3.5 py-2.5 text-left text-[11.5px] font-extrabold text-accent-ink transition-colors hover:bg-accent-soft"
                >
                  <Mail className="size-3.5" />
                  Ouvrir le mail
                  <ChevronRight className="ml-auto size-3.5" />
                </button>
              </div>
            </BlurFade>
          </>
        ) : (
          <>
            <SectionTitle>Mail lié</SectionTitle>
            <div className="mx-4 rounded-3xl border border-dashed border-line px-3.5 py-3.5">
              <p className="text-[11.5px] font-semibold text-ink-muted">
                Aucun mail rattaché — tâche créée à la main ou depuis un événement.
              </p>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-extrabold text-accent-ink"
              >
                Rattacher un mail
                <ArrowUpRight className="size-3" />
              </button>
            </div>
          </>
        )}
      </div>

      <div className="relative border-t border-line/80 px-5 py-3 glass safe-bottom sm:pb-5">
        {suggestion ? (
          <ShimmerButton className="w-full" onClick={onAdd}>
            <Plus className="size-4" strokeWidth={3} />
            Ajouter à la planification
          </ShimmerButton>
        ) : (
          <ShimmerButton className="w-full" onClick={() => onChangeState?.(done ? "todo" : "done")}>
            <Check className="size-4" strokeWidth={3} />
            {done ? "Rouvrir la tâche" : "Marquer comme faite"}
          </ShimmerButton>
        )}
      </div>
    </div>
  );
}
