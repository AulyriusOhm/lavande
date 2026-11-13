import { Clock, EyeOff, Mail, MapPin, Plus } from "lucide-react";
import { clampIsoDay, isoTime } from "@/lib/calendar";
import type { Mail as MailType } from "@/lib/mail";
import { formatDueDate, type MailSuggestion } from "@/lib/tasks";
import { DButton, DIconButton } from "@/desktop/ui";

export function EventSuggestionCard({
  suggestion,
  account,
  mail,
  onAccept,
  onOpenMail,
  onDismiss,
}: {
  suggestion: MailSuggestion;
  account: string;
  mail: MailType | undefined;
  onAccept: () => void;
  onOpenMail: (mail: MailType) => void;
  onDismiss: () => void;
}) {
  const day = clampIsoDay(suggestion.date);
  const hours = [isoTime(suggestion.start), isoTime(suggestion.end)].filter(Boolean).join(" → ");
  const when = [day ? formatDueDate(day) : suggestion.due, hours].filter(Boolean).join(" · ");

  return (
    <div
      data-testid="event-suggestion-card"
      className="rounded-[18px] border border-dashed border-accent-ring/70 bg-accent-soft/40 p-2.5"
    >
      <div className="flex items-center gap-1.5">
        <span
          data-testid="event-suggestion-account"
          className="inline-flex h-[20px] shrink-0 items-center rounded-full bg-surface px-1.5 text-[10.5px] font-extrabold whitespace-nowrap text-accent-ink"
        >
          {account}
        </span>
        <span className="truncate text-[11px] font-bold text-ink">{suggestion.from}</span>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-tight font-bold text-ink">{suggestion.proposal}</p>

      {when ? (
        <p
          data-testid="event-suggestion-when"
          className="mt-1 flex items-center gap-1.5 text-[11px] font-bold text-ink-muted tabular-nums"
        >
          <Clock className="size-3 shrink-0" strokeWidth={2.4} />
          <span className="truncate">{when}</span>
        </p>
      ) : null}

      {suggestion.location ? (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
          <MapPin className="size-3 shrink-0" strokeWidth={2.4} />
          <span className="truncate">{suggestion.location}</span>
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-1">
        <DButton
          size="sm"
          variant="soft"
          className="max-sm:min-h-11"
          aria-label={`Accepter : ${suggestion.proposal}`}
          onClick={onAccept}
        >
          <Plus className="size-3.5" strokeWidth={3} />
          Accepter
        </DButton>
        {mail ? (
          <DIconButton
            label="Ouvrir le mail"
            className="size-8 max-sm:min-h-11 max-sm:min-w-11"
            onClick={() => onOpenMail(mail)}
          >
            <Mail className="size-3.5" strokeWidth={2.2} />
          </DIconButton>
        ) : null}
        <DIconButton
          label="Ignorer la suggestion"
          className="ml-auto size-8 max-sm:min-h-11 max-sm:min-w-11"
          onClick={onDismiss}
        >
          <EyeOff className="size-3.5" strokeWidth={2.2} />
        </DIconButton>
      </div>
    </div>
  );
}
