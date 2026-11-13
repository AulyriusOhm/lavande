import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CalendarCheck, ChevronLeft, ChevronRight, Clock, Mail, MapPin, Plus, Users } from "lucide-react";
import type { CalendarEvent } from "@/lib/calendar";
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
import { externalBadge } from "@/lib/ics";
import { TONES } from "@/lib/mail";
import { draftFromSuggestion, type EventDraft, type MailSuggestion } from "@/lib/tasks";
import { sourceAccountLabel } from "@/lib/accounts";
import { useMailStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { EventSuggestionCard } from "@/components/event-suggestion-card";
import { SectionTitle } from "@/components/ui/primitives";
import { AnimatedGradientText } from "@/components/ui/animated-text";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const SHORT_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long" });
const FULL_FMT = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const fullDate = (iso: string) =>
  capitalizeFirst(FULL_FMT.format(new Date(`${iso}T12:00:00`)).replace(/[\u202f\u00a0]/g, " "));

/** Les tons d'une source relue à son serveur, alignés sur ceux de l'agenda PC. */
const BADGE_TONE = {
  sky: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  green: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
};

export function CalendarScreen({
  events,
  externalEvents = [],
  sourceCount = 0,
  onNewEvent,
  onAcceptSuggestion,
  onDismissSuggestion,
  onOpenMail,
  onSelectedDateChange,
  availableMailIds,
  suggestions = [],
}: {
  events: CalendarEvent[];
  externalEvents?: CalendarEvent[];
  sourceCount?: number;
  onNewEvent?: (date: string) => void;
  onAcceptSuggestion?: (draft: EventDraft) => void;
  onDismissSuggestion?: (suggestion: MailSuggestion) => void;
  onOpenMail?: (event: CalendarEvent) => void;
  onSelectedDateChange?: (date: string) => void;
  availableMailIds?: Set<string>;
  suggestions?: MailSuggestion[];
}) {
  const { accounts, mails, openMessage } = useMailStore();
  const footerSources =
    sourceCount === 0
      ? "Aucune source externe"
      : `${sourceCount} source${sourceCount > 1 ? "s" : ""} externe${sourceCount > 1 ? "s" : ""}`;
  const footerAccounts =
    accounts.length === 0 ? "Aucun compte" : `${accounts.length} compte${accounts.length > 1 ? "s" : ""}`;
  const footerLabel = `${footerSources} · ${footerAccounts}`;
  const [view, setView] = useState({ year: CURRENT_YEAR, month: CURRENT_MONTH });
  const [selected, setSelected] = useState(TODAY_ISO);

  const eventSuggestions = suggestions.filter((suggestion) => suggestion.kind === "event");

  const pick = (date: string) => {
    setSelected(date);
    onSelectedDateChange?.(date);
  };

  /** Une seule source de vérité : les événements locaux et les sources relues à leur serveur. */
  const allEvents = [...events, ...externalEvents];
  const cells = monthGrid(view.year, view.month);
  const counts = new Map<string, number>();
  for (const event of allEvents) counts.set(event.date, (counts.get(event.date) ?? 0) + 1);
  const conflicts = conflictingIds(allEvents);
  const dayEvents = allEvents
    .filter((event) => event.date === selected)
    .sort((a, b) => a.start.localeCompare(b.start));
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
                aria-label={`${fullDate(date)} — ${
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

      <div className="mt-3 space-y-2 px-4">
        {dayEvents.map((event, index) => {
          const conflict = conflicts.has(event.id);
          const badge = event.external ? externalBadge(event) : null;
          const openable =
            onOpenMail && event.mailId && (!availableMailIds || availableMailIds.has(event.mailId))
              ? () => onOpenMail(event)
              : undefined;
          return (
            <BlurFade key={event.id} delay={0.05 * index} yOffset={10}>
              <div className="flex gap-3">
                <div className="w-11 shrink-0 pt-1 text-right">
                  {event.start && (
                    <p className="text-[11.5px] font-bold whitespace-nowrap text-ink">{event.start}</p>
                  )}
                  {event.start && event.end && (
                    <p className="text-[10px] font-medium whitespace-nowrap text-ink-muted">{event.end}</p>
                  )}
                </div>
                <div
                  role={openable ? "button" : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onClick={openable}
                  onKeyDown={
                    openable
                      ? (keyEvent) => {
                          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                            keyEvent.preventDefault();
                            openable();
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "min-w-0 flex-1 rounded-2xl border border-line bg-surface p-3 border-l-[3px]",
                    openable && "cursor-pointer transition-colors hover:border-accent-ring/70",
                  )}
                  style={{ borderLeftColor: `var(--accent)` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] leading-tight font-bold text-ink">{event.title}</p>
                    <div className="flex shrink-0 items-center gap-1">
                      {conflict && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/12 px-2 py-0.5 text-[10px] font-extrabold text-red-700 dark:text-red-300">
                          En conflit
                        </span>
                      )}
                      {event.fromMail && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                          <Mail className="size-2.5" />
                          mail
                        </span>
                      )}
                    </div>
                  </div>
                  {event.location && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                      <MapPin className="size-3" />
                      {event.location}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    {badge && (
                      <span
                        data-testid="external-badge"
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[9.5px] font-bold",
                          BADGE_TONE[badge.tone],
                        )}
                      >
                        {badge.label}
                      </span>
                    )}
                    {!event.start && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[9.5px] font-bold text-ink-soft">
                        Journée entière
                      </span>
                    )}
                    {event.calendar && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[9.5px] font-bold text-ink-soft">
                        {event.calendar}
                      </span>
                    )}
                    {event.attendees?.length ? (
                      <div className="flex items-center gap-1.5">
                        <Users className="size-3 text-ink-muted" />
                        {event.attendees.map((person) => (
                          <span
                            key={person}
                            className={cn(
                              "grid size-5 place-items-center rounded-full bg-gradient-to-br text-[8.5px] font-black",
                              TONES[person.length % TONES.length],
                            )}
                          >
                            {person
                              .split(" ")
                              .map((part) => part[0])
                              .join("")
                              .slice(0, 2)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
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
            Suggestions de RDV
          </SectionTitle>
          <div className="space-y-2 px-4">
            {eventSuggestions.map((suggestion) => (
              <EventSuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                account={sourceAccountLabel(accounts, suggestion.account)}
                mail={mails.find((mail) => mail.id === suggestion.mailId)}
                onAccept={() => onAcceptSuggestion?.(draftFromSuggestion(suggestion))}
                onOpenMail={(mail) => openMessage(mail)}
                onDismiss={() => onDismissSuggestion?.(suggestion)}
              />
            ))}
          </div>
        </section>
      )}

      <div className="mt-5 px-5">
        <ShimmerButton
          size="md"
          className="w-full"
          shimmerDuration={5}
          onClick={onNewEvent ? () => onNewEvent(selected) : undefined}
          disabled={!onNewEvent}
        >
          <Plus className="size-4" />
          Créer un événement
        </ShimmerButton>
        <p className="mt-2 flex items-center justify-center gap-1 text-[10.5px] font-medium text-ink-muted">
          <Clock className="size-3" />
          {footerLabel}
        </p>
      </div>
    </div>
  );
}
