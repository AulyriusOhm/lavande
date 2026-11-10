import { useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Mail, MapPin, Plus, Users } from "lucide-react";
import type { CalendarEvent } from "@/lib/calendar";
import { CURRENT_MONTH, CURRENT_YEAR, MONTH_LABEL, TODAY_DATE, WEEKDAYS, monthGrid } from "@/lib/calendar";
import { TONES } from "@/lib/mail";
import { cn } from "@/lib/utils";
import { BlurFade } from "@/components/ui/blur-fade";
import { MeshGlow } from "@/components/ui/backdrops";
import { ShimmerButton } from "@/components/ui/shimmer-button";

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

export function CalendarScreen({ events: allEvents }: { events: CalendarEvent[] }) {
  const [selected, setSelected] = useState(TODAY_DATE);
  const cells = monthGrid();
  const withEvents = new Set(allEvents.map((event) => event.day));
  const events = allEvents
    .filter((event) => event.day === selected)
    .sort((a, b) => a.start.localeCompare(b.start));
  const label = DATE_FMT
    .format(new Date(CURRENT_YEAR, CURRENT_MONTH, selected))
    .replace(/[\u202f\u00a0]/g, " ");

  return (
    <div className="relative h-full overflow-y-auto no-scrollbar pb-32">
      <MeshGlow className="h-56" />

      <header className="relative px-5 pt-4">
        <p className="text-[10.5px] font-bold tracking-[0.18em] text-ink-muted uppercase">Lavande · Calendrier</p>
        <div className="mt-1.5 flex items-center justify-between">
          <h1 className="text-[27px] leading-none font-extrabold tracking-[-0.035em] text-ink capitalize">
            {MONTH_LABEL}
          </h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Mois précédent"
              className="grid size-8 place-items-center rounded-full border border-line bg-surface text-ink-soft"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Mois suivant"
              className="grid size-8 place-items-center rounded-full border border-line bg-surface text-ink-soft"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-7 gap-1 rounded-[26px] border border-line bg-surface p-3">
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
            const isToday = day === TODAY_DATE;
            const isSelected = day === selected;
            return (
              <button
                key={day}
                type="button"
                onClick={() => setSelected(day)}
                className={cn(
                  "relative grid aspect-square place-items-center rounded-xl text-[12.5px] font-semibold transition-colors",
                  isSelected
                    ? "bg-accent text-white shadow-[0_6px_18px_-8px_var(--accent)]"
                    : isToday
                      ? "bg-accent-soft text-accent-ink"
                      : "text-ink-soft hover:bg-surface-2",
                )}
              >
                {day}
                {withEvents.has(day) && (
                  <span
                    className={cn(
                      "absolute bottom-1 size-1 rounded-full",
                      isSelected ? "bg-white/80" : "bg-accent",
                    )}
                  />
                )}
              </button>
            );
          })}
        </div>
      </header>

      <div className="mt-6 flex items-baseline justify-between px-5">
        <h2 className="text-[13px] font-bold text-ink capitalize">{label}</h2>
        <span className="text-[11px] font-medium text-ink-muted">
          {events.length} événement{events.length > 1 ? "s" : ""}
        </span>
      </div>

      <div className="mt-3 space-y-2 px-4">
        {events.map((event, index) => (
          <BlurFade key={event.id} delay={0.05 * index} yOffset={10}>
            <div className="flex gap-3">
              <div className="w-11 shrink-0 pt-1 text-right">
                <p className="text-[11.5px] font-bold text-ink">{event.start}</p>
                <p className="text-[10px] font-medium text-ink-muted">{event.end}</p>
              </div>
              <div
                className={cn(
                  "min-w-0 flex-1 rounded-2xl border border-line bg-surface p-3",
                  "border-l-[3px]",
                )}
                style={{ borderLeftColor: `var(--accent)` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[13px] leading-tight font-bold text-ink">{event.title}</p>
                  {event.fromMail && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                      <Mail className="size-2.5" />
                      mail
                    </span>
                  )}
                </div>
                {event.location && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                    <MapPin className="size-3" />
                    {event.location}
                  </p>
                )}
                {event.attendees?.length ? (
                  <div className="mt-2 flex items-center gap-1.5">
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
          </BlurFade>
        ))}

        {events.length === 0 && (
          <p className="px-5 py-10 text-center text-[12.5px] font-medium text-ink-muted">
            Journée libre — rien de prévu.
          </p>
        )}
      </div>

      <div className="mt-5 px-5">
        <ShimmerButton size="md" className="w-full" shimmerDuration={5}>
          <Plus className="size-4" />
          Créer un événement
        </ShimmerButton>
        <p className="mt-2 flex items-center justify-center gap-1 text-[10.5px] font-medium text-ink-muted">
          <Clock className="size-3" />
          Fusion CalDAV · 3 comptes synchronisés
        </p>
      </div>
    </div>
  );
}
