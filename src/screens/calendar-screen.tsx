import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Mail,
  Repeat,
  Sparkles,
} from "lucide-react";
import { longDate, type CalendarEvent } from "@/lib/calendar";
import {
  CURRENT_MONTH,
  CURRENT_YEAR,
  TODAY_ISO,
  WEEKDAYS,
  capitalizeFirst,
  conflictingIds,
  daysInMonth,
  isoDay,
  monthGrid,
  monthLabel,
} from "@/lib/calendar";
import { TONE_DOT, toneOfEvent, useCalendars } from "@/lib/calendars";
import { externalBadge } from "@/lib/ics";
import { draftFromSuggestion, type EventDraft, type MailSuggestion } from "@/lib/tasks";
import { sourceAccountLabel } from "@/lib/accounts";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { EventSuggestionRow } from "@/components/event-suggestion-row";
import { SectionTitle } from "@/components/ui/primitives";
import { AnimatedGradientText } from "@/components/ui/animated-text";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const SHORT_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long" });

/** Les tons d'une source relue à son serveur, alignés sur ceux de l'agenda PC. */
const BADGE_TONE = {
  sky: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  green: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/40 text-amber-700 dark:text-amber-300",
};

export function CalendarScreen({
  events,
  externalEvents = [],
  sourceCount = 0,
  onAcceptSuggestion,
  onDismissSuggestion,
  onOpenEvent,
  onSelectedDateChange,
  suggestions = [],
}: {
  events: CalendarEvent[];
  externalEvents?: CalendarEvent[];
  sourceCount?: number;
  onAcceptSuggestion?: (draft: EventDraft) => void;
  onDismissSuggestion?: (suggestion: MailSuggestion) => void;
  onOpenEvent?: (event: CalendarEvent) => void;
  onSelectedDateChange?: (date: string) => void;
  suggestions?: MailSuggestion[];
}) {
  const { accounts, mails, openMessage } = useMailStore();
  const [calendars] = useCalendars();
  const footerSources =
    sourceCount === 0
      ? "Aucune source externe"
      : `${sourceCount} source${sourceCount > 1 ? "s" : ""} externe${sourceCount > 1 ? "s" : ""}`;
  const footerAccounts =
    accounts.length === 0 ? "Aucun compte" : `${accounts.length} compte${accounts.length > 1 ? "s" : ""}`;
  const footerLabel = `${footerSources} · ${footerAccounts}`;
  const [view, setView] = useState({ year: CURRENT_YEAR, month: CURRENT_MONTH });
  const [selected, setSelected] = useState(TODAY_ISO);

  const eventSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.kind === "event"),
    [suggestions],
  );

  const pick = (date: string) => {
    setSelected(date);
    onSelectedDateChange?.(date);
  };

  /** Une seule source de vérité : les événements locaux et les sources relues à leur serveur. */
  const allEvents = useMemo(() => [...events, ...externalEvents], [events, externalEvents]);
  const cells = useMemo(() => monthGrid(view.year, view.month), [view.year, view.month]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of allEvents) map.set(event.date, (map.get(event.date) ?? 0) + 1);
    return map;
  }, [allEvents]);
  const conflicts = useMemo(() => conflictingIds(allEvents), [allEvents]);
  const dayEvents = useMemo(
    () =>
      allEvents
        .filter((event) => event.date === selected)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [allEvents, selected],
  );
  const label = capitalizeFirst(DATE_FMT.format(new Date(`${selected}T12:00:00`)).replace(/[\u202f\u00a0]/g, " "));
  const shortLabel = SHORT_FMT.format(new Date(`${selected}T12:00:00`)).replace(/[\u202f\u00a0]/g, " ");

  const shiftMonth = (delta: number) => {
    const next = new Date(view.year, view.month + delta, 1);
    const year = next.getFullYear();
    const month = next.getMonth();
    const day = Math.min(Number(selected.slice(8)), daysInMonth(year, month));
    setView({ year, month });
    pick(isoDay(year, month, day));
  };

  const goToday = () => {
    setView({ year: CURRENT_YEAR, month: CURRENT_MONTH });
    pick(TODAY_ISO);
  };

  return (
    <div className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-56" />

      <header className="relative px-5 pt-4">
        <div className="flex items-end justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h1 className="whitespace-nowrap text-[34px] leading-[0.95] font-extrabold tracking-[-0.045em] max-[379px]:text-[30px]">
              <AnimatedGradientText className="-mb-[0.14em] pb-[0.14em]">
                {monthLabel(view.month)}
              </AnimatedGradientText>
            </h1>
            <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-extrabold text-accent-ink">
              {view.year}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label="Mois précédent"
              className="grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft transition-colors hover:border-accent-ring"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label="Mois suivant"
              className="grid size-11 place-items-center rounded-full border border-line bg-surface text-ink-soft transition-colors hover:border-accent-ring"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {selected !== TODAY_ISO && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="flex items-center justify-between gap-2 pt-3">
                <button
                  type="button"
                  onClick={goToday}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-accent-ring bg-accent-soft px-3 text-[12px] font-bold text-accent-ink transition-colors hover:border-accent hover:bg-accent-soft/70 active:scale-95"
                >
                  <CalendarCheck className="size-3.5" strokeWidth={2.4} />
                  Aujourd'hui
                </button>
                <span className="text-[11px] font-semibold text-ink-muted">{shortLabel}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-4 -mx-4 grid grid-cols-7 gap-1 rounded-[26px] border border-line bg-surface p-2 max-[360px]:-mx-5 max-[360px]:gap-0 max-[360px]:p-0">
          {WEEKDAYS.map((day, index) => (
            <span
              key={index}
              className="pb-1 text-center text-[10px] font-bold tracking-wide text-ink-muted uppercase"
            >
              {day}
            </span>
          ))}
          {cells.map((day, index) => {
            if (day === null) return <span key={`empty-${index}`} />;
            const date = isoDay(view.year, view.month, day);
            const isToday = date === TODAY_ISO;
            const isSelected = date === selected;
            const count = counts.get(date) ?? 0;
            return (
              <button
                key={date}
                type="button"
                onClick={() => pick(date)}
                aria-pressed={isSelected}
                aria-label={`${longDate(date)} — ${
                  count === 0 ? "aucun événement" : `${count} événement${count > 1 ? "s" : ""}`
                }`}
                className={cn(
                  "relative grid min-h-11 place-items-center rounded-xl text-[12.5px] font-semibold transition-colors",
                  isSelected
                    ? "bg-accent text-accent-contrast shadow-[0_6px_18px_-8px_var(--accent)]"
                    : isToday
                      ? "bg-accent-soft text-accent-ink"
                      : "text-ink-soft hover:bg-surface-2",
                )}
              >
                {day}
                {counts.has(date) && (
                  <span
                    className={cn(
                      "absolute bottom-1 size-1 rounded-full",
                      isSelected ? "bg-accent-contrast/80" : "bg-accent",
                    )}
                  />
                )}
              </button>
            );
          })}
        </div>
      </header>

      <div className="mt-6 flex items-baseline justify-between px-5">
        <h2 className="text-[13px] font-bold text-ink">{label}</h2>
        <span className="text-[11px] font-medium text-ink-muted">
          {dayEvents.length} événement{dayEvents.length > 1 ? "s" : ""}
        </span>
      </div>

      <div className="mt-2 px-5">
        {dayEvents.map((event, index) => {
          const conflict = conflicts.has(event.id);
          const badge = event.external ? externalBadge(event) : null;
          const fromMail = Boolean(event.fromMail || event.mailId);
          const extra = Boolean(event.location || fromMail || event.recurring || badge);
          return (
            <BlurFade key={event.id} delay={0.05 * index} yOffset={10}>
              <button
                type="button"
                data-testid="calendar-event"
                onClick={onOpenEvent ? () => onOpenEvent(event) : undefined}
                aria-label={`${event.title}${event.start ? ` · ${event.start}` : " · journée entière"}`}
                className={cn(
                  "flex min-h-11 w-full items-start gap-3 py-2.5 text-left",
                  index < dayEvents.length - 1 && "border-b border-line",
                  onOpenEvent && "transition-colors active:bg-surface-2",
                )}
              >
                <span className="w-10 shrink-0 text-right">
                  {event.start ? (
                    <>
                      <span className="block text-[12px] leading-tight font-bold text-ink tabular-nums">
                        {event.start}
                      </span>
                      {event.end && (
                        <span className="block text-[10px] leading-tight font-medium text-ink-soft tabular-nums">
                          {event.end}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="block text-[10px] leading-tight font-semibold text-ink-muted">jour</span>
                  )}
                </span>

                <span className="block min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn("size-2 shrink-0 rounded-full", TONE_DOT[toneOfEvent(event, calendars)])}
                    />
                    <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{event.title}</span>
                    {!event.start && (
                      <span className="shrink-0 text-[9.5px] font-bold text-ink-muted">Journée entière</span>
                    )}
                    {conflict && (
                      <AlertTriangle
                        role="img"
                        aria-label="Conflit"
                        className="size-3.5 shrink-0 text-red-600 dark:text-red-300"
                        strokeWidth={2.4}
                      />
                    )}
                  </span>

                  {extra && (
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] font-medium text-ink-muted">
                      {event.location && <span className="min-w-0 truncate">{event.location}</span>}
                      {fromMail && (
                        <Mail role="img" aria-label="Mail lié" className="size-3 shrink-0" strokeWidth={2.4} />
                      )}
                      {event.recurring && (
                        <Repeat role="img" aria-label="Récurrent" className="size-3 shrink-0" strokeWidth={2.4} />
                      )}
                      {badge && (
                        <span
                          data-testid="external-badge"
                          className={cn(
                            "shrink-0 rounded border px-1 text-[9px] leading-4 font-bold",
                            BADGE_TONE[badge.tone],
                          )}
                        >
                          {badge.label}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </button>
            </BlurFade>
          );
        })}

        {dayEvents.length === 0 && (
          <p className="px-5 py-10 text-center text-[12.5px] font-medium text-ink-muted">
            Journée libre — rien de prévu.
          </p>
        )}
      </div>

      {eventSuggestions.length > 0 && (
        <section className="mt-4" data-testid="event-suggestions">
          <SectionTitle
            hint={`${eventSuggestions.length} proposition${eventSuggestions.length > 1 ? "s" : ""}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-3 text-accent-ink" strokeWidth={2.6} aria-hidden="true" />
              Suggestions de RDV
            </span>
          </SectionTitle>
          <div className="px-5">
            {eventSuggestions.map((suggestion, index) => (
              <EventSuggestionRow
                key={suggestion.id}
                suggestion={suggestion}
                account={sourceAccountLabel(accounts, suggestion.account)}
                mail={mails.find((mail) => mail.id === suggestion.mailId)}
                last={index === eventSuggestions.length - 1}
                onAccept={() => onAcceptSuggestion?.(draftFromSuggestion(suggestion))}
                onOpenMail={(mail) => openMessage(mail)}
                onDismiss={() => onDismissSuggestion?.(suggestion)}
              />
            ))}
          </div>
        </section>
      )}

      <p className="mt-5 flex items-center justify-center gap-1 px-5 text-[10.5px] font-medium text-ink-muted">
        <Clock className="size-3" />
        {footerLabel}
      </p>
    </div>
  );
}
