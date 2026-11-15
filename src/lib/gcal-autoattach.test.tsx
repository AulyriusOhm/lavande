import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGoogleCalendarAutoAttach } from "@/lib/ics";
import { loadCalendars } from "@/lib/calendars";
import type { ApiAccount } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

const GMAIL: ApiAccount = {
  id: "gmail",
  label: "Gmail",
  email: "roman@gmail.com",
  username: "roman@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 1,
};

const reply = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;

function stub(accounts: ApiAccount[] = [GMAIL]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/accounts") return reply(accounts);
    if (/\/calendars\/google\/[^/]+\/calendars$/.test(url))
      return reply([{ id: "primary", summary: "Mon agenda", primary: true }]);
    if (/\/calendars\/google\/[^/]+\/events$/.test(url))
      return reply([
        { uid: "g1", title: "RDV", date: "2026-03-15", start: "09:00", end: "10:00", all_day: false, timezone: "UTC", location: null, description: null, recurring: false, source: "Mon agenda" },
      ]);
    return reply({}, 204);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const googleDefs = () => loadCalendars().filter((entry) => entry.source?.kind === "google");

beforeEach(() => {
  window.localStorage.clear();
});

describe("useGoogleCalendarAutoAttach", () => {
  it("attache le calendrier principal du compte Google au démarrage", async () => {
    stub();
    const notify = vi.fn();
    const { unmount } = renderHook(() => useGoogleCalendarAutoAttach(notify));
    await waitFor(() => expect(window.localStorage.getItem("lavande.ics.v1")).toContain("google:mon-agenda:g1"));
    expect(googleDefs()).toHaveLength(1);
    expect(googleDefs()[0].name).toBe("Mon agenda");
    expect(googleDefs()[0].source).toEqual({ kind: "google", accountId: "gmail", calendarId: "primary" });
    expect(notify).toHaveBeenCalledWith("Calendrier Google ajouté · Mon agenda");
    unmount();
  });

  it("ne réajoute pas un compte déjà traité (garde persistante)", async () => {
    window.localStorage.setItem("lavande.gcal.autoattach.v1", JSON.stringify(["gmail"]));
    const fetchMock = stub();
    const { unmount } = renderHook(() => useGoogleCalendarAutoAttach(vi.fn()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(googleDefs()).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => /\/calendars\/google\//.test(String(input)))).toBe(false);
    unmount();
  });

  it("n'attache rien sans compte Google", async () => {
    stub([]);
    const { unmount } = renderHook(() => useGoogleCalendarAutoAttach(vi.fn()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(googleDefs()).toHaveLength(0);
    unmount();
  });
});
