import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import type { CalendarEvent } from "@/lib/calendar";
import { CURRENT_MONTH, CURRENT_YEAR, TODAY_DATE } from "@/lib/calendar";
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

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });

function addMinutes(time: string, minutes: number) {
  const [hours, mins] = time.split(":").map((part) => Number.parseInt(part, 10));
  const total = (hours * 60 + mins + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function NewEventSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (event: CalendarEvent) => void;
}) {
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(DAYS[0]);
  const [start, setStart] = useState("10:00");
  const [duration, setDuration] = useState(DURATIONS[1]);
  const [location, setLocation] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      id: "e-" + Date.now(),
      day: TODAY_DATE + day.offset,
      start,
      end: addMinutes(start, duration.minutes),
      title: title.trim(),
      location: location.trim() || undefined,
      tone: 0,
    });
    onClose();
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line" />
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">Nouveau rendez-vous</h2>
        <button type="button" onClick={onClose} className="ml-auto text-[11.5px] font-bold text-accent-ink">
          Annuler
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Titre du rendez-vous"
          autoFocus
          className="w-full rounded-2xl border border-line bg-surface px-3.5 py-3 text-[14px] font-bold tracking-tight text-ink outline-none placeholder:font-semibold placeholder:text-ink-muted/70 focus:border-accent-ring"
        />

        <input
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="Lieu ou lien visio"
          className="mt-2 w-full rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[12.5px] font-medium text-ink outline-none placeholder:text-ink-muted/70 focus:border-accent-ring"
        />

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Jour</p>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((entry) => {
            const active = entry.label === day.label;
            return (
              <button
                key={entry.label}
                type="button"
                onClick={() => setDay(entry)}
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
        <p className="mt-1.5 text-[10.5px] font-semibold text-ink-muted">
          {DATE_FMT.format(new Date(CURRENT_YEAR, CURRENT_MONTH, TODAY_DATE + day.offset))}
        </p>

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Heure</p>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className="rounded-2xl border border-line bg-surface px-3 py-2.5 text-[13px] font-bold text-ink outline-none focus:border-accent-ring"
          />
          <span className="text-[11.5px] font-semibold text-ink-muted">
            → {addMinutes(start, duration.minutes)}
          </span>
        </div>

        <p className="mt-4 mb-2 text-[10px] font-bold tracking-[0.14em] text-ink-muted uppercase">Durée</p>
        <div className="flex flex-wrap gap-1.5 pb-4">
          {DURATIONS.map((entry) => {
            const active = entry.label === duration.label;
            return (
              <button
                key={entry.label}
                type="button"
                onClick={() => setDuration(entry)}
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
      </div>

      <div className="border-t border-line/80 px-4 py-3 glass safe-bottom sm:pb-5">
        <ShimmerButton className="w-full" onClick={submit} disabled={!title.trim()}>
          <CalendarPlus className="size-4" strokeWidth={2.4} />
          Créer le rendez-vous
        </ShimmerButton>
      </div>
    </div>
  );
}
