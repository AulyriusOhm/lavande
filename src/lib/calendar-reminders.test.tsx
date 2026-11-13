import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import type { CalendarEvent } from "@/lib/calendar";
import {
  dueReminders,
  eventStartAt,
  pruneReminders,
  reminderKey,
  useCalendarReminders,
} from "@/lib/calendar-reminders";
import { PrefsProvider } from "@/lib/prefs";
import { DEFAULT_NOTIFICATIONS, type NotificationPrefs } from "@/lib/prefs";

const { notifyCalendarEvent } = vi.hoisted(() => ({ notifyCalendarEvent: vi.fn() }));

vi.mock("@/lib/notify", () => ({ notifyCalendarEvent }));

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  date: "2026-03-04",
  start: "09:30",
  end: "10:00",
  title: "Point équipe",
  ...over,
});

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATIONS,
  ...over,
});

const at = (iso: string) => new Date(iso).getTime();

beforeEach(() => {
  window.localStorage.clear();
  notifyCalendarEvent.mockClear();
});

describe("rappels d'agenda · fenêtre", () => {
  it("rappelle dans la fenêtre du délai, pas avant ni après le début", () => {
    const soon = event();
    const notifications = prefs({ calendarMinutes: 10 });

    expect(dueReminders([soon], notifications, {}, at("2026-03-04T09:19:00"))).toEqual([]);
    expect(dueReminders([soon], notifications, {}, at("2026-03-04T09:20:00"))).toEqual([soon]);
    expect(dueReminders([soon], notifications, {}, at("2026-03-04T09:29:00"))).toEqual([soon]);
    expect(dueReminders([soon], notifications, {}, at("2026-03-04T09:30:00"))).toEqual([]);
  });

  it("suit le délai réglé", () => {
    const soon = event();
    expect(dueReminders([soon], prefs({ calendarMinutes: 0 }), {}, at("2026-03-04T09:20:00"))).toEqual([]);
    expect(
      dueReminders([soon], prefs({ calendarMinutes: 30 }), {}, at("2026-03-04T09:20:00")),
    ).toEqual([soon]);
  });

  it("ne rappelle qu'une fois par occurrence", () => {
    const soon = event();
    const sent = { [reminderKey(soon)]: eventStartAt(soon) ?? 0 };
    expect(dueReminders([soon], prefs(), sent, at("2026-03-04T09:25:00"))).toEqual([]);
  });

  it("se tait quand le maître ou le calendrier est coupé", () => {
    const soon = event();
    expect(dueReminders([soon], prefs({ enabled: false }), {}, at("2026-03-04T09:25:00"))).toEqual([]);
    expect(dueReminders([soon], prefs({ calendar: false }), {}, at("2026-03-04T09:25:00"))).toEqual([]);
  });

  it("ignore un rendez-vous sans date ou heure exploitable", () => {
    expect(eventStartAt(event({ date: "demain" }))).toBeNull();
    expect(eventStartAt(event({ start: "" }))).toBeNull();
    expect(eventStartAt(event())).toBe(at("2026-03-04T09:30:00"));
    expect(dueReminders([event({ date: "" })], prefs(), {}, Date.now())).toEqual([]);
  });

  it("élague les rappels dont le rendez-vous est passé", () => {
    const now = at("2026-03-04T12:00:00");
    const sent = { vieux: at("2026-03-04T09:30:00"), frais: at("2026-03-04T11:30:00") };
    expect(pruneReminders(sent, now)).toEqual({ frais: at("2026-03-04T11:30:00") });
  });
});

describe("rappels d'agenda · application", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <PrefsProvider>{children}</PrefsProvider>;

  it("notifie une fois et retient le rappel envoyé", async () => {
    const start = new Date(Date.now() + 5 * 60_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const time = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    const soon = event({ id: "live", date, start: time, location: "Visio" });

    const { unmount } = renderHook(() => useCalendarReminders([soon]), { wrapper });

    await waitFor(() => expect(notifyCalendarEvent).toHaveBeenCalledTimes(1));
    expect(notifyCalendarEvent).toHaveBeenCalledWith("Point équipe", `À ${time} · Visio`);
    expect(JSON.parse(window.localStorage.getItem("lavande.reminders") ?? "{}")).toHaveProperty(
      reminderKey(soon),
    );

    unmount();
    renderHook(() => useCalendarReminders([soon]), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifyCalendarEvent).toHaveBeenCalledTimes(1);
  });
});
