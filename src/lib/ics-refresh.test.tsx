import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ExternalEvent } from "@/lib/api";
import type { CalendarDef } from "@/lib/calendars";

const { importIcs } = vi.hoisted(() => ({
  importIcs: vi.fn(async (_input: { url: string; source: string }): Promise<ExternalEvent[]> => []),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, mailApi: { ...actual.mailApi, importIcs } };
});

import { ICS_STORAGE_KEY, loadIcsState, useExternalCalendarRefresh } from "@/lib/ics";

const SOURCE: CalendarDef = {
  id: "exemple-tld",
  name: "exemple.tld",
  tone: 1,
  source: { kind: "ics", url: "https://exemple.tld/cal.ics" },
};

const OTHER: CalendarDef = {
  id: "autre-tld",
  name: "autre.tld",
  tone: 2,
  source: { kind: "ics", url: "https://autre.tld/cal.ics" },
};

const payload = (uid: string, title: string): ExternalEvent => ({
  uid,
  title,
  date: "2026-03-15",
  start: "09:00",
  end: "10:00",
  all_day: false,
  timezone: "UTC",
  location: null,
  description: null,
  recurring: false,
  source: "exemple.tld",
});

const seedSynced = (synced: Record<string, number>) => {
  window.localStorage.setItem(ICS_STORAGE_KEY, JSON.stringify({ events: {}, synced }));
};

const mount = (calendars: CalendarDef[], notify = vi.fn()) =>
  renderHook(() => useExternalCalendarRefresh(calendars, notify));

beforeEach(() => {
  window.localStorage.clear();
  importIcs.mockReset();
  importIcs.mockImplementation(async () => []);
});

describe("useExternalCalendarRefresh · relecture des sources dues", () => {
  it("relit une source due une seule fois et range son cache", async () => {
    seedSynced({});
    importIcs.mockImplementation(async () => [payload("abc", "Réunion externe")]);

    const { result } = mount([SOURCE]);

    await waitFor(() => expect(importIcs).toHaveBeenCalledTimes(1));
    expect(importIcs.mock.calls[0][0]).toEqual({ url: "https://exemple.tld/cal.ics", source: "exemple.tld" });
    await waitFor(() =>
      expect(loadIcsState().events["exemple-tld"]?.map((event) => event.title)).toEqual(["Réunion externe"]),
    );
    expect(loadIcsState().synced["exemple-tld"]).toBeGreaterThan(0);
    await waitFor(() => expect(result.current.ics.events["exemple-tld"]).toHaveLength(1));
    expect(result.current.syncing).toBe(false);
  });

  it("dédoublonne une relecture déjà en vol", async () => {
    seedSynced({});
    let release: (events: ExternalEvent[]) => void = () => {};
    importIcs.mockImplementation(
      () =>
        new Promise<ExternalEvent[]>((resolve) => {
          release = resolve;
        }),
    );

    const { result } = mount([SOURCE]);
    await waitFor(() => expect(importIcs).toHaveBeenCalledTimes(1));

    await act(async () => {
      void result.current.refresh([SOURCE]);
      void result.current.refresh([SOURCE]);
      await Promise.resolve();
    });
    expect(importIcs).toHaveBeenCalledTimes(1);
    expect(result.current.syncing).toBe(true);

    await act(async () => {
      release([payload("abc", "Réunion externe")]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.syncing).toBe(false));
    expect(importIcs).toHaveBeenCalledTimes(1);
    expect(result.current.ics.events["exemple-tld"]).toHaveLength(1);
  });

  it("marque une source en échec comme relue et ne notifie qu'une fois", async () => {
    seedSynced({});
    importIcs.mockImplementation(async () => {
      throw new Error("calendrier vide");
    });
    const notify = vi.fn();

    mount([SOURCE, OTHER], notify);

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      "Calendrier externe · exemple.tld · calendrier vide ; autre.tld · calendrier vide",
    );
    const { synced } = loadIcsState();
    expect(synced["exemple-tld"]).toBeGreaterThan(0);
    expect(synced["autre-tld"]).toBeGreaterThan(0);

    await act(async () => {
      await Promise.resolve();
    });
    expect(importIcs).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("ne relit rien quand aucune source n'est due", async () => {
    seedSynced({ "exemple-tld": Date.now(), "autre-tld": Date.now() });

    const { result } = mount([SOURCE, OTHER]);

    await act(async () => {
      await Promise.resolve();
    });
    expect(importIcs).not.toHaveBeenCalled();
    expect(result.current.syncing).toBe(false);
  });
});
