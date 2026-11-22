import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Inbox,
  Link2,
  Mail,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { CalendarEvent } from "@/lib/calendar";
import {
  TODAY_ISO,
  WEEKDAYS,
  capitalizeFirst,
  conflictingIds,
  daysInMonth,
  isoDay,
  monthGrid,
  overlappingEvents,
} from "@/lib/calendar";
import { TONE_DOT, TONE_PILL, caldavSourceIdOf, calendarsInUse, icsUrlOf, isCaldavCalendar, isGoogleCalendar, toneOfEvent, useCalendars, type CalendarDef } from "@/lib/calendars";
import {
  commitIcsState,
  caldavWriteFailure,
  createCaldavEvent,
  deleteCaldavEvent,
  externalBadge,
  externalCalendarEvents,
  externalEventKind,
  updateCaldavEvent,
  useExternalCalendarRefresh,
} from "@/lib/ics";

import {
  DAY_END_MIN,
  DAY_START_MIN,
  PX_PER_MIN,
  addDaysISO,
  blockGeometry,
  filterEvents,
  layoutDay,
  miniMonthCells,
  minutesOf,
  periodLabel,
  shiftAnchor,
  timeOf,
  upcomingEvents,
  weekDaysISO,
  weekStartISO,
  type ViewMode,
} from "@/lib/calendar-views";
import { useMailStore } from "@/lib/store";
import { draftFromSuggestion, type EventDraft, type MailSuggestion } from "@/lib/tasks";
import { sourceAccountLabel } from "@/lib/accounts";
import { guestEmails } from "@/lib/mail";
import { EventSuggestionCard } from "@/components/event-suggestion-card";
import { GuestFreeBusy } from "@/components/guest-free-busy";
import { zimbraAccountOf } from "@/components/zimbra-account";
import { useEscapeLayer } from "@/desktop/escape";
import {
  Badge,
  DButton,
  DIconButton,
  EmptyState,
  PaneTitle,
  SectionLabel,
  TextArea,
  TextInput,
} from "@/desktop/ui";
import { BlurFade } from "@/components/ui/blur-fade";
import { Avatar } from "@/components/ui/primitives";
import { addMinutes } from "@/screens/new-event-sheet";
import { cn } from "@/lib/utils";

const DAY_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const WEEKDAY_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });

const NARROW_QUERY = "(max-width: 1024px)";

const TIMELINE_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN;
const HOURS = Array.from(
  { length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 },
  (_, index) => DAY_START_MIN + index * 60,
);
const HOUR_LINES = "repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px 60px)";

const VIEW_TABS: { id: ViewMode; label: string }[] = [
  { id: "month", label: "Mois" },
  { id: "week", label: "Semaine" },
  { id: "day", label: "Jour" },
  { id: "list", label: "Liste" },
];

const VIEW_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const VIEW_VARIANTS: Variants = {
  enter: (direction: number) =>
    direction === 0
      ? { opacity: 0, scale: 0.985, transition: { duration: 0.22, ease: VIEW_EASE } }
      : { opacity: 0, x: direction * 48, transition: { duration: 0.22, ease: VIEW_EASE } },
  center: { opacity: 1, x: 0, scale: 1, transition: { duration: 0.22, ease: VIEW_EASE } },
  exit: (direction: number) =>
    direction === 0
      ? { opacity: 0, scale: 1.01, transition: { duration: 0.15, ease: VIEW_EASE } }
      : { opacity: 0, x: direction * -48, transition: { duration: 0.15, ease: VIEW_EASE } },
};

const TONE_LABELS = ["Ton 1", "Ton 2", "Ton 3", "Ton 4", "Ton 5"];

function periodContainsToday(mode: ViewMode, anchor: string, selectedDate: string): boolean {
  switch (mode) {
    case "month":
      return anchor.slice(0, 7) === TODAY_ISO.slice(0, 7);
    case "week":
      return weekStartISO(anchor) === weekStartISO(TODAY_ISO);
    case "day":
      return anchor === TODAY_ISO;
    case "list":
      return selectedDate === TODAY_ISO;
  }
}

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  return narrow;
}

const descriptionOf = (event: CalendarEvent | null) => event?.description;

const longDate = (iso: string) =>
  capitalizeFirst(DAY_FMT.format(new Date(`${iso}T12:00:00`)).replace(/[\u202f\u00a0]/g, " "));

const shortWeekday = (iso: string) => WEEKDAY_FMT.format(new Date(`${iso}T12:00:00`)).replace(".", "");

const isWeekend = (iso: string) => [5, 6].includes((new Date(`${iso}T12:00:00`).getDay() + 6) % 7);

const monthCells = (year: number, month: number) => {
  const offset = monthGrid(year, month).findIndex((cell) => cell !== null);
  const start = addDaysISO(isoDay(year, month, 1), -offset);
  return Array.from({ length: 42 }, (_, index) => addDaysISO(start, index));
};

/** Un événement ICS sans heure (journée entière) n'a ni début ni fin : on le dit. */
const timeRange = (event: CalendarEvent) => {
  if (!event.start) return "Journée entière";
  return event.end ? `${event.start} → ${event.end}` : event.start;
};

/** Une famille de sources externes : compte des événements et relecture à la demande. */
function ExternalRefreshRow({
  label,
  refreshLabel,
  count,
  syncing,
  onRefresh,
}: {
  label: string;
  refreshLabel: string;
  count: number;
  syncing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[10.5px] font-semibold text-ink-muted">
        {label} · {count} événement{count > 1 ? "s" : ""}
      </span>
      <DButton
        variant="ghost"
        size="sm"
        className="ml-auto"
        aria-label={refreshLabel}
        disabled={syncing}
        onClick={onRefresh}
      >
        <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} strokeWidth={2.4} />
        Actualiser
      </DButton>
    </div>
  );
}

function EventPill({
  event,
  tone,
  conflict,
  onOpen,
}: {
  event: CalendarEvent;
  tone: number;
  conflict: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={`${event.title} · ${timeRange(event)}`}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onOpen();
      }}
      className={cn(
        "focus-ring flex h-5 w-full items-center gap-1 overflow-hidden rounded-[10px] px-1.5 text-left text-[10.5px] font-bold whitespace-nowrap",
        TONE_PILL[tone],
      )}
    >
      <span className={cn("size-[5px] shrink-0 rounded-full", TONE_DOT[tone])} />
      <span className="shrink-0 text-[9.5px] tabular-nums opacity-70">{event.start}</span>
      <span className="truncate">{event.title}</span>
      {event.fromMail || event.mailId ? <Mail className="ml-auto size-2.5 shrink-0 opacity-90" strokeWidth={2.8} /> : null}
      {conflict ? (
        <AlertTriangle className="size-2.5 shrink-0 text-amber-600 dark:text-amber-300" strokeWidth={2.8} />
      ) : null}
    </button>
  );
}

