import { Mail, MapPin } from "lucide-react";
import { clampIsoDay, isoTime } from "@/lib/calendar";
import type { Mail as MailType } from "@/lib/mail";
import type { MailSuggestion } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const SLOT_DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric" });

export function EventSuggestionRow({
  suggestion,
  account,
  mail,
  last,
  onAccept,
  onOpenMail,
  onDismiss,
}: {
  suggestion: MailSuggestion;
  account: string;
  mail: MailType | undefined;
  last?: boolean;
  onAccept: () => void;
  onOpenMail: (mail: MailType) => void;
  onDismiss: () => void;
}) {
  const day = clampIsoDay(suggestion.date);
  const start = isoTime(suggestion.start);
  const shortDay = day
    ? SLOT_DAY.format(new Date(`${day}T12:00:00`)).replace(/[\u202f\u00a0]/g, " ")
    : undefined;

  return (
    <div
      data-testid="event-suggestion-card"
      className={cn("flex min-h-11 items-center gap-3 py-2.5", !last && "border-b border-line")}
    >
      <span data-testid="event-suggestion-when" className="w-10 shrink-0 text-right">
        {start ? (
          <span className="block text-[12px] leading-tight font-bold text-ink tabular-nums">{start}</span>
        ) : (
          <span className="block text-[10px] leading-tight font-semibold text-ink-muted">jour</span>
        )}
        {shortDay && (
          <span className="block text-[10px] leading-tight font-medium text-ink-soft tabular-nums">
            {shortDay}
          </span>
        )}
      </span>

      <span className="block min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-ink">{suggestion.proposal}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-ink-muted">
          <span className="min-w-0 truncate">
            {suggestion.from}
            {" · "}
            <span data-testid="event-suggestion-account">{account}</span>
            {suggestion.location ? ` · ${suggestion.location}` : ""}
          </span>
          {suggestion.location && (
            <MapPin className="size-3 shrink-0" strokeWidth={2.4} aria-hidden="true" />
          )}
          {mail && (
            <button
              type="button"
              aria-label="Ouvrir le mail"
              onClick={() => onOpenMail(mail)}
              className="-my-2 shrink-0 py-2 pl-0.5 text-ink-muted transition-colors active:text-ink"
            >
              <Mail className="size-3" strokeWidth={2.4} />
            </button>
          )}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={`Accepter : ${suggestion.proposal}`}
          onClick={onAccept}
          className="min-h-11 rounded-full bg-accent px-2.5 text-[11px] font-bold text-accent-contrast transition-colors active:scale-95"
        >
          Accepter
        </button>
        <button
          type="button"
          aria-label="Ignorer la suggestion"
          onClick={onDismiss}
          className="min-h-11 rounded-full border border-line bg-surface px-2.5 text-[11px] font-bold text-ink-soft transition-colors active:scale-95"
        >
          Ignorer
        </button>
      </span>
    </div>
  );
}
