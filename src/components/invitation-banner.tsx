/**
 * Bannière d'invitation agenda (iTIP) : un message qui porte une pièce
 * `text/calendar` affiche l'événement et les trois réponses possibles. La
 * réponse part par le calendrier CalDAV du compte (le serveur relaie à
 * l'organisateur) ou, faute d'agenda, par un `METHOD:REPLY` que le démon envoie.
 * Un événement annulé se lit sans bouton : rien n'est jamais supprimé tout seul.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Check, CircleHelp, Reply, X } from "lucide-react";
import { errorText, mailApi, type Invitation, type RsvpStatus } from "@/lib/api";
import type { MailAttachment } from "@/lib/mail";
import { cn } from "@/lib/utils";

const DAY = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const STATUS_LABEL: Record<string, string> = {
  "NEEDS-ACTION": "sans réponse",
  ACCEPTED: "accepté",
  TENTATIVE: "provisoire",
  DECLINED: "refusé",
  DELEGATED: "délégué",
};

const ANSWERS: { status: RsvpStatus; label: string; icon: typeof Check }[] = [
  { status: "ACCEPTED", label: "Accepter", icon: Check },
  { status: "TENTATIVE", label: "Provisoire", icon: CircleHelp },
  { status: "DECLINED", label: "Refuser", icon: X },
];

/** La pièce du message qui porte l'invitation, `undefined` quand il n'y en a pas. */
export function calendarAttachment(attachments: MailAttachment[] = []): MailAttachment | undefined {
  return attachments.find((file) => {
    const mime = (file.mime ?? "").split(";")[0]?.trim().toLowerCase();
    return mime === "text/calendar" || mime === "application/ics";
  });
}

function dayLabel(invitation: Invitation): string {
  if (!invitation.date) return "";
  const parsed = new Date(`${invitation.date}T12:00:00`);
  const day = Number.isNaN(parsed.getTime()) ? invitation.date : DAY.format(parsed);
  if (invitation.all_day) return `${day} · journée entière`;
  if (!invitation.start) return day;
  const end = invitation.end ? ` – ${invitation.end}` : "";
  return `${day} · ${invitation.start}${end}`;
}

export function InvitationBanner({
  accountId,
  folderPath,
  uid,
  attachments,
  selfEmail,
  variant = "desktop",
  readOnly = false,
}: {
  accountId: string;
  folderPath: string;
  uid: number;
  attachments?: MailAttachment[];
  /** Adresse du compte : elle désigne l'invité dont le statut est affiché. */
  selfEmail?: string;
  variant?: "desktop" | "mobile";
  readOnly?: boolean;
}) {
  const present = Boolean(calendarAttachment(attachments));
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [answering, setAnswering] = useState<RsvpStatus | null>(null);

  useEffect(() => {
    if (!present) {
      setInvitation(null);
      return;
    }
    let live = true;
    setLoading(true);
    setFailure(null);
    mailApi
      .invitation(accountId, folderPath, uid)
      .then((loaded) => {
        if (live) setInvitation(loaded);
      })
      .catch((error: unknown) => {
        if (live) setFailure(`Invitation illisible · ${errorText(error)}`);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [accountId, folderPath, uid, present]);

  if (!present) return null;

  const mine = selfEmail
    ? invitation?.attendees.find((guest) => guest.email.toLowerCase() === selfEmail.toLowerCase())
    : undefined;
  const cancelled = invitation?.method === "CANCEL";
  // Seule une `REQUEST` se répond : une annulation ou la réponse d'un invité se lit.
  const answerable = invitation?.method === "REQUEST";
  const pad = variant === "mobile" ? "mt-3 rounded-2xl px-3.5 py-3" : "mt-4 rounded-[18px] px-4 py-3";
  const title = "text-[12.5px] leading-snug font-bold";
  const muted = "text-[11.5px] leading-snug font-medium text-ink-soft";

  const answer = async (status: RsvpStatus) => {
    if (answering || readOnly) return;
    setAnswering(status);
    setFailure(null);
    setNotice(null);
    try {
      const outcome = await mailApi.rsvp(accountId, folderPath, uid, status);
      setInvitation(outcome.invitation);
      const label = STATUS_LABEL[status] ?? status.toLowerCase();
      setNotice(
        outcome.via === "caldav"
          ? `Réponse « ${label} » envoyée à l'organisateur depuis ton agenda.`
          : `Réponse « ${label} » envoyée à l'organisateur par mail (aucun agenda CalDAV lié à ce compte).`,
      );
    } catch (error) {
      setFailure(`Réponse impossible · ${errorText(error)}`);
    } finally {
      setAnswering(null);
    }
  };

  return (
    <div
      role={cancelled ? "status" : undefined}
      data-testid="invitation-banner"
      className={cn(
        pad,
        "flex items-start gap-2.5 border",
        cancelled
          ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
          : "border-accent-ring/50 bg-accent-soft/40",
      )}
    >
      {cancelled ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
      ) : (
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-accent-ink" strokeWidth={2.4} />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn(title, cancelled ? "" : "text-ink")}>
          {cancelled
            ? "Événement annulé par l'organisateur"
            : loading
              ? "Invitation en cours de lecture…"
              : (invitation?.summary ?? "Invitation agenda")}
        </p>
        {invitation ? (
          <p className="mt-0.5 text-[11.5px] leading-snug font-medium text-ink-soft">
            {dayLabel(invitation)}
            {invitation.organizer ? ` · organisé par ${invitation.organizer.name || invitation.organizer.email}` : ""}
          </p>
        ) : null}
        {mine ? (
          <p className={cn(muted, "mt-0.5 inline-flex items-center gap-1")}>
            <Reply className="size-3" strokeWidth={2.4} />
            Ta réponse : {STATUS_LABEL[mine.partstat] ?? mine.partstat.toLowerCase()}
          </p>
        ) : null}
        {cancelled ? (
          <p className={cn(muted, "mt-1")}>
            Aucun événement n'a été supprimé de ton agenda : retire-le si tu le souhaites.
          </p>
        ) : null}

        {answerable && !readOnly ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {ANSWERS.map(({ status, label, icon: Icon }) => (
              <button
                key={status}
                type="button"
                disabled={answering !== null}
                aria-busy={answering === status}
                onClick={() => void answer(status)}
                className={cn(
                  "focus-ring inline-flex h-7 items-center gap-1 rounded-full border border-accent-ring/50 bg-surface px-2.5 text-[11px] font-bold text-ink transition-colors hover:border-accent-ring disabled:opacity-60",
                  mine?.partstat === status && "border-accent-ring bg-surface-2",
                )}
              >
                <Icon className="size-3.5" strokeWidth={2.4} />
                {answering === status ? "Envoi…" : label}
              </button>
            ))}
          </div>
        ) : null}

        {notice ? (
          <p role="status" aria-live="polite" className={cn(muted, "mt-2")}>
            {notice}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className={cn(muted, "mt-2 text-red-700 dark:text-red-300")}>
            {failure}
          </p>
        ) : null}
      </div>
    </div>
  );
}
