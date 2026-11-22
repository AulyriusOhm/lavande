import { useState } from "react";
import { AlertTriangle, Clock, Link2, Mail, MapPin, Pencil, Repeat, Trash2 } from "lucide-react";
import { longDate, type CalendarEvent } from "@/lib/calendar";
import { TONE_DOT, toneOfEvent, useCalendars } from "@/lib/calendars";
import { externalBadge } from "@/lib/ics";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/primitives";
import { GuestFreeBusy } from "@/components/guest-free-busy";

export function EventDetailSheet({
  event,
  conflict,
  onClose,
  onEdit,
  onDelete,
  onOpenMail,
  freeBusyAccount = null,
}: {
  event: CalendarEvent;
  conflict: boolean;
  onClose: () => void;
  onEdit?: (event: CalendarEvent) => void;
  onDelete?: (event: CalendarEvent) => Promise<void>;
  onOpenMail?: () => void;
  /** Compte Zimbra interrogé pour les disponibilités des invités. */
  freeBusyAccount?: string | null;
}) {
  const [calendars] = useCalendars();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const badge = event.external ? externalBadge(event) : null;
  const readOnly = Boolean(badge) && !event.caldav;
  const fromMail = Boolean(event.fromMail || event.mailId);
  const time = event.start ? (event.end ? `${event.start} → ${event.end}` : event.start) : "Journée entière";

  const remove = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    await onDelete(event);
    setDeleting(false);
    setConfirming(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Détail du rendez-vous"
      className="relative flex h-full flex-col bg-canvas"
    >
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[toneOfEvent(event, calendars)])} />
            <p className="min-w-0 truncate text-[10px] font-bold tracking-[0.12em] text-ink-muted uppercase">
              {event.calendar ?? "Agenda"}
            </p>
            {badge && (
              <span className="shrink-0 rounded border border-line px-1 text-[9px] leading-4 font-bold text-ink-soft">
                {badge.label}
              </span>
            )}
          </div>
          <h2 className="mt-1 text-[17px] leading-tight font-extrabold tracking-[-0.02em] text-ink">
            {event.title}
          </h2>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 min-h-11 text-[11.5px] font-bold text-accent-ink">
          Fermer
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {event.recurring && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-ink-soft">
              <Repeat className="size-3" strokeWidth={2.4} />
              récurrent
            </span>
          )}
          {fromMail && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
              <Mail className="size-3" strokeWidth={2.4} />
              mail
            </span>
          )}
          {conflict && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-extrabold text-red-700 dark:text-red-300">
              <AlertTriangle className="size-3" strokeWidth={2.4} />
              conflit
            </span>
          )}
        </div>

        <p className="mt-3 flex items-center gap-2 text-[12px] font-semibold text-ink-soft">
          <Clock className="size-3.5 shrink-0" strokeWidth={2.2} />
          <span className="min-w-0 flex-1">
            {longDate(event.date)} · <span className="font-bold text-ink tabular-nums">{time}</span>
          </span>
        </p>

        {event.location && (
          <p className="mt-2 flex items-center gap-2 text-[11.5px] font-semibold text-ink-muted">
            <MapPin className="size-3.5 shrink-0" strokeWidth={2.2} />
            <span className="min-w-0 truncate">{event.location}</span>
          </p>
        )}

        {event.description && (
          <p className="mt-4 text-[12.5px] leading-relaxed font-medium text-ink-soft">{event.description}</p>
        )}

        <GuestFreeBusy
          accountId={freeBusyAccount}
          attendees={event.attendees ?? []}
          date={event.date}
          start={event.start}
          end={event.end}
        />

        {event.attendees?.length ? (
          <div className="mt-4">
            <p className="text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Participants</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {event.attendees.map((person, index) => (
                <span
                  key={person}
                  className="flex items-center gap-2 text-[11.5px] font-semibold text-ink-soft"
                >
                  <Avatar name={person} tone={index} size={22} rounded="rounded-full" />
                  <span className="min-w-0 truncate">{person}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {event.recurring && !readOnly && (
          <p className="mt-4 text-[10.5px] leading-relaxed font-semibold text-ink-muted">
            Série récurrente — la modification porte sur la série entière.
          </p>
        )}
      </div>

      <div className="border-t border-line/80 px-4 py-3 glass safe-bottom sm:pb-5">
        {onOpenMail && (
          <button
            type="button"
            onClick={onOpenMail}
            className="mb-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border border-line bg-surface text-[12px] font-bold text-ink-soft transition-transform active:scale-95"
          >
            <Mail className="size-3.5" strokeWidth={2.4} />
            Ouvrir le mail
          </button>
        )}

        {readOnly ? (
          <p className="flex items-start gap-2 rounded-2xl bg-surface-2 px-3 py-2 text-[11px] font-semibold text-ink-muted">
            <Link2 className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.4} />
            Lecture seule — géré par la source
          </p>
        ) : (
          <div className="flex items-center gap-2">
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(event)}
                className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent text-[12px] font-bold text-accent-contrast transition-transform active:scale-95"
              >
                <Pencil className="size-3.5" strokeWidth={2.4} />
                Modifier
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-red-500/40 px-4 text-[12px] font-bold text-red-600 transition-transform active:scale-95 dark:text-red-300"
              >
                <Trash2 className="size-3.5" strokeWidth={2.4} />
                Supprimer
              </button>
            )}
          </div>
        )}
      </div>

      {confirming && onDelete && (
        <div className="absolute inset-0 z-50 grid place-items-center p-4">
          <div
            aria-hidden
            data-testid="event-delete-backdrop"
            onClick={() => setConfirming(false)}
            className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Supprimer ce rendez-vous ?"
            aria-describedby="event-delete-help"
            className="relative w-full max-w-[340px] rounded-[26px] border border-line bg-surface p-4 shadow-[0_44px_96px_-48px_var(--accent)]"
          >
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-red-500/12 text-red-600 dark:text-red-300">
                <Trash2 className="size-5" strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] leading-tight font-extrabold tracking-[-0.02em] text-ink">
                  Supprimer ce rendez-vous ?
                </h2>
                <p id="event-delete-help" className="mt-1 text-[11.5px] leading-relaxed font-semibold text-ink-muted">
                  « {event.title} » quitte l'agenda{event.caldav ? " et le calendrier CalDAV" : ""}. Cette action est
                  définitive.
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirming(false)}
                className="inline-flex min-h-11 items-center rounded-full px-3 text-[12px] font-bold text-ink-soft"
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void remove()}
                className="inline-flex min-h-11 items-center rounded-full bg-red-600 px-3.5 text-[12px] font-bold text-white disabled:pointer-events-none disabled:opacity-50"
              >
                {deleting ? "Suppression…" : "Supprimer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
