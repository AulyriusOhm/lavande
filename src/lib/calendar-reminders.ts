import { useEffect, useRef } from "react";
import type { CalendarEvent } from "@/lib/calendar";
import type { NotificationPrefs } from "@/lib/prefs";
import { usePrefs } from "@/lib/prefs";
import { notifyCalendarEvent } from "@/lib/notify";

const STORAGE_KEY = "lavande.reminders";
const TICK_MS = 60_000;
const KEEP_MS = 3_600_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;

/** Un rappel par occurrence : le même rendez-vous peut revenir une autre date. */
export function reminderKey(event: CalendarEvent): string {
  return `${event.id}@${event.date}#${event.start}`;
}

export function eventStartAt(event: CalendarEvent): number | null {
  if (!ISO_DAY.test(event.date) || !HH_MM.test(event.start)) return null;
  const at = new Date(`${event.date}T${event.start}:00`).getTime();
  return Number.isNaN(at) ? null : at;
}

export function dueReminders(
  events: CalendarEvent[],
  notifications: NotificationPrefs,
  sent: Record<string, number>,
  now = Date.now(),
): CalendarEvent[] {
  if (!notifications.enabled || !notifications.calendar) return [];
  const lead = notifications.calendarMinutes * 60_000;
  return events.filter((event) => {
    if (sent[reminderKey(event)] !== undefined) return false;
    const start = eventStartAt(event);
    return start !== null && now >= start - lead && now < start;
  });
}

export function pruneReminders(sent: Record<string, number>, now = Date.now()): Record<string, number> {
  return Object.fromEntries(Object.entries(sent).filter(([, start]) => start >= now - KEEP_MS));
}

function readSent(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, start] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof start === "number" && Number.isFinite(start)) out[key] = start;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSent(sent: Record<string, number>): void {
  try {
    if (Object.keys(sent).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(sent));
  } catch {
    // stockage plein ou refusé : le rappel repart au prochain démarrage
  }
}

export function reminderBody(event: CalendarEvent): string {
  const time = HH_MM.test(event.start) ? event.start : "";
  return [time ? `À ${time}` : "", event.location ?? ""].filter(Boolean).join(" · ");
}

/** Vérifie les rendez-vous à venir tant que l'app tourne, un rappel par occurrence. */
export function useCalendarReminders(events: CalendarEvent[]): void {
  const { notifications } = usePrefs();
  const latest = useRef({ events, notifications });
  latest.current = { events, notifications };

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const sent = pruneReminders(readSent(), now);
      const due = dueReminders(latest.current.events, latest.current.notifications, sent, now);
      if (due.length === 0) return;
      for (const event of due) {
        sent[reminderKey(event)] = eventStartAt(event) ?? now;
        notifyCalendarEvent(event.title, reminderBody(event));
      }
      writeSent(sent);
    };
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
