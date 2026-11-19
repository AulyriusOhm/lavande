import { useEffect } from "react";
import { AlertTriangle, Clock, Loader2, MapPin, Sparkles, X } from "lucide-react";
import type { AnalyseResult, AnalyseTask, FreeSlot } from "@/lib/analyse";
import type { SummaryEvent } from "@/lib/summary";
import type { MailAnalyse } from "@/lib/store";
import type { Mail } from "@/lib/mail";
import { dueToneFor, formatDueDate } from "@/lib/tasks";
import { clockOf } from "@/lib/utils";
import { isoTime } from "@/lib/calendar";
import { Badge, DButton, DIconButton } from "@/desktop/ui";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const TONES = { late: "rose", soon: "amber", soft: "accent", none: "neutral" } as const;

function slotLabel(slot: FreeSlot): string {
  return `${slot.start}–${slot.end}`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">{children}</h3>
  );
}

function TaskCard({ task, onAccept }: { task: AnalyseTask; onAccept: () => void }) {
  const day = ISO_DAY.test(task.due) ? task.due : "";
  return (
    <div
      data-testid="analyse-task"
      className="rounded-2xl border border-line bg-surface-2/60 px-3 py-2.5"
    >
      <p className="text-[12.5px] leading-tight font-bold text-ink">{task.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {day ? (
          <Badge tone={TONES[dueToneFor(day)]}>
            <Clock className="size-3" strokeWidth={2.6} />
            {formatDueDate(day)}
          </Badge>
        ) : null}
        {task.assignee ? (
          <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-ink">
            {task.assignee}
          </span>
        ) : null}
      </div>
      <DButton size="sm" variant="soft" className="mt-2 max-sm:min-h-11" onClick={onAccept}>
        Ajouter à la planif
      </DButton>
    </div>
  );
}

function EventCard({
  event,
  result,
  onAccept,
}: {
  event: SummaryEvent;
  result: AnalyseResult;
  onAccept: () => void;
}) {
  const conflict = result.conflicts.find(
    (entry) =>
      entry.proposed.title === event.title &&
      entry.proposed.date === event.date &&
      entry.proposed.start === event.start,
  );
  const slots = result.slots.filter((slot) => slot.date === event.date).slice(0, 2);
  const start = isoTime(event.start);
  const end = isoTime(event.end);
  const hours = [start, end].filter(Boolean).join(" → ");

  return (
    <div
      data-testid="analyse-event"
      className="rounded-2xl border border-line bg-surface-2/60 px-3 py-2.5"
    >
      <p className="text-[12.5px] leading-tight font-bold text-ink">{event.title}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[11px] font-bold text-ink-muted tabular-nums">
        <Clock className="size-3 shrink-0" strokeWidth={2.6} />
        <span className="truncate">
          {[ISO_DAY.test(event.date) ? formatDueDate(event.date) : event.date, hours]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </p>
      {event.location ? (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
          <MapPin className="size-3 shrink-0" strokeWidth={2.6} />
          <span className="truncate">{event.location}</span>
        </p>
      ) : null}
      {conflict ? (
        <p data-testid="analyse-conflict" className="mt-1.5">
          <Badge tone="amber" className="max-w-full">
            <AlertTriangle className="size-3 shrink-0" strokeWidth={2.6} />
            <span className="truncate">
              Conflit : {conflict.event.title} · {conflict.event.start}-{conflict.event.end}
            </span>
          </Badge>
        </p>
      ) : null}
      {slots.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {slots.map((slot) => (
            <span
              key={`${slot.date}-${slot.start}`}
              className="inline-flex items-center rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] font-bold text-ink-soft tabular-nums"
            >
              {slotLabel(slot)}
            </span>
          ))}
        </div>
      ) : null}
      <DButton size="sm" variant="soft" className="mt-2 max-sm:min-h-11" onClick={onAccept}>
        Proposer à l'agenda
      </DButton>
    </div>
  );
}

export function AnalysePanel({
  analyse,
  mail,
  variant,
  onClose,
  onAcceptTask,
  onAcceptEvent,
  onUseReply,
  onRetry,
}: {
  analyse: MailAnalyse;
  mail: Mail;
  variant: "desktop" | "mobile";
  onClose: () => void;
  onAcceptTask: (task: AnalyseTask) => void;
  onAcceptEvent: (event: SummaryEvent) => void;
  onUseReply: (body: string) => void;
  onRetry: () => void;
}) {
  const result = analyse.result;
  const mobile = variant === "mobile";

  useEffect(() => {
    if (!mobile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile, onClose]);

  const empty =
    result !== null &&
    [result.tasks, result.events, result.slots].every((list) => list.length === 0) &&
    !result.reply;

  const content = (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-accent-ink uppercase">
            <Sparkles className="size-3.5" strokeWidth={2.6} />
            Analyse IA
          </p>
          <p className="mt-1 truncate text-[12px] font-semibold text-ink-muted">{mail.subject}</p>
        </div>
        <DIconButton label="Fermer l'analyse" className="size-8 max-sm:min-h-11 max-sm:min-w-11" onClick={onClose}>
          <X className="size-4" />
        </DIconButton>
      </div>

      {analyse.status === "loading" ? (
        <p role="status" className="mt-4 flex items-center gap-2 text-[12px] font-semibold text-ink-muted">
          <Loader2 className="size-4 animate-spin" strokeWidth={2.4} />
          Analyse en cours…
        </p>
      ) : null}

      {analyse.status === "error" ? (
        <div className="mt-3 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
          <p className="text-[12px] font-bold text-rose-700 dark:text-rose-300">Analyse impossible</p>
          <p className="mt-0.5 text-[11.5px] font-medium text-ink-soft">{analyse.error ?? ""}</p>
          <DButton size="sm" variant="ghost" className="mt-2 max-sm:min-h-11" onClick={onRetry}>
            Réessayer
          </DButton>
        </div>
      ) : null}

      {result ? (
        <div className="mt-3 space-y-3">
          {result.tasks.length > 0 ? (
            <div className="space-y-1.5">
              <SectionTitle>{`Tâches détectées · ${result.tasks.length}`}</SectionTitle>
              {result.tasks.map((task, index) => (
                <TaskCard
                  key={`${task.title}-${index}`}
                  task={task}
                  onAccept={() => onAcceptTask(task)}
                />
              ))}
            </div>
          ) : null}

          {result.events.length > 0 ? (
            <div className="space-y-1.5">
              <SectionTitle>{`Rendez-vous proposés · ${result.events.length}`}</SectionTitle>
              {result.events.map((event, index) => (
                <EventCard
                  key={`${event.title}-${index}`}
                  event={event}
                  result={result}
                  onAccept={() => onAcceptEvent(event)}
                />
              ))}
            </div>
          ) : null}

          {result.conflicts.length === 0 && result.slots.length > 0 ? (
            <div className="space-y-1.5">
              <SectionTitle>Créneaux libres</SectionTitle>
              <div className="flex flex-wrap gap-1">
                {result.slots.map((slot) => (
                  <span
                    key={`${slot.date}-${slot.start}`}
                    className="inline-flex items-center rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] font-bold text-ink-soft tabular-nums"
                  >
                    {slotLabel(slot)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {result.reply ? (
            <div data-testid="analyse-reply" className="space-y-1.5">
              <SectionTitle>Réponse suggérée</SectionTitle>
              <p className="rounded-2xl border border-line bg-surface-2/60 px-3 py-2.5 text-[12px] leading-snug font-medium whitespace-pre-wrap text-ink">
                {result.reply}
              </p>
              <DButton
                size="sm"
                variant="soft"
                className="max-sm:min-h-11"
                onClick={() => onUseReply(result.reply ?? "")}
              >
                Utiliser dans une réponse
              </DButton>
            </div>
          ) : null}

          {empty ? (
            <p className="text-[11.5px] leading-snug font-medium text-ink-muted">
              {result.source === "local"
                ? "Configure un modèle dans Réglages → IA pour analyser ce mail."
                : "Rien à retenir de ce mail."}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
            <p className="text-[10.5px] font-bold text-ink-muted tabular-nums">
              {`Généré à ${clockOf(result.generatedAt)} · ${result.source === "llm" ? "IA" : "local"}`}
            </p>
            <DButton size="sm" variant="ghost" className="max-sm:min-h-11" onClick={onRetry}>
              Réanalyser
            </DButton>
          </div>
        </div>
      ) : null}
    </>
  );

  if (mobile) {
    return (
      <div data-testid="analyse-panel" className="absolute inset-0 z-50">
        <div className="absolute inset-0 bg-canvas/60 backdrop-blur-sm" onClick={onClose} />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Analyse IA"
          className="absolute inset-x-0 bottom-0 max-h-[88%] overflow-y-auto no-scrollbar rounded-t-[32px] border-t border-line bg-surface px-5 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-20px_60px_-20px_rgba(40,20,80,0.35)]"
        >
          <div className="mx-auto h-1 w-10 rounded-full bg-line" />
          <div className="mt-3">{content}</div>
        </div>
      </div>
    );
  }

  return (
    <section
      data-testid="analyse-panel"
      aria-label="Analyse IA"
      className="max-h-[48vh] overflow-y-auto border-b border-line bg-surface-2/40 px-5 py-3"
    >
      {content}
    </section>
  );
}
