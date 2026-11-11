import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Mail,
  MapPin,
  Plus,
  X,
} from "lucide-react";
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
  overlappingEvents,
} from "@/lib/calendar";
import { useMailStore } from "@/lib/store";
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
import { Avatar } from "@/components/ui/primitives";
import { addMinutes } from "@/screens/new-event-sheet";
import { cn } from "@/lib/utils";

type DesktopEvent = CalendarEvent & { description?: string };

const DAY_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

const TONE_PILL = [
  "bg-accent-soft text-accent-ink",
  "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  "bg-rose-500/12 text-rose-600 dark:text-rose-300",
];

const TONE_DOT = ["bg-accent", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

const toneOf = (tone: number) => tone % TONE_PILL.length;
const descriptionOf = (event: CalendarEvent) => (event as DesktopEvent).description;
const longDate = (iso: string) =>
  capitalizeFirst(DAY_FMT.format(new Date(`${iso}T12:00:00`)).replace(/[\u202f\u00a0]/g, " "));

function EventPill({ event, onOpen }: { event: CalendarEvent; onOpen?: () => void }) {
  const body = (
    <>
      <span className="shrink-0 text-[10px] tabular-nums opacity-70">{event.start}</span>
      <span className="truncate">{event.title}</span>
      {event.fromMail || event.mailId ? <Mail className="size-2.5 shrink-0" strokeWidth={2.8} /> : null}
    </>
  );
  const className = cn(
    "flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-left text-[11.5px] font-bold",
    TONE_PILL[toneOf(event.tone)],
  );

  if (!onOpen) return <span className={className}>{body}</span>;

  return (
    <button type="button" title={event.title} onClick={onOpen} className={cn("focus-ring", className)}>
      {body}
    </button>
  );
}

export function DesktopCalendar({ onNewEvent }: { onNewEvent: () => void }) {
  const { events, mails, selectedDate, setSelectedDate, openMessage } = useMailStore();
  const [view, setView] = useState({ year: CURRENT_YEAR, month: CURRENT_MONTH });
  const [direction, setDirection] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);

  const cells = monthGrid(view.year, view.month);
  const offset = cells.findIndex((cell) => cell !== null);
  const monthKey = `${view.year}-${String(view.month + 1).padStart(2, "0")}`;

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const list = map.get(event.date);
      if (list) list.push(event);
      else map.set(event.date, [event]);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [events]);

  const conflicts = useMemo(() => conflictingIds(events), [events]);
  const monthCount = events.filter((event) => event.date.startsWith(monthKey)).length;
  const dayEvents = byDay.get(selectedDate) ?? [];
  const detail = detailId ? (events.find((event) => event.id === detailId) ?? null) : null;

  const dateAt = (index: number) => {
    const date = new Date(view.year, view.month, 1 - offset + index);
    return {
      iso: isoDay(date.getFullYear(), date.getMonth(), date.getDate()),
      day: date.getDate(),
      inMonth: date.getMonth() === view.month,
    };
  };

  const syncView = (date: string) => {
    const [year, month] = date.split("-").map(Number);
    setView((current) =>
      current.year === year && current.month === month - 1 ? current : { year, month: month - 1 },
    );
  };

  const pick = (date: string) => {
    syncView(date);
    setSelectedDate(date);
    setDetailId(null);
  };

  const openEvent = (event: CalendarEvent) => {
    syncView(event.date);
    setSelectedDate(event.date);
    setDetailId(event.id);
  };

  const shiftMonth = (delta: number) => {
    setDirection(delta);
    const next = new Date(view.year, view.month + delta, 1);
    const year = next.getFullYear();
    const month = next.getMonth();
    setView({ year, month });
    setSelectedDate(isoDay(year, month, Math.min(Number(selectedDate.slice(8, 10)), daysInMonth(year, month))));
    setDetailId(null);
  };

  const goToday = () => {
    setView({ year: CURRENT_YEAR, month: CURRENT_MONTH });
    setSelectedDate(TODAY_ISO);
    setDetailId(null);
  };

  const mail = detail?.mailId ? mails.find((entry) => entry.id === detail.mailId) : undefined;
  const dayLabel = `${dayEvents.length} événement${dayEvents.length > 1 ? "s" : ""}`;

  return (
    <div className="flex h-full min-h-0 w-full">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-3.5">
          <PaneTitle hint={`${monthCount} événement${monthCount > 1 ? "s" : ""}`}>Agenda</PaneTitle>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <div className="flex items-center gap-1">
              <DIconButton label="Mois précédent" onClick={() => shiftMonth(-1)}>
                <ChevronLeft className="size-4" strokeWidth={2.2} />
              </DIconButton>
              <span className="min-w-[188px] text-center text-[22px] leading-none font-extrabold tracking-[-0.035em] text-ink tabular-nums">
                {monthLabel(view.month)} {view.year}
              </span>
              <DIconButton label="Mois suivant" onClick={() => shiftMonth(1)}>
                <ChevronRight className="size-4" strokeWidth={2.2} />
              </DIconButton>
            </div>
            <DButton variant="ghost" size="md" onClick={goToday}>
              Aujourd'hui
            </DButton>
            <DButton variant="primary" size="md" onClick={onNewEvent}>
              <Plus className="size-4" strokeWidth={2.4} />
              Nouveau rendez-vous
            </DButton>
          </div>
        </header>

        <div className="grid shrink-0 grid-cols-7 border-b border-line">
          {WEEKDAYS.map((weekday, index) => (
            <span
              key={index}
              className="flex h-7 items-center justify-center text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase"
            >
              {weekday}
            </span>
          ))}
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={monthKey}
              initial={{ opacity: 0, x: direction * 48 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -48 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              data-testid="month-grid"
              className="grid h-full min-h-0 grid-cols-7 auto-rows-fr"
            >
          {cells.map((_, index) => {
            const cell = dateAt(index);
            const list = byDay.get(cell.iso) ?? [];
            const visible = list.slice(0, 3);
            const hidden = cell.inMonth ? list.length - visible.length : 0;
            const isToday = cell.iso === TODAY_ISO;
            const isSelected = cell.iso === selectedDate;

            return (
              <div
                key={cell.iso}
                className={cn(
                  "flex min-h-0 flex-col gap-1 overflow-hidden border-b border-line p-2",
                  (index + 1) % 7 === 0 ? "border-r-0" : "border-r",
                  cell.inMonth ? "bg-surface" : "bg-surface-2/40 opacity-45",
                  cell.inMonth && index % 7 >= 5 && "bg-surface-2/60",
                  isSelected && "bg-accent-soft ring-1 ring-accent-ring",
                )}
              >
                <button
                  type="button"
                  onClick={() => pick(cell.iso)}
                  aria-current={isSelected ? "date" : undefined}
                  aria-label={`${longDate(cell.iso)} — ${
                    list.length === 0 ? "aucun événement" : `${list.length} événement${list.length > 1 ? "s" : ""}`
                  }`}
                  className={cn(
                    "focus-ring grid size-6 shrink-0 place-items-center self-start rounded-full text-[13px] font-bold tabular-nums transition-colors",
                    isToday
                      ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-10px_var(--accent)]"
                      : isSelected
                        ? "text-accent-ink hover:bg-accent-ring/40"
                        : cell.inMonth
                          ? "text-ink hover:bg-surface-2"
                          : "text-ink-muted",
                  )}
                >
                  {cell.day}
                </button>

                <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
                  {visible.map((event) => (
                    <EventPill
                      key={event.id}
                      event={event}
                      onOpen={cell.inMonth ? () => openEvent(event) : undefined}
                    />
                  ))}

                  {hidden > 0 ? (
                    <span className="px-1 text-[11px] font-bold text-ink-muted">+{hidden} autres</span>
                  ) : null}
                </div>
              </div>
            );
          })}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      <aside className="flex w-[440px] shrink-0 flex-col border-l border-line">
        <div className="shrink-0 border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <SectionLabel>Journée</SectionLabel>
            <span className="ml-auto text-[11.5px] font-semibold text-ink-muted">{dayLabel}</span>
            <DButton variant="soft" size="md" onClick={onNewEvent}>
              <Plus className="size-4" strokeWidth={2.6} />
              Ajouter
            </DButton>
          </div>
          <p className="mt-2 truncate text-[22px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
            {longDate(selectedDate)}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-[96px]">
          {detail ? (
            <div className="space-y-3">
              <DButton variant="ghost" size="sm" onClick={() => setDetailId(null)}>
                <ChevronLeft className="size-3.5" strokeWidth={2.4} />
                Retour à la journée
              </DButton>

              <div className="rounded-[26px] border border-line bg-surface p-5">
                <SectionLabel>{detail.calendar ?? "Agenda"}</SectionLabel>
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
                  {conflicts.has(detail.id) ? <Badge tone="amber">Conflit</Badge> : null}
                </div>

                <p className="mt-4 flex items-center gap-2 text-[13px] font-bold text-ink tabular-nums">
                  <Clock className="size-4 shrink-0" strokeWidth={2.2} />
                  {detail.start} → {detail.end}
                </p>

                {detail.location ? (
                  <p className="mt-2 flex items-center gap-2 text-[11.5px] font-semibold text-ink-muted">
                    <MapPin className="size-3.5 shrink-0" strokeWidth={2.2} />
                    {detail.location}
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
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {detail.attendees.map((person, index) => (
                        <span
                          key={person}
                          className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-0.5 pr-2.5 pl-0.5 text-[11.5px] font-semibold text-ink-soft"
                        >
                          <Avatar name={person} tone={index} size={22} rounded="rounded-full" />
                          {person}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {mail ? (
                  <DButton variant="soft" size="md" className="mt-4" onClick={() => openMessage(mail)}>
                    <Mail className="size-4" strokeWidth={2.2} />
                    Voir le mail
                  </DButton>
                ) : null}
              </div>
            </div>
          ) : dayEvents.length === 0 ? (
            <EmptyState
              icon={<CalendarDays className="size-5" strokeWidth={2.2} />}
              title="Journée libre"
              hint="Aucun rendez-vous ce jour-là. Ajoutez-en un d'un clic."
            />
          ) : (
            <div className="space-y-3">
              {dayEvents.map((event) => {
                const preview = descriptionOf(event);
                return (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => setDetailId(event.id)}
                    className="focus-ring block w-full rounded-[18px] border border-line bg-surface p-4 text-left transition-colors hover:border-accent-ring hover:bg-surface-2/40"
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[toneOf(event.tone)])} />
                      <span className="text-[13px] font-bold text-ink tabular-nums">
                        {event.start} → {event.end}
                      </span>
                      {event.fromMail || event.mailId ? (
                        <Badge tone="accent">
                          <Mail className="size-2.5" strokeWidth={2.6} />
                          mail
                        </Badge>
                      ) : null}
                      {conflicts.has(event.id) ? <Badge tone="amber">Conflit</Badge> : null}
                    </span>

                    <span className="mt-2 block text-[15px] leading-snug font-extrabold tracking-[-0.03em] text-ink">
                      {event.title}
                    </span>

                    {event.location ? (
                      <span className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-muted">
                        <MapPin className="size-3.5 shrink-0" strokeWidth={2.2} />
                        <span className="truncate">{event.location}</span>
                      </span>
                    ) : null}

                    {event.attendees?.length ? (
                      <span className="mt-2 flex items-center gap-2">
                        <span className="flex shrink-0 -space-x-1.5">
                          {event.attendees.map((person, index) => (
                            <Avatar
                              key={person}
                              name={person}
                              tone={index}
                              size={22}
                              rounded="rounded-full"
                              className="ring-2 ring-surface"
                            />
                          ))}
                        </span>
                        <span className="truncate text-[11.5px] font-semibold text-ink-muted">
                          {event.attendees.join(", ")}
                        </span>
                      </span>
                    ) : null}

                    {preview ? (
                      <span className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed font-medium text-ink-soft">
                        {preview}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function NewEventDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <NewEventForm onClose={onClose} />;
}

function NewEventForm({ onClose }: { onClose: () => void }) {
  const { events, selectedDate, setEvents, setSelectedDate, notify } = useMailStore();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(selectedDate);
  const [start, setStart] = useState("14:00");
  const [end, setEnd] = useState("15:00");
  const [people, setPeople] = useState("");
  const [description, setDescription] = useState("");

  useEscapeLayer(true, onClose);

  const invalid = !title.trim() || end <= start;
  const clashes = invalid || !date ? [] : overlappingEvents(events, date, start, end);

  const submit = () => {
    if (invalid) return;
    const attendees = people
      .split(",")
      .map((person) => person.trim())
      .filter(Boolean);
    const event: DesktopEvent = {
      id: `evt-${Date.now()}`,
      date,
      start,
      end,
      title: title.trim(),
      tone: 0,
      attendees: attendees.length > 0 ? attendees : undefined,
      description: description.trim() || undefined,
      calendar: "Pro",
    };
    setEvents((current) => [...current, event]);
    setSelectedDate(date);
    notify("Rendez-vous créé");
    onClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Fermer"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nouveau rendez-vous"
        className="relative w-full max-w-[560px] overflow-hidden rounded-[26px] border border-line bg-surface shadow-[0_40px_90px_-40px_var(--accent)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-4">
          <div>
            <SectionLabel>Agenda</SectionLabel>
            <h2 className="text-[19px] leading-tight font-extrabold tracking-[-0.035em] text-ink">
              Nouveau rendez-vous
            </h2>
          </div>
          <DIconButton label="Fermer" className="ml-auto" onClick={onClose}>
            <X className="size-4" strokeWidth={2.2} />
          </DIconButton>
        </div>

        <div className="max-h-[62vh] space-y-3.5 overflow-y-auto px-5 py-4">
          <Field label="Titre">
            <TextInput
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Revue de design, déjeuner, visio…"
            />
          </Field>

          <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2.5">
            <Field label="Date">
              <TextInput type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </Field>
            <Field label="Début">
              <TextInput
                type="time"
                value={start}
                onChange={(event) => {
                  setStart(event.target.value);
                  setEnd(addMinutes(event.target.value, 60));
                }}
              />
            </Field>
            <Field label="Fin">
              <TextInput type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
            </Field>
          </div>

          <Field label="Participants">
            <TextInput
              value={people}
              onChange={(event) => setPeople(event.target.value)}
              placeholder="Invités (noms ou e-mails)"
            />
          </Field>

          <Field label="Description">
            <TextArea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Ordre du jour, lieu, lien visio…"
            />
          </Field>

          {clashes.length > 0 ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[16px] border border-amber-500/40 bg-amber-500/12 px-3 py-2 text-[11.5px] font-semibold text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.2} />
              <p>
                Chevauchement sur ce créneau : {clashes.map((event) => event.title).join(", ")}.
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
          <p className="text-[11px] font-bold text-ink-muted tabular-nums">
            {start} → {end}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <DButton variant="ghost" size="sm" onClick={onClose}>
              Annuler
            </DButton>
            <DButton variant="primary" size="md" disabled={invalid} onClick={submit}>
              Créer le rendez-vous
            </DButton>
          </div>
        </div>
      </div>
    </div>
  );
}
