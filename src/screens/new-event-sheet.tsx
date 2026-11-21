import { useState } from "react";
import { AlertTriangle, CalendarPlus, Mail } from "lucide-react";
import type { CalendarEvent } from "@/lib/calendar";
import { TODAY_ISO, isoInDays, overlappingEvents } from "@/lib/calendar";
import { useCalendars } from "@/lib/calendars";
import type { EventDraft } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const DAYS = [
  { label: "Aujourd'hui", offset: 0 },
  { label: "Demain", offset: 1 },
  { label: "Dans 2 jours", offset: 2 },
];

const DURATIONS = [
  { label: "30 min", minutes: 30 },
  { label: "1 h", minutes: 60 },
  { label: "1 h 30", minutes: 90 },
  { label: "2 h", minutes: 120 },
];

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long" });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Créneau prérempli par une suggestion issue d'un mail. */
export type NewEventDraft = EventDraft;

export function addMinutes(time: string, minutes: number) {
  const [hours, mins] = time.split(":").map((part) => Number.parseInt(part, 10));
  const total = (hours * 60 + mins + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function totalMinutes(time: string, minutes: number) {
  const [hours, mins] = time.split(":").map((part) => Number.parseInt(part, 10));
  return hours * 60 + mins + minutes;
}

function dateLabel(iso: string) {
  return DATE_FMT.format(new Date(`${iso}T12:00:00`)).replace(/\u202f|\u00a0/g, " ");
}

export function NewEventSheet({
  onClose,
  onCreate,
  onUpdate,
  initialDate = TODAY_ISO,
  events = [],
  draft,
  event,
}: {
  onClose: () => void;
  onCreate: (event: CalendarEvent) => void;
  onUpdate?: (event: CalendarEvent) => Promise<string | null>;
  initialDate?: string;
  events?: CalendarEvent[];
  draft?: NewEventDraft;
  event?: CalendarEvent;
}) {
  const [calendars] = useCalendars();
  const editing = Boolean(event);
  const allDay = Boolean(event) && !event?.start;
  const locked = Boolean(event?.caldav);
  const draftDate = draft?.date && ISO_DAY.test(draft.date) ? draft.date : null;
  const draftStart = draft?.start && CLOCK.test(draft.start) ? draft.start : "";
  const draftEnd = draft?.end && CLOCK.test(draft.end) ? draft.end : "";
  const draftMinutes =
    draftStart && draftEnd && totalMinutes(draftEnd, 0) > totalMinutes(draftStart, 0)
      ? totalMinutes(draftEnd, 0) - totalMinutes(draftStart, 0)
      : null;
  const eventMinutes =
    event?.start && event.end && totalMinutes(event.end, 0) > totalMinutes(event.start, 0)
      ? totalMinutes(event.end, 0) - totalMinutes(event.start, 0)
      : null;
  const initialMinutes = draftMinutes ?? eventMinutes;
  const [title, setTitle] = useState(event?.title ?? draft?.title ?? "");
  const [date, setDate] = useState(event?.date ?? draftDate ?? initialDate);
  const [start, setStart] = useState(event?.start ?? (draftStart || "10:00"));
  const [duration, setDuration] = useState(
    DURATIONS.find((entry) => entry.minutes === initialMinutes) ??
      (initialMinutes ? { label: `${initialMinutes} min`, minutes: initialMinutes } : DURATIONS[1]),
  );
  const [location, setLocation] = useState(event?.location ?? draft?.location ?? "");
  const [calendar, setCalendar] = useState<string | undefined>(event?.calendar ?? calendars[0]?.name);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const end = allDay ? "" : start ? addMinutes(start, duration.minutes) : "--:--";
  const crossesMidnight = !allDay && Boolean(start) && totalMinutes(start, duration.minutes) >= 24 * 60;
  const canSave = Boolean(title.trim() && date) && (allDay || Boolean(start)) && !crossesMidnight;
  const clashes =
    allDay || !start || crossesMidnight
      ? []
      : overlappingEvents(
          events.filter((entry) => entry.id !== event?.id),
          date,
          start,
          end,
        );

  const reset = () => {
    setConfirmed(false);
  };

  const submit = async () => {
    if (!canSave || saving) return;
    if (clashes.length > 0 && !confirmed) {
      setConfirmed(true);
      return;
    }
    const next: CalendarEvent = event
      ? {
          ...event,
          date,
          start,
          end,
          title: title.trim(),
          location: location.trim() || undefined,
          calendar,
        }
      : {
          id: "e-" + Date.now(),
          date,
          start,
          end,
          title: title.trim(),
          location: location.trim() || undefined,
          tone: undefined,
          calendar,
          ...(draft?.mailId ? { mailId: draft.mailId, fromMail: true } : {}),
        };
    if (event && onUpdate) {
      setSaving(true);
      setFailure(null);
      const message = await onUpdate(next);
      setSaving(false);
      if (message) {
        setFailure(message);
        return;
      }
      onClose();
      return;
    }
    onCreate(next);
    onClose();
  };

  const shortcut = DAYS.find((entry) => isoInDays(entry.offset) === date);
  const confirmLabel = editing ? "Enregistrer quand même" : "Créer quand même";

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">
          {editing ? "Modifier le rendez-vous" : "Nouveau rendez-vous"}
        </h2>
        <button type="button" onClick={onClose} className="ml-auto text-[11.5px] font-bold text-accent-ink">
          Annuler
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-4">
        {draft?.mailId ? (
          <div className="mb-3 flex items-start gap-2 rounded-2xl border border-accent-ring/50 bg-accent-soft/50 px-3 py-2">
            <Mail className="mt-0.5 size-3.5 shrink-0 text-accent-ink" strokeWidth={2.4} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[10px] font-bold tracking-[0.14em] text-accent-ink uppercase">
                Mail lié
              </p>
              {draft.mailFrom ? (
                <p className="mt-0.5 truncate text-[11.5px] font-bold text-ink">{draft.mailFrom}</p>
              ) : null}
              {draft.mailSubject ? (
                <p className="truncate text-[11px] font-medium text-ink-soft">{draft.mailSubject}</p>
              ) : null}
            </div>
          </div>
        ) : null}
        <label className="block text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase" htmlFor="event-title">
          Titre
        </label>
        <input
          id="event-title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            reset();
          }}
          placeholder="Titre du rendez-vous"
          autoFocus
          className="mt-1.5 w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-[14px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-soft focus:border-accent-ring"
        />

        <label className="mt-2 block text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase" htmlFor="event-location">
          Lieu
        </label>
        <input
          id="event-location"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="Lieu ou lien visio"
          className="mt-1.5 w-full rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[12.5px] font-medium text-ink outline-none placeholder:text-ink-soft focus:border-accent-ring"
        />

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Jour</p>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((entry) => {
            const active = shortcut?.label === entry.label;
            return (
              <button
                key={entry.label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setDate(isoInDays(entry.offset));
                  reset();
                }}
                className={cn(
                  "min-h-11 rounded-full px-3 text-[11.5px] font-bold transition-all",
                  active
                    ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                    : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                )}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <label className="text-[10.5px] font-semibold text-ink-muted" htmlFor="event-date">
            Choisir une date
          </label>
          <input
            id="event-date"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              reset();
            }}
            className="rounded-2xl border border-line bg-surface px-2.5 py-2 text-[12px] font-bold text-ink outline-none focus:border-accent-ring"
          />
        </div>

        {allDay ? (
          <p className="mt-4 rounded-2xl border border-line bg-surface px-3 py-2 text-[11px] font-semibold text-ink-muted">
            Journée entière · les horaires ne s'appliquent pas, le rendez-vous reste sur toute la journée.
          </p>
        ) : (
          <>
            <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Heure</p>
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={start}
                onChange={(event) => {
                  setStart(event.target.value);
                  reset();
                }}
                className="rounded-2xl border border-line bg-surface px-3 py-2.5 text-[13px] font-bold text-ink outline-none focus:border-accent-ring"
              />
              <span className="text-[11.5px] font-semibold whitespace-nowrap text-ink-muted">{`→ ${end}`}</span>
            </div>

            {crossesMidnight && (
              <p
                role="alert"
                className="mt-2 flex items-start gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-700 dark:text-red-300"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                Le rendez-vous doit se terminer le même jour (fin {end} ≤ début {start}). Raccourcis la durée.
              </p>
            )}

            <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Durée</p>
            <div className="flex flex-wrap gap-1.5">
              {DURATIONS.map((entry) => {
                const active = entry.label === duration.label;
                return (
                  <button
                    key={entry.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setDuration(entry);
                      reset();
                    }}
                    className={cn(
                      "min-h-11 rounded-full px-3 text-[11.5px] font-bold transition-all",
                      active
                        ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                        : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                    )}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {calendars.length > 0 ? (
          <>
            <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Calendrier</p>
            <div className="flex flex-wrap gap-1.5">
              {calendars.map((def) => {
                const active = def.name === calendar;
                return (
                  <button
                    key={def.id}
                    type="button"
                    aria-pressed={active}
                    disabled={locked}
                    onClick={() => setCalendar(def.name)}
                    className={cn(
                      "min-h-11 rounded-full px-3 text-[11.5px] font-bold transition-all",
                      active
                        ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
                        : "border border-line bg-surface text-ink-soft hover:border-accent-ring",
                      locked && "opacity-60",
                    )}
                  >
                    {def.name}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </div>

      <div className="border-t border-line/80 px-4 py-3 glass safe-bottom sm:pb-5">
        {confirmed && clashes.length > 0 && (
          <div className="mb-2 flex items-start gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Conflit {dateLabel(date)} —{" "}
              {clashes.length > 1
                ? `${clashes.length} événements se chevauchent, dont « ${clashes[0].title} »`
                : `« ${clashes[0].title} » (${clashes[0].start} → ${clashes[0].end})`}
              . Cliquez sur « {confirmLabel} » pour confirmer.
            </p>
          </div>
        )}
        {failure && (
          <p
            role="alert"
            className="mb-2 rounded-2xl bg-red-500/10 px-3 py-2 text-[11.5px] font-semibold text-red-600 dark:text-red-300"
          >
            {failure}
          </p>
        )}
        <ShimmerButton className="w-full" onClick={() => void submit()} disabled={!canSave || saving}>
          <CalendarPlus className="size-4" strokeWidth={2.4} />
          {editing
            ? confirmed && clashes.length > 0
              ? confirmLabel
              : "Enregistrer"
            : confirmed && clashes.length > 0
              ? confirmLabel
              : "Créer le rendez-vous"}
        </ShimmerButton>
      </div>
    </div>
  );
}