function MonthView({
  anchor,
  selectedDate,
  byDay,
  conflicts,
  calendars,
  onPick,
  onOpen,
  onCreateAt,
}: {
  anchor: string;
  selectedDate: string;
  byDay: Map<string, CalendarEvent[]>;
  conflicts: Set<string>;
  calendars: CalendarDef[];
  onPick: (date: string) => void;
  onOpen: (event: CalendarEvent) => void;
  onCreateAt: (date: string) => void;
}) {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7)) - 1;
  const cells = monthCells(year, month);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-line">
        {WEEKDAYS.map((weekday, index) => (
          <span
            key={index}
            className="grid h-7 place-items-center text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase"
          >
            {weekday}
          </span>
        ))}
      </div>

      <div data-testid="month-grid" className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7">
        {cells.map((iso, index) => {
          const list = byDay.get(iso) ?? [];
          const shown = list.slice(0, 3);
          const hidden = list.length - shown.length;
          const inMonth = iso.slice(0, 7) === anchor.slice(0, 7);
          const today = iso === TODAY_ISO;
          const selected = iso === selectedDate;

          return (
            <div
              key={iso}
              role="button"
              tabIndex={0}
              data-date={iso}
              aria-current={selected ? "date" : undefined}
              aria-label={`${longDate(iso)} — ${
                list.length === 0 ? "aucun événement" : `${list.length} événement${list.length > 1 ? "s" : ""}`
              }`}
              onClick={() => onPick(iso)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
                keyEvent.preventDefault();
                onPick(iso);
              }}
              className={cn(
                "group focus-ring relative flex min-h-[84px] min-w-0 flex-col gap-1 overflow-hidden border-b border-line p-1.5 text-left transition-colors",
                index % 7 === 6 ? "border-r-0" : "border-r",
                inMonth ? (isWeekend(iso) ? "bg-surface-2/60" : "bg-surface") : "bg-surface-2/40 opacity-45",
                selected && "bg-accent-soft ring-1 ring-accent-ring",
              )}
            >
              <div className="flex shrink-0 items-center gap-1">
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full text-[12.5px] font-extrabold tabular-nums",
                    today
                      ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-10px_var(--accent)]"
                      : selected
                        ? "bg-accent-soft text-accent-ink ring-1 ring-accent-ring"
                        : inMonth
                          ? "text-ink"
                          : "text-ink-muted",
                  )}
                >
                  {Number(iso.slice(8))}
                </span>
                <button
                  type="button"
                  aria-label={`Ajouter un rendez-vous le ${iso}`}
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onCreateAt(iso);
                  }}
                  className="focus-ring ml-auto grid size-[18px] shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Plus className="size-3" strokeWidth={3} />
                </button>
              </div>

              <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
                {shown.map((event) => (
                  <EventPill
                    key={event.id}
                    event={event}
                    tone={toneOfEvent(event, calendars)}
                    conflict={conflicts.has(event.id)}
                    onOpen={() => onOpen(event)}
                  />
                ))}
                {hidden > 0 ? (
                  <span className="px-1 text-[10.5px] font-bold text-ink-muted">+{hidden} autres</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Timeline({
  days,
  byDay,
  conflicts,
  calendars,
  single,
  onOpen,
  onCreateAt,
}: {
  days: string[];
  byDay: Map<string, CalendarEvent[]>;
  conflicts: Set<string>;
  calendars: CalendarDef[];
  single: boolean;
  onOpen: (event: CalendarEvent) => void;
  onCreateAt: (date: string, start: string) => void;
}) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = Math.max(0, Math.min(TIMELINE_HEIGHT, (nowMinutes - DAY_START_MIN) * PX_PER_MIN));

  const slotOf = (element: HTMLElement, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const minutes = DAY_START_MIN + Math.round((clientY - rect.top) / 30) * 30;
    return timeOf(Math.max(DAY_START_MIN, Math.min(DAY_END_MIN - 30, minutes)));
  };

  return (
    <div data-testid={single ? undefined : "week-grid"} className="flex items-start">
      <div className="relative w-[58px] shrink-0" style={{ height: TIMELINE_HEIGHT }}>
        {HOURS.map((minutes) => (
          <span
            key={minutes}
            className="absolute right-2 -translate-y-1/2 bg-canvas px-0.5 text-[10.5px] font-bold text-ink-muted tabular-nums"
            style={{ top: (minutes - DAY_START_MIN) * PX_PER_MIN }}
          >
            {timeOf(minutes)}
          </span>
        ))}
      </div>

      <div
        className="grid min-w-0 flex-1"
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
      >
        {days.map((day) => {
          const list = byDay.get(day) ?? [];
          const layout = layoutDay(list);
          const today = day === TODAY_ISO;

          return (
            <div
              key={day}
              onClick={(clickEvent) => {
                if (clickEvent.target !== clickEvent.currentTarget) return;
                onCreateAt(day, slotOf(clickEvent.currentTarget, clickEvent.clientY));
              }}
              className={cn(
                "relative cursor-crosshair border-l border-line first:border-l-0",
                isWeekend(day) && "bg-surface-2/50",
                today && "bg-accent-soft/40",
              )}
              style={{ height: TIMELINE_HEIGHT, backgroundImage: HOUR_LINES }}
            >
              {today ? (
                <div
                  className="pointer-events-none absolute inset-x-0 z-[5] h-0.5 bg-accent"
                  style={{ top: nowTop }}
                >
                  <span className="absolute -top-2.5 right-1 rounded-[7px] bg-accent px-1.5 py-px text-[9.5px] font-extrabold text-accent-contrast tabular-nums">
                    {timeOf(nowMinutes)}
                  </span>
                </div>
              ) : null}

              {list.map((event) => {
                const geometry = blockGeometry(event);
                const slot = layout.get(event.id) ?? { col: 0, cols: 1 };
                const width = 100 / slot.cols;

                return (
                  <button
                    key={event.id}
                    type="button"
                    title={`${event.title} · ${timeRange(event)}`}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      onOpen(event);
                    }}
                    style={{
                      top: geometry.top,
                      height: geometry.height,
                      left: `calc(${slot.col * width}% + 1px)`,
                      width: `calc(${width}% - 2px)`,
                    }}
                    className={cn(
                      "absolute overflow-hidden rounded-[13px] border-0 text-left leading-tight transition-[filter] hover:brightness-[0.97]",
                      single ? "rounded-2xl px-3 py-1.5 text-[12.5px]" : "px-2 py-1 text-[11px]",
                      TONE_PILL[toneOfEvent(event, calendars)],
                      slot.cols > 1 && "ring-2 ring-surface",
                    )}
                  >
                    <span className="block truncate font-extrabold tracking-[-0.015em]">{event.title}</span>
                    {geometry.height >= 34 ? (
                      <span className="block truncate text-[10px] font-bold tabular-nums opacity-80">
                        {event.start}–{event.end}
                        {event.fromMail ? " · mail" : ""}
                      </span>
                    ) : null}
                    {conflicts.has(event.id) ? (
                      <AlertTriangle
                        className="absolute top-1 right-1 size-2.5 text-amber-600 dark:text-amber-300"
                        strokeWidth={3}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  anchor,
  selectedDate,
  byDay,
  conflicts,
  calendars,
  onPick,
  onOpen,
  onCreateAt,
}: {
  anchor: string;
  selectedDate: string;
  byDay: Map<string, CalendarEvent[]>;
  conflicts: Set<string>;
  calendars: CalendarDef[];
  onPick: (date: string) => void;
  onOpen: (event: CalendarEvent) => void;
  onCreateAt: (date: string, start: string) => void;
}) {
  const days = weekDaysISO(anchor);

  return (
    <div data-testid="week-view" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 border-b border-line">
        <div className="w-[58px] shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-7">
          {days.map((day) => {
            const count = (byDay.get(day) ?? []).length;
            const today = day === TODAY_ISO;
            const selected = day === selectedDate;

            return (
              <button
                key={day}
                type="button"
                onClick={() => onPick(day)}
                aria-label={longDate(day)}
                className="focus-ring flex flex-col items-center gap-0.5 border-l border-line px-1 py-2 transition-colors first:border-l-0 hover:bg-surface-2"
              >
                <span
                  className={cn(
                    "text-[10px] font-bold tracking-[0.14em] uppercase",
                    today ? "text-accent-ink" : "text-ink-muted",
                  )}
                >
                  {shortWeekday(day)}
                </span>
                <span
                  className={cn(
                    "grid size-[30px] place-items-center rounded-full text-[14px] font-extrabold tracking-[-0.02em] tabular-nums",
                    today
                      ? "bg-accent text-accent-contrast shadow-[0_8px_18px_-10px_var(--accent)]"
                      : selected
                        ? "text-accent-ink ring-1 ring-accent-ring"
                        : "text-ink",
                  )}
                >
                  {Number(day.slice(8))}
                </span>
                <span className="text-[9.5px] font-bold text-ink-muted tabular-nums">{count || "—"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Timeline
          days={days}
          byDay={byDay}
          conflicts={conflicts}
          calendars={calendars}
          single={false}
          onOpen={onOpen}
          onCreateAt={onCreateAt}
        />
      </div>
    </div>
  );
}

function DayView({
  selectedDate,
  byDay,
  conflicts,
  calendars,
  onOpen,
  onCreateAt,
}: {
  selectedDate: string;
  byDay: Map<string, CalendarEvent[]>;
  conflicts: Set<string>;
  calendars: CalendarDef[];
  onOpen: (event: CalendarEvent) => void;
  onCreateAt: (date: string, start: string) => void;
}) {
  const count = (byDay.get(selectedDate) ?? []).length;

  return (
    <div data-testid="day-view" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <SectionLabel>{selectedDate === TODAY_ISO ? "Aujourd'hui" : "Journée sélectionnée"}</SectionLabel>
          <p className="mt-1 truncate text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
            {longDate(selectedDate)}
          </p>
        </div>
        <span className="ml-auto pb-1 text-[11.5px] font-semibold text-ink-muted tabular-nums">
          {count} rendez-vous
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Timeline
          days={[selectedDate]}
          byDay={byDay}
          conflicts={conflicts}
          calendars={calendars}
          single
          onOpen={onOpen}
          onCreateAt={onCreateAt}
        />
      </div>
    </div>
  );
}

function ListView({
  events,
  conflicts,
  calendars,
  onOpen,
}: {
  events: CalendarEvent[];
  conflicts: Set<string>;
  calendars: CalendarDef[];
  onOpen: (event: CalendarEvent) => void;
}) {
  const upcoming = upcomingEvents(events, TODAY_ISO);
  const groups: { date: string; list: CalendarEvent[] }[] = [];
  for (const event of upcoming) {
    const last = groups[groups.length - 1];
    if (last && last.date === event.date) last.list.push(event);
    else groups.push({ date: event.date, list: [event] });
  }

  return (
    <div data-testid="list-view" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end gap-3 border-b border-line px-5 py-3">
        <div>
          <SectionLabel>Liste</SectionLabel>
          <p className="mt-1 text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">À venir</p>
        </div>
        <span className="ml-auto pb-1 text-[11.5px] font-semibold text-ink-muted tabular-nums">
          {upcoming.length} rendez-vous
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-6">
        {groups.length === 0 ? (
          <EmptyState
            icon={<CalendarDays className="size-5" strokeWidth={2.2} />}
            title="Rien à venir"
            hint="Aucun rendez-vous ne correspond à la période et aux filtres."
          />
        ) : null}

        {groups.map((group) => (
          <div key={group.date} className="pt-3.5">
            <div className="flex items-center gap-2 px-1 pb-1.5">
              <span className="text-[11px] font-extrabold tracking-[0.1em] text-ink-muted uppercase">
                {longDate(group.date)}
              </span>
              <span className="rounded-[7px] bg-accent-soft px-1.5 py-px text-[10px] font-extrabold text-accent-ink tabular-nums">
                {group.list.length}
              </span>
            </div>

            {group.list.map((event) => {
              const tone = toneOfEvent(event, calendars);
              const meta = [
                event.location,
                event.attendees?.length
                  ? `${event.attendees.length} invité${event.attendees.length > 1 ? "s" : ""}`
                  : null,
                event.calendar,
              ].filter(Boolean);

              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onOpen(event)}
                  className="focus-ring mb-1.5 flex w-full items-center gap-3 rounded-[18px] border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-accent-ring hover:bg-surface-2/40"
                >
                  <span className="flex min-w-[92px] shrink-0 items-baseline gap-1 text-[11.5px] font-extrabold text-ink tabular-nums">
                    {event.start}
                    <em className="text-[10.5px] font-bold text-ink-muted not-italic">→ {event.end}</em>
                  </span>
                  <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-extrabold tracking-[-0.025em] text-ink">
                      {event.title}
                    </span>
                    <span className="block truncate text-[11px] font-semibold text-ink-muted">
                      {meta.join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {event.fromMail || event.mailId ? (
                      <Badge tone="accent">
                        <Mail className="size-2.5" strokeWidth={2.8} />
                        mail
                      </Badge>
                    ) : null}
                    {conflicts.has(event.id) ? <Badge tone="amber">Conflit</Badge> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniMonth({
  anchor,
  selectedDate,
  byDay,
  calendars,
  onPick,
  onShift,
}: {
  anchor: string;
  selectedDate: string;
  byDay: Map<string, CalendarEvent[]>;
  calendars: CalendarDef[];
  onPick: (date: string) => void;
  onShift: (delta: number) => void;
}) {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7)) - 1;
  const cells = miniMonthCells(year, month);

  return (
    <section data-testid="mini-month" className="shrink-0 rounded-[20px] border border-line bg-surface p-2.5">
      <div className="flex items-center gap-1">
        <SectionLabel>
          {capitalizeFirst(new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(new Date(year, month, 1, 12)))}{" "}
          {year}
        </SectionLabel>
        <div className="ml-auto flex items-center gap-0.5">
          <DIconButton label="Mois précédent" className="size-6" onClick={() => onShift(-1)}>
            <ChevronLeft className="size-3.5" strokeWidth={2.4} />
          </DIconButton>
          <DIconButton label="Mois suivant" className="size-6" onClick={() => onShift(1)}>
            <ChevronRight className="size-3.5" strokeWidth={2.4} />
          </DIconButton>
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-7 gap-px">
        {WEEKDAYS.map((weekday, index) => (
          <span key={index} className="grid h-5 place-items-center text-[9.5px] font-bold text-ink-muted">
            {weekday}
          </span>
        ))}

        {cells.map((day, index) => {
          if (day === null) return <span key={`empty-${index}`} className="h-7" />;
          const iso = isoDay(year, month, day);
          const list = byDay.get(iso) ?? [];
          const tones = Array.from(new Set(list.map((event) => toneOfEvent(event, calendars)))).slice(0, 3);
          const today = iso === TODAY_ISO;
          const selected = iso === selectedDate;

          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              aria-label={longDate(iso)}
              className={cn(
                "focus-ring relative grid h-7 place-items-center rounded-full text-[11px] font-bold tabular-nums transition-colors",
                today
                  ? "bg-accent text-accent-contrast"
                  : selected
                    ? "text-accent-ink ring-1 ring-accent-ring"
                    : "text-ink hover:bg-surface-2",
              )}
            >
              {day}
              {tones.length > 0 ? (
                <span className="absolute bottom-0.5 left-1/2 flex -translate-x-1/2 gap-0.5">
                  {tones.map((tone) => (
                    <i
                      key={tone}
                      className={cn(
                        "block size-[3px] rounded-full",
                        today ? "bg-accent-contrast/80" : TONE_DOT[tone],
                      )}
                    />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function RailCheck({
  label,
  checked,
  count,
  tone,
  onChange,
}: {
  label: string;
  checked: boolean;
  count: number;
  tone?: number;
  onChange: () => void;
}) {
  return (
    <label className="flex h-8 cursor-pointer items-center gap-2 rounded-[10px] px-1.5 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface-2">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={onChange}
        className="size-[15px] shrink-0 accent-accent"
      />
      {tone === undefined ? null : <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />}
      <span className="truncate">{label}</span>
      <span className="ml-auto text-[10.5px] font-bold text-ink-muted tabular-nums">{count}</span>
    </label>
  );
}

function FilterGroup({
  label,
  count,
  testId,
  children,
}: {
  label: string;
  count: number;
  testId?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="flex flex-col gap-1">
      <SectionLabel>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="focus-ring flex w-full items-center gap-1.5 rounded-lg py-0.5 text-left transition-colors hover:text-ink"
        >
          {label}
          <span className="text-[10.5px] font-bold text-ink-muted tabular-nums">{count}</span>
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 shrink-0 text-ink-muted transition-transform duration-200",
              !open && "-rotate-90",
            )}
            strokeWidth={2.4}
          />
        </button>
      </SectionLabel>
      {open ? (
        <div data-testid={testId} className="mt-0.5 flex flex-col gap-px">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function DayPanel({
  selectedDate,
  dayEvents,
  detail,
  conflicts,
  calendars,
  overlaps,
  hasFilters,
  confirmingDelete,
  deleting,
  onSelect,
  onBack,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onOpenMail,
  freeBusyAccount,
}: {
  selectedDate: string;
  dayEvents: CalendarEvent[];
  detail: CalendarEvent | null;
  conflicts: Set<string>;
  calendars: CalendarDef[];
  overlaps: CalendarEvent[];
  hasFilters: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
  onSelect: (event: CalendarEvent) => void;
  onBack: () => void;
  onEdit: (event: CalendarEvent) => void;
  onDelete: (event: CalendarEvent) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onOpenMail?: () => void;
  /** Compte Zimbra interrogé pour les disponibilités des invités. */
  freeBusyAccount?: string | null;
}) {
  const tone = detail ? toneOfEvent(detail, calendars) : 0;
  const external = detail?.external ? externalBadge(detail) : null;
  const editable = Boolean(detail?.caldav);
  const readOnly = external !== null && !editable;

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionLabel>Journée</SectionLabel>
        <span className="ml-auto text-[11px] font-bold text-ink-muted tabular-nums">
          {dayEvents.length} événement{dayEvents.length > 1 ? "s" : ""}
        </span>
      </div>

      <p
        data-testid="day-heading"
        className="shrink-0 truncate text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink"
      >
        {longDate(selectedDate)}
      </p>

      {detail ? (
        <div data-testid="event-detail" className="flex flex-col gap-2.5">
          <DButton variant="ghost" size="sm" className="self-start rounded-full" onClick={onBack}>
            <ArrowLeft className="size-3.5" strokeWidth={2.4} />
            Retour à la journée
          </DButton>

          <div className="rounded-[26px] border border-line bg-surface p-5">
            <div className="flex items-center gap-1.5">
              <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
              <SectionLabel>{detail.calendar ?? "Agenda"}</SectionLabel>
            </div>

            <p className="mt-1.5 text-[18px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
              {detail.title}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {detail.fromMail || detail.mailId ? (
                <Badge tone="accent">
                  <Mail className="size-2.5" strokeWidth={2.6} />
                  mail
                </Badge>
              ) : null}
              {external ? (
                <Badge tone={external.tone}>
                  {editable ? external.label : `${external.label} · lecture seule`}
                </Badge>
              ) : null}
              {detail.recurring ? <Badge tone="neutral">récurrent</Badge> : null}
              {conflicts.has(detail.id) ? <Badge tone="amber">Conflit</Badge> : null}
            </div>

            <p className="mt-4 flex items-center gap-2 text-[13px] font-bold text-ink tabular-nums">
              <Clock className="size-4 shrink-0" strokeWidth={2.2} />
              {timeRange(detail)}
            </p>

            {detail.location ? (
              <p className="mt-2 flex items-center gap-2 text-[11.5px] font-semibold text-ink-muted">
                <MapPin className="size-3.5 shrink-0" strokeWidth={2.2} />
                <span className="truncate">{detail.location}</span>
              </p>
            ) : null}

            {descriptionOf(detail) ? (
              <p className="mt-4 text-[12.5px] leading-relaxed font-medium text-ink-soft">
                {descriptionOf(detail)}
              </p>
            ) : null}

            {detail.attendees?.length ? (
              <div className="mt-4">
                <SectionLabel>Participants</SectionLabel>
                <div className="mt-2 flex flex-col gap-1.5">
                  {detail.attendees.map((person, index) => (
                    <span key={person} className="flex items-center gap-2 text-[11.5px] font-semibold text-ink-soft">
                      <Avatar name={person} tone={index} size={22} rounded="rounded-full" />
                      <span className="truncate">{person}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <GuestFreeBusy
              accountId={freeBusyAccount}
              attendees={detail.attendees ?? []}
              date={detail.date}
              start={detail.start}
              end={detail.end}
            />

            {overlaps.length > 0 ? (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-[16px] border border-amber-500/40 bg-amber-500/12 px-3 py-2 text-[11.5px] font-bold text-amber-700 dark:text-amber-300"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.2} />
                <p>Chevauchement : {overlaps.map((event) => event.title).join(", ")}.</p>
              </div>
            ) : null}

            {onOpenMail ? (
              <DButton variant="soft" size="md" className="mt-4" onClick={onOpenMail}>
                <Inbox className="size-4" strokeWidth={2.2} />
                Voir le mail
              </DButton>
            ) : null}
          </div>

          {readOnly && external ? (
            <p className="flex items-center gap-2 rounded-[16px] border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] font-bold text-sky-700 dark:text-sky-300">
              <Link2 className="size-3.5 shrink-0" strokeWidth={2.4} />
              Calendrier {external.label} : lecture seule, modifiable à la source uniquement.
            </p>
          ) : confirmingDelete ? (
            <div
              role="group"
              aria-label="Confirmer la suppression"
              data-testid="event-delete-confirm"
              className="flex items-center gap-2 rounded-[16px] border border-rose-500/40 bg-rose-500/12 px-3 py-2"
            >
              <span className="text-[11px] font-bold text-rose-700 dark:text-rose-300">Supprimer ?</span>
              <DButton variant="danger" size="sm" className="ml-auto" disabled={deleting} onClick={onConfirmDelete}>
                <Trash2 className="size-3.5" strokeWidth={2.2} />
                Confirmer
              </DButton>
              <DButton variant="ghost" size="sm" onClick={onCancelDelete}>
                Annuler
              </DButton>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <DButton variant="soft" size="md" className="flex-1" onClick={() => onEdit(detail)}>
                <Pencil className="size-3.5" strokeWidth={2.2} />
                Modifier
              </DButton>
              <DButton variant="danger" size="md" className="flex-1" onClick={() => onDelete(detail)}>
                <Trash2 className="size-3.5" strokeWidth={2.2} />
                Supprimer
              </DButton>
            </div>
          )}
        </div>
      ) : dayEvents.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="size-5" strokeWidth={2.2} />}
          title={hasFilters ? "Aucun rendez-vous" : "Journée libre"}
          hint={
            hasFilters
              ? "Aucun événement ne correspond aux filtres."
              : "Aucun rendez-vous ce jour-là. Ajoutez-en un d'un clic."
          }
          className="py-6"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {dayEvents.map((event, index) => {
            const eventTone = toneOfEvent(event, calendars);
            const eventBadge = externalBadge(event);
            return (
              <BlurFade key={event.id} delay={0.05 * index}>
                <button
                  type="button"
                  data-testid="day-event"
                  onClick={() => onSelect(event)}
                  className="focus-ring block w-full rounded-[18px] border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent-ring hover:bg-surface-2/40"
                >
                  <span className="flex items-center gap-1.5">
                    <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[eventTone])} />
                    <span className="text-[11.5px] font-bold text-ink tabular-nums">
                      {timeRange(event)}
                    </span>
                    {event.fromMail || event.mailId ? (
                      <Badge tone="accent">
                        <Mail className="size-2.5" strokeWidth={2.6} />
                        mail
                      </Badge>
                    ) : null}
                    {event.external ? <Badge tone={eventBadge.tone}>{eventBadge.label}</Badge> : null}
                    {event.recurring ? <Badge tone="neutral">récurrent</Badge> : null}
                    {conflicts.has(event.id) ? <Badge tone="amber">Conflit</Badge> : null}
                  </span>

                  <span className="mt-1 block text-[13.5px] leading-snug font-extrabold tracking-[-0.03em] text-ink">
                    {event.title}
                  </span>

                  {event.location ? (
                    <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
                      <MapPin className="size-3.5 shrink-0" strokeWidth={2.2} />
                      <span className="truncate">{event.location}</span>
                    </span>
                  ) : null}

                  {event.attendees?.length ? (
                    <span className="mt-1.5 flex items-center gap-1.5">
                      <span className="flex shrink-0 -space-x-1.5">
                        {event.attendees.slice(0, 3).map((person, personIndex) => (
                          <Avatar
                            key={person}
                            name={person}
                            tone={personIndex}
                            size={18}
                            rounded="rounded-full"
                            className="ring-2 ring-surface"
                          />
                        ))}
                      </span>
                      {event.attendees.length > 3 ? (
                        <span className="text-[10.5px] font-bold text-ink-muted">
                          +{event.attendees.length - 3}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              </BlurFade>
            );
          })}
        </div>
      )}

    </div>
  );
}

export type NewEventInit = EventDraft;

export function DesktopCalendar({
  onNewEvent,
  onEditEvent,
}: {
  onNewEvent: (init?: string | NewEventInit, suggestion?: MailSuggestion) => void;
  onEditEvent: (event: CalendarEvent) => void;
}) {
  const {
    events,
    mails,
    accounts,
    suggestions,
    selectedDate,
    setSelectedDate,
    setEvents,
    dismissSuggestion,
    openMessage,
    notify,
  } = useMailStore();
  const [calendars] = useCalendars();
  const {
    ics,
    syncing: externalSyncing,
    refresh: refreshExternal,
  } = useExternalCalendarRefresh(calendars, notify);

  const [mode, setMode] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState(selectedDate);
  const [direction, setDirection] = useState(0);
  const [hiddenCalendars, setHiddenCalendars] = useState<Set<string>>(() => new Set());
  const [fromMail, setFromMail] = useState(false);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [attendeesOnly, setAttendeesOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const narrow = useNarrowViewport();

  const externalEvents = useMemo(() => externalCalendarEvents(ics, calendars), [ics, calendars]);
  const icsEvents = useMemo(
    () => externalEvents.filter((event) => externalEventKind(event) === "ics"),
    [externalEvents],
  );
  const caldavEvents = useMemo(
    () => externalEvents.filter((event) => externalEventKind(event) === "caldav"),
    [externalEvents],
  );
  const googleEvents = useMemo(
    () => externalEvents.filter((event) => externalEventKind(event) === "google"),
    [externalEvents],
  );
  const allEvents = useMemo(() => [...events, ...externalEvents], [events, externalEvents]);
  const icsSubscriptions = useMemo(() => calendars.filter((def) => icsUrlOf(def)), [calendars]);
  const caldavSubscriptions = useMemo(() => calendars.filter(isCaldavCalendar), [calendars]);
  const googleSubscriptions = useMemo(() => calendars.filter(isGoogleCalendar), [calendars]);

  const calendarList = useMemo(() => calendarsInUse(allEvents, calendars), [allEvents, calendars]);
  const conflicts = useMemo(() => conflictingIds(allEvents), [allEvents]);
  const eventSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.kind === "event"),
    [suggestions],
  );

  const acceptSuggestion = (suggestion: MailSuggestion) =>
    onNewEvent(draftFromSuggestion(suggestion), suggestion);

  const activeCalendars = useMemo(() => {
    const names = new Set(
      calendarList.filter((def) => !hiddenCalendars.has(def.name)).map((def) => def.name),
    );
    if (!hiddenCalendars.has("") && allEvents.some((event) => !event.calendar)) names.add("");
    return names;
  }, [calendarList, hiddenCalendars, allEvents]);

  const visible = useMemo(
    () =>
      filterEvents(
        allEvents,
        { calendars: activeCalendars, fromMail, conflictsOnly, attendeesOnly, query },
        conflicts,
      ),
    [allEvents, activeCalendars, fromMail, conflictsOnly, attendeesOnly, query, conflicts],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of visible) {
      const list = map.get(event.date);
      if (list) list.push(event);
      else map.set(event.date, [event]);
    }
    for (const list of map.values()) list.sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    return map;
  }, [visible]);

  const dayEvents = byDay.get(selectedDate) ?? [];
  const detail = detailId ? (allEvents.find((event) => event.id === detailId) ?? null) : null;
  const mail = detail?.mailId ? mails.find((entry) => entry.id === detail.mailId) : undefined;

  const inPeriod = (iso: string) => {
    if (mode === "month") return iso.slice(0, 7) === anchor.slice(0, 7);
    if (mode === "week") {
      const start = weekStartISO(anchor);
      return iso >= start && iso <= addDaysISO(start, 6);
    }
    if (mode === "day") return iso === selectedDate;
    return iso >= TODAY_ISO;
  };

  const periodEvents = visible.filter((event) => inPeriod(event.date));
  const calendarPeriodEvents = periodEvents.filter(
    (event) => !event.calendar || calendarList.some((def) => def.name === event.calendar),
  );
  const orphanPeriodCount = allEvents.filter((event) => !event.calendar && inPeriod(event.date)).length;
  const filterPeriodEvents = periodEvents.filter(
    (event) => event.fromMail || conflicts.has(event.id) || Boolean(event.attendees?.length),
  );
  const mailPeriodEvents = filterPeriodEvents.filter((event) => event.fromMail);
  const conflictPeriodEvents = filterPeriodEvents.filter(
    (event) => !event.fromMail && conflicts.has(event.id),
  );
  const attendeePeriodEvents = filterPeriodEvents.filter(
    (event) => !event.fromMail && !conflicts.has(event.id) && Boolean(event.attendees?.length),
  );
  const filterCount = mailPeriodEvents.length + conflictPeriodEvents.length + attendeePeriodEvents.length;
  const hasFilters =
    Boolean(query.trim()) || fromMail || conflictsOnly || attendeesOnly || hiddenCalendars.size > 0;

  const isOnToday = periodContainsToday(mode, anchor, selectedDate);

  const periodKey =
    mode === "month"
      ? anchor.slice(0, 7)
      : mode === "week"
        ? weekStartISO(anchor)
        : mode === "day"
          ? anchor
          : anchor.slice(0, 7);

  const syncView = (date: string) => {
    if (mode === "list") return;
    setAnchor(date);
  };

  const pick = (date: string) => {
    setSelectedDate(date);
    syncView(date);
    setDetailId(null);
  };

  const openEvent = (event: CalendarEvent) => {
    syncView(event.date);
    setSelectedDate(event.date);
    setDetailId(event.id);
  };

  const createAt = (date: string) => {
    setSelectedDate(date);
    onNewEvent(date);
  };

  const createSlot = (date: string, start: string) => {
    setSelectedDate(date);
    onNewEvent(`${date}T${start}`);
  };

  const shift = (delta: number) => {
    setDirection(delta);
    const next = shiftAnchor(mode, anchor, delta);
    setAnchor(next);
    setDetailId(null);
    if (mode === "month") {
      const year = Number(next.slice(0, 4));
      const month = Number(next.slice(5, 7)) - 1;
      setSelectedDate(isoDay(year, month, Math.min(Number(selectedDate.slice(8, 10)), daysInMonth(year, month))));
    } else if (mode === "week") {
      setSelectedDate(addDaysISO(selectedDate, delta * 7));
    } else if (mode === "day") {
      setSelectedDate(next);
    }
  };

  const goToday = () => {
    setDirection(0);
    setAnchor(TODAY_ISO);
    setSelectedDate(TODAY_ISO);
    setDetailId(null);
  };

  const changeMode = (next: ViewMode) => {
    if (next === mode) return;
    setDirection(0);
    setMode(next);
    setDetailId(null);
    if (next === "list") setAnchor(selectedDate);
  };

  const toggleCalendar = (name: string) => {
    setHiddenCalendars((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const removeEvent = (target: CalendarEvent) => {
    if (!target.caldav) {
      setEvents((current) => current.filter((event) => event.id !== target.id));
      notify("Rendez-vous supprimé");
      setDetailId(null);
      return;
    }
    setPendingDelete(target.id);
  };

  const confirmRemove = async () => {
    const target = detail;
    if (!target?.caldav) return;
    const def = calendars.find((entry) => caldavSourceIdOf(entry) === target.caldav?.sourceId);
    if (!def) {
      notify("Calendrier CalDAV introuvable · relisez les réglages des calendriers");
      setPendingDelete(null);
      return;
    }
    setDeleting(true);
    try {
      commitIcsState(await deleteCaldavEvent(def, target));
      notify("Rendez-vous supprimé");
      setDetailId(null);
    } catch (error) {
      notify(await caldavWriteFailure(def, error));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const overlaps = detail
    ? overlappingEvents(allEvents, detail.date, detail.start, detail.end).filter(
        (event) => event.id !== detail.id,
      )
    : [];

  return (
    <div
      data-testid="calendar-layout"
      className={cn("flex h-full min-h-0 w-full", narrow ? "flex-col overflow-y-auto" : "flex-row")}
    >
      <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col", narrow && "min-h-[520px]")}>
        <header
          data-testid="calendar-header"
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line",
            narrow ? "px-4 py-3" : "px-5 py-3",
          )}
        >
          <PaneTitle hint={`${visible.length} sur ${allEvents.length} événement${allEvents.length > 1 ? "s" : ""}`}>
            Agenda
          </PaneTitle>

          <div role="tablist" aria-label="Vue de l'agenda" className="flex shrink-0 items-center gap-0.5 rounded-[15px] border border-line bg-surface-2 p-[3px]">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={mode === tab.id}
                data-testid={`view-${tab.id}`}
                onClick={() => changeMode(tab.id)}
                className={cn(
                  "focus-ring h-8 shrink-0 rounded-xl px-3 text-[12px] font-bold transition-colors",
                  mode === tab.id
                    ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-9px_var(--accent)]"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex min-w-0 items-center gap-0.5">
            <DIconButton label="Période précédente" onClick={() => shift(-1)}>
              <ChevronLeft className="size-4" strokeWidth={2.4} />
            </DIconButton>
            <span
              data-testid="period-label"
              className={cn(
                "min-w-0 truncate text-center font-extrabold tracking-[-0.035em] text-ink tabular-nums",
                narrow ? "text-[15px] leading-tight" : "min-w-[150px] text-[17px] leading-tight",
              )}
            >
              {periodLabel(mode, anchor)}
            </span>
            <DIconButton label="Période suivante" onClick={() => shift(1)}>
              <ChevronRight className="size-4" strokeWidth={2.4} />
            </DIconButton>
          </div>

          <DButton
            variant="ghost"
            size="md"
            onClick={goToday}
            disabled={isOnToday}
            title={isOnToday ? "Vous êtes déjà sur aujourd'hui" : "Revenir à aujourd'hui"}
          >
            Aujourd'hui
          </DButton>

          <TextInput
            type="search"
            aria-label="Rechercher"
            placeholder="Rechercher…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ml-auto h-9 min-w-[110px] max-w-[260px] flex-1 rounded-full"
          />
        </header>

        <div data-testid="grid-viewport" className="relative min-h-0 flex-1 overflow-auto">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={`${mode}:${periodKey}`}
              custom={direction}
              variants={VIEW_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              className="h-full min-h-0 origin-top"
            >
              {mode === "month" ? (
                <MonthView
                  anchor={anchor}
                  selectedDate={selectedDate}
                  byDay={byDay}
                  conflicts={conflicts}
                  calendars={calendars}
                  onPick={pick}
                  onOpen={openEvent}
                  onCreateAt={createAt}
                />
              ) : mode === "week" ? (
                <WeekView
                  anchor={anchor}
                  selectedDate={selectedDate}
                  byDay={byDay}
                  conflicts={conflicts}
                  calendars={calendars}
                  onPick={pick}
                  onOpen={openEvent}
                  onCreateAt={createSlot}
                />
              ) : mode === "day" ? (
                <DayView
                  selectedDate={selectedDate}
                  byDay={byDay}
                  conflicts={conflicts}
                  calendars={calendars}
                  onOpen={openEvent}
                  onCreateAt={createSlot}
                />
              ) : (
                <ListView
                  events={visible}
                  conflicts={conflicts}
                  calendars={calendars}
                  onOpen={openEvent}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      <aside
        data-testid="day-panel"
        className={cn(
          "flex min-h-0 shrink-0 flex-col border-line",
          narrow ? "w-full border-t" : "min-w-[320px] w-[32%] max-w-[440px] border-l",
        )}
      >
        <div className={cn("flex min-h-0 flex-col gap-3.5 px-4 pt-4", narrow ? "pb-6" : "flex-1 overflow-y-auto pb-6")}>
          {mode === "month" ? null : (
            <MiniMonth
              anchor={anchor}
              selectedDate={selectedDate}
              byDay={byDay}
              calendars={calendars}
              onPick={pick}
              onShift={(delta) => {
                const next = shiftAnchor("month", anchor, delta);
                setAnchor(next);
                if (mode === "day") setSelectedDate(next);
              }}
            />
          )}

          <FilterGroup label="Mes calendriers" count={calendarPeriodEvents.length} testId="calendar-filters">
            {calendarList.map((def) => (
              <RailCheck
                key={def.id}
                label={def.name}
                tone={def.tone}
                checked={!hiddenCalendars.has(def.name)}
                count={calendarPeriodEvents.filter((event) => event.calendar === def.name).length}
                onChange={() => toggleCalendar(def.name)}
              />
            ))}
            {orphanPeriodCount > 0 ? (
              <RailCheck
                label="Sans calendrier"
                checked={!hiddenCalendars.has("")}
                count={orphanPeriodCount}
                onChange={() => toggleCalendar("")}
              />
            ) : null}
          </FilterGroup>

          {icsSubscriptions.length > 0 ? (
            <ExternalRefreshRow
              label="Abonnements ICS"
              refreshLabel="Actualiser les abonnements ICS"
              count={icsEvents.length}
              syncing={externalSyncing}
              onRefresh={() => void refreshExternal(icsSubscriptions)}
            />
          ) : null}

          {caldavSubscriptions.length > 0 ? (
            <ExternalRefreshRow
              label="Sources CalDAV"
              refreshLabel="Actualiser les sources CalDAV"
              count={caldavEvents.length}
              syncing={externalSyncing}
              onRefresh={() => void refreshExternal(caldavSubscriptions)}
            />
          ) : null}

          {googleSubscriptions.length > 0 ? (
            <ExternalRefreshRow
              label="Agendas Google"
              refreshLabel="Actualiser les agendas Google"
              count={googleEvents.length}
              syncing={externalSyncing}
              onRefresh={() => void refreshExternal(googleSubscriptions)}
            />
          ) : null}

          <FilterGroup label="Filtres" count={filterCount}>
            <RailCheck
              label="Depuis un mail"
              checked={fromMail}
              count={mailPeriodEvents.length}
              onChange={() => setFromMail((current) => !current)}
            />
            <RailCheck
              label="Conflits"
              checked={conflictsOnly}
              count={conflictPeriodEvents.length}
              onChange={() => setConflictsOnly((current) => !current)}
            />
            <RailCheck
              label="Avec invités"
              checked={attendeesOnly}
              count={attendeePeriodEvents.length}
              onChange={() => setAttendeesOnly((current) => !current)}
            />
          </FilterGroup>

          {eventSuggestions.length > 0 ? (
            <FilterGroup label="Suggestions de RDV" count={eventSuggestions.length} testId="event-suggestions">
              {eventSuggestions.map((suggestion) => (
                <EventSuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  account={sourceAccountLabel(accounts, suggestion.account)}
                  mail={mails.find((mail) => mail.id === suggestion.mailId)}
                  onAccept={() => acceptSuggestion(suggestion)}
                  onOpenMail={openMessage}
                  onDismiss={() => dismissSuggestion(suggestion)}
                />
              ))}
            </FilterGroup>
          ) : null}

          <div className="h-px shrink-0 bg-line" />

          <DayPanel
            selectedDate={selectedDate}
            dayEvents={dayEvents}
            detail={detail}
            conflicts={conflicts}
            calendars={calendars}
            overlaps={overlaps}
            hasFilters={hasFilters}
            confirmingDelete={detail !== null && pendingDelete === detail.id}
            deleting={deleting}
            onSelect={openEvent}
            onBack={() => setDetailId(null)}
            onEdit={onEditEvent}
            onDelete={removeEvent}
            onConfirmDelete={() => void confirmRemove()}
            onCancelDelete={() => setPendingDelete(null)}
            onOpenMail={mail ? () => openMessage(mail) : undefined}
            freeBusyAccount={zimbraAccountOf(accounts)?.id ?? null}
          />
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

export function NewEventDialog({
  open,
  event,
  initialDate,
  draft,
  onCreated,
  onClose,
}: {
  open: boolean;
  event: CalendarEvent | null;
  initialDate?: string;
  draft?: NewEventInit;
  onCreated?: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <NewEventForm
      event={event}
      initialDate={initialDate}
      draft={draft}
      onCreated={onCreated}
      onClose={onClose}
    />
  );
}

function NewEventForm({
  event,
  initialDate,
  draft,
  onCreated,
  onClose,
}: {
  event: CalendarEvent | null;
  initialDate?: string;
  draft?: NewEventInit;
  onCreated?: () => void;
  onClose: () => void;
}) {
  const { events, selectedDate, setEvents, setSelectedDate, notify } = useMailStore();
  const [calendars] = useCalendars();
  const editing = event !== null;

  const [initDate, initStart] = (initialDate ?? "").split("T");
  const [title, setTitle] = useState(event?.title ?? draft?.title ?? "");
  const [date, setDate] = useState(event?.date ?? draft?.date ?? (initDate || undefined) ?? selectedDate);
  const [start, setStart] = useState(event?.start ?? draft?.start ?? (initStart || undefined) ?? "14:00");
  const [end, setEnd] = useState(event?.end ?? draft?.end ?? (initStart ? addMinutes(initStart, 60) : "15:00"));
  const [calendar, setCalendar] = useState(event?.calendar ?? calendars[0]?.name ?? "Pro");
  const [tone, setTone] = useState(event?.tone === undefined ? "" : String(event.tone));
  const [location, setLocation] = useState(event?.location ?? draft?.location ?? "");
  const [people, setPeople] = useState((event?.attendees ?? []).join(", "));
  const [description, setDescription] = useState(descriptionOf(event) ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEscapeLayer(true, onClose);

  const invalid = !title.trim() || end <= start;
  const clashes =
    invalid || !date ? [] : overlappingEvents(events.filter((entry) => entry.id !== event?.id), date, start, end);
  const resolvedTone = tone === "" ? toneOfEvent({ calendar }, calendars) : Number(tone);
  /** Un événement CalDAV s'écrit chez le démon ; un calendrier local garde le store. */
  const caldavDef = event?.caldav
    ? calendars.find((def) => caldavSourceIdOf(def) === event.caldav?.sourceId)
    : calendars.find((def) => def.name === calendar && isCaldavCalendar(def));

  const guests = guestEmails(people);
  const caldavInput = () => ({
    title: title.trim(),
    date,
    start,
    end,
    location: location.trim() || undefined,
    description: description.trim() || undefined,
    ...(guests.length > 0 ? { attendees: guests } : {}),
  });

  const saveCaldav = async (def: CalendarDef) => {
    setSaving(true);
    setFailure(null);
    try {
      const target = event;
      commitIcsState(
        target ? await updateCaldavEvent(def, target, caldavInput()) : await createCaldavEvent(def, caldavInput()),
      );
      notify(target ? "Rendez-vous mis à jour" : "Rendez-vous créé");
      setSelectedDate(date);
      if (!target) onCreated?.();
      onClose();
    } catch (error) {
      setFailure(await caldavWriteFailure(def, error));
    } finally {
      setSaving(false);
    }
  };

  const removeCaldav = async (def: CalendarDef, target: CalendarEvent) => {
    setSaving(true);
    setFailure(null);
    try {
      commitIcsState(await deleteCaldavEvent(def, target));
      notify("Rendez-vous supprimé");
      onClose();
    } catch (error) {
      setFailure(await caldavWriteFailure(def, error));
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (invalid || saving) return;
    if (caldavDef) {
      void saveCaldav(caldavDef);
      return;
    }
    const attendees = people
      .split(",")
      .map((person) => person.trim())
      .filter(Boolean);
    const next: CalendarEvent = {
      ...(event ?? {}),
      id: event?.id ?? `evt-${Date.now()}`,
      date,
      start,
      end,
      title: title.trim(),
      tone: tone === "" ? undefined : Number(tone),
      location: location.trim() || undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
      calendar,
      description: description.trim() || undefined,
      ...(event?.mailId ? {} : draft?.mailId ? { mailId: draft.mailId, fromMail: true } : {}),
    };

    if (event) {
      setEvents((current) => current.map((entry) => (entry.id === event.id ? next : entry)));
      notify("Rendez-vous mis à jour");
    } else {
      setEvents((current) => [...current, next]);
      notify("Rendez-vous créé");
      onCreated?.();
    }
    setSelectedDate(date);
    onClose();
  };

  const remove = () => {
    if (!event || saving) return;
    if (caldavDef) {
      if (!confirmDelete) {
        setConfirmDelete(true);
        return;
      }
      void removeCaldav(caldavDef, event);
      return;
    }
    setEvents((current) => current.filter((entry) => entry.id !== event.id));
    notify("Rendez-vous supprimé");
    onClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4">
      <motion.button
        type="button"
        aria-label="Fermer"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16 }}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
      />

      <motion.div
        data-testid="event-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Modifier le rendez-vous" : "Nouveau rendez-vous"}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex max-h-[calc(100%-16px)] w-full max-w-[560px] flex-col overflow-hidden rounded-[26px] border border-line bg-surface shadow-[0_40px_90px_-40px_var(--accent),0_20px_50px_-30px_color-mix(in_oklab,var(--ink)_40%,transparent)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3.5">
          <div>
            <SectionLabel>Agenda</SectionLabel>
            <h2 className="text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
              {editing ? "Modifier le rendez-vous" : "Nouveau rendez-vous"}
            </h2>
          </div>
          <DIconButton label="Fermer" className="ml-auto" onClick={onClose}>
            <X className="size-4" strokeWidth={2.2} />
          </DIconButton>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
          {!editing && draft?.mailId ? (
            <div className="flex items-start gap-2.5 rounded-[16px] border border-accent-ring/50 bg-accent-soft/45 px-3 py-2">
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
          <Field label="Titre">
            <TextInput
              autoFocus
              data-testid="event-title-input"
              value={title}
              onChange={(inputEvent) => setTitle(inputEvent.target.value)}
              placeholder="Revue de design, déjeuner, visio…"
            />
          </Field>

          <div className="grid grid-cols-[1.35fr_1fr_1fr] gap-2.5">
            <Field label="Date">
              <TextInput
                type="date"
                data-testid="event-date-input"
                value={date}
                onChange={(inputEvent) => setDate(inputEvent.target.value)}
              />
            </Field>
            <Field label="Début">
              <TextInput
                type="time"
                data-testid="event-start-input"
                value={start}
                onChange={(inputEvent) => {
                  setStart(inputEvent.target.value);
                  setEnd(addMinutes(inputEvent.target.value, 60));
                }}
              />
            </Field>
            <Field label="Fin">
              <TextInput
                type="time"
                data-testid="event-end-input"
                value={end}
                onChange={(inputEvent) => setEnd(inputEvent.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Calendrier">
              <div className="relative">
                <span
                  className={cn(
                    "pointer-events-none absolute top-1/2 left-3 size-2 -translate-y-1/2 rounded-full",
                    TONE_DOT[toneOfEvent({ calendar }, calendars)],
                  )}
                />
                <select
                  aria-label="Calendrier"
                  data-testid="event-calendar-input"
                  value={calendar}
                  disabled={Boolean(event?.caldav)}
                  onChange={(inputEvent) => setCalendar(inputEvent.target.value)}
                  className="focus-ring h-10 w-full appearance-none rounded-xl border border-line bg-surface pr-7 pl-7 text-[12.5px] font-bold text-ink disabled:opacity-70"
                >
                  {calendars.map((def) => (
                    <option key={def.id} value={def.name}>
                      {def.name}
                    </option>
                  ))}
                </select>
                <ChevronDownGlyph />
              </div>
            </Field>

            <Field label="Couleur">
              <div className="relative">
                <span
                  className={cn(
                    "pointer-events-none absolute top-1/2 left-3 size-2 -translate-y-1/2 rounded-full",
                    TONE_DOT[resolvedTone],
                  )}
                />
                <select
                  aria-label="Couleur"
                  data-testid="event-tone-input"
                  value={tone}
                  onChange={(inputEvent) => setTone(inputEvent.target.value)}
                  className="focus-ring h-10 w-full appearance-none rounded-xl border border-line bg-surface pr-7 pl-7 text-[12.5px] font-bold text-ink"
                >
                  <option value="">Couleur du calendrier</option>
                  {TONE_LABELS.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
                <ChevronDownGlyph />
              </div>
            </Field>
          </div>

          <Field label="Lieu">
            <TextInput
              data-testid="event-location-input"
              value={location}
              onChange={(inputEvent) => setLocation(inputEvent.target.value)}
              placeholder="Lieu ou lien visio"
            />
          </Field>

          <Field label="Participants">
            <TextInput
              data-testid="event-attendees-input"
              value={people}
              onChange={(inputEvent) => setPeople(inputEvent.target.value)}
              placeholder="Invités (noms ou e-mails), séparés par une virgule"
            />
          </Field>

          <Field label="Description">
            <TextArea
              rows={2}
              data-testid="event-description-input"
              value={description}
              onChange={(inputEvent) => setDescription(inputEvent.target.value)}
              placeholder="Ordre du jour, lieu, lien visio…"
            />
          </Field>

          {caldavDef ? (
            <p
              data-testid="event-caldav-hint"
              className="flex items-center gap-1.5 text-[10.5px] font-semibold text-ink-muted"
            >
              <Link2 className="size-3.5 shrink-0" strokeWidth={2.4} />
              Calendrier CalDAV : l'événement est écrit sur le serveur.
            </p>
          ) : null}

          {failure ? (
            <div
              role="alert"
              data-testid="event-error"
              className="flex items-start gap-2 rounded-[16px] border border-rose-500/40 bg-rose-500/12 px-3 py-2 text-[11.5px] font-bold text-rose-700 dark:text-rose-300"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.2} />
              <p>{failure}</p>
            </div>
          ) : null}

          {clashes.length > 0 ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[16px] border border-amber-500/40 bg-amber-500/12 px-3 py-2 text-[11.5px] font-bold text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.2} />
              <p>Chevauchement sur ce créneau : {clashes.map((entry) => entry.title).join(", ")}.</p>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
          <p className="text-[11px] font-bold text-ink-muted tabular-nums">
            {start} → {end}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {editing ? (
              <DButton variant="danger" size="sm" disabled={saving} onClick={remove}>
                <Trash2 className="size-3.5" strokeWidth={2.2} />
                {confirmDelete ? "Confirmer la suppression" : "Supprimer"}
              </DButton>
            ) : null}
            <DButton variant="ghost" size="sm" onClick={onClose}>
              Annuler
            </DButton>
            <DButton variant="primary" size="md" disabled={invalid || saving} onClick={submit}>
              {saving ? "Enregistrement…" : editing ? "Enregistrer" : "Créer le rendez-vous"}
            </DButton>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function ChevronDownGlyph() {
  return (
    <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-muted">
      <ChevronDown className="size-3.5" strokeWidth={2.4} />
    </span>
  );
}
