/**
 * Disponibilités des invités d'un rendez-vous, demandées au serveur Zimbra du
 * compte à mot de passe. Replié par défaut : rien ne part tant que le bloc n'est
 * pas ouvert, et un serveur muet laisse juste sa raison dans le bloc.
 */

import { useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import { Badge } from "@/desktop/ui";
import { errorText, mailApi, type ZimbraFreeBusySlot, type ZimbraFreeBusyUser } from "@/lib/api";
import { demoReadOnly, mailMode } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

const STATUS = {
  busy: { label: "occupé", tone: "rose" },
  tentative: { label: "provisoire", tone: "amber" },
  out: { label: "absence", tone: "sky" },
  free: { label: "libre", tone: "green" },
  unknown: { label: "sans données", tone: "neutral" },
} as const;

export type GuestStatus = keyof typeof STATUS;

const WEIGHT: Record<GuestStatus, number> = {
  busy: 4,
  tentative: 3,
  out: 2,
  unknown: 1,
  free: 0,
};

/** Le pire créneau d'un invité sur la plage : occupé l'emporte sur provisoire. */
export function guestStatus(slots: ZimbraFreeBusySlot[], from: number, to: number): GuestStatus {
  let worst: GuestStatus = "free";
  for (const slot of slots) {
    if (slot.end <= from || slot.start >= to) continue;
    const status = (slot.status in WEIGHT ? slot.status : "unknown") as GuestStatus;
    if (WEIGHT[status] > WEIGHT[worst]) worst = status;
  }
  return worst;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Bornes du rendez-vous en millisecondes ; `null` quand elles n'ont pas de sens. */
export function eventBounds(
  date: string,
  start?: string,
  end?: string,
): { from: number; to: number } | null {
  const day = date.trim();
  if (!day) return null;
  const at = (time: string | undefined, fallback: string) => {
    const value = (time ?? "").trim().slice(0, 5) || fallback;
    const stamp = new Date(`${day}T${value}:00`).getTime();
    return Number.isFinite(stamp) ? stamp : null;
  };
  const from = at(start, "00:00");
  const to = at(end, "23:59");
  if (from === null || to === null) return null;
  return { from, to: to > from ? to : from + 60 * 60 * 1000 };
}

export function GuestFreeBusy({
  accountId,
  attendees,
  date,
  start,
  end,
  readOnly = demoReadOnly || mailMode() !== "api",
}: {
  /** Compte Zimbra interrogé ; rien n'est demandé sans lui. */
  accountId?: string | null;
  attendees: string[];
  date: string;
  start?: string;
  end?: string;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guests, setGuests] = useState<ZimbraFreeBusyUser[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const bounds = eventBounds(date, start, end);
  if (readOnly || !accountId || attendees.length === 0 || bounds === null) return null;

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (guests !== null) return;
    setBusy(true);
    setFailed(null);
    try {
      const answer = await mailApi.zimbraFreeBusy(accountId, {
        emails: attendees,
        from: bounds.from,
        to: bounds.to,
      });
      setGuests(Array.isArray(answer) ? answer : []);
    } catch (error) {
      setFailed(`Disponibilités illisibles · ${errorText(error)}`);
      setGuests([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2" data-testid="guest-free-busy">
      <button
        type="button"
        aria-label="Disponibilités des invités"
        aria-expanded={open}
        onClick={() => void toggle()}
        className="focus-ring flex items-center gap-1.5 text-[10.5px] font-bold tracking-[0.12em] text-ink-muted uppercase transition-colors hover:text-ink"
      >
        <Users className="size-3.5" strokeWidth={2.4} />
        Disponibilités des invités
        <ChevronDown
          className={cn("size-3.5 transition-transform duration-200", !open && "-rotate-90")}
          strokeWidth={2.4}
        />
      </button>

      {open ? (
        <div className="mt-1.5 grid gap-1">
          {busy && guests === null ? (
            <p className="text-[11px] font-semibold text-ink-muted">Lecture des agendas…</p>
          ) : null}
          {(guests ?? []).map((guest) => {
            const status = guestStatus(guest.slots, bounds.from, bounds.to);
            return (
              <div key={guest.email} className="flex items-center gap-2">
                <span className="truncate text-[11.5px] font-semibold text-ink-soft">{guest.email}</span>
                <Badge tone={STATUS[status].tone} className="ml-auto">
                  {STATUS[status].label}
                </Badge>
                {guest.slots.length > 0 ? (
                  <span
                    className="shrink-0 text-[10px] font-medium text-ink-muted tabular-nums"
                    title={guest.slots
                      .map((slot) => `${clock(slot.start)}–${clock(slot.end)} ${STATUS[guestStatus([slot], bounds.from, bounds.to)].label}`)
                      .join(" · ")}
                  >
                    {guest.slots.length} créneau{guest.slots.length > 1 ? "x" : ""}
                  </span>
                ) : null}
              </div>
            );
          })}
          {guests !== null && guests.length === 0 && !failed ? (
            <p className="text-[11px] font-semibold text-ink-muted">
              Le serveur ne connaît aucun de ces invités.
            </p>
          ) : null}
          {failed ? (
            <p role="status" aria-live="polite" className="text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              {failed}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
