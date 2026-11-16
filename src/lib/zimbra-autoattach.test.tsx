import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useZimbraCalendarAutoAttach } from "@/lib/ics";
import { loadCalendars, saveCalendars } from "@/lib/calendars";
import type { ApiAccount } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

const ZIMBRA: ApiAccount = {
  id: "perso",
  label: "Perso",
  email: "roman@exemple.tld",
  username: "roman@exemple.tld",
  imap: { host: "mail.exemple.tld", port: 993, encryption: "tls" },
  smtp: { host: "mail.exemple.tld", port: 465, encryption: "tls" },
  folders: 1,
};

const GMAIL: ApiAccount = {
  id: "gmail",
  label: "Gmail",
  email: "roman@gmail.com",
  username: "roman@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 1,
};

const SOURCE = {
  id: "mail-exemple-tld",
  name: "mail.exemple.tld",
  url: "https://mail.exemple.tld/dav/",
  account_id: "perso",
};

const reply = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;

function stub(accounts: ApiAccount[] = [ZIMBRA], status = 201) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/accounts") return reply(accounts);
    if (url === "/api/calendars/caldav/sources/from-account") return reply(SOURCE, status);
    if (/\/calendars\/caldav\/sources\/[^/]+\/events$/.test(url))
      return reply([
        {
          uid: "z1",
          title: "Point équipe",
          date: "2026-03-15",
          start: "09:00",
          end: "10:00",
          all_day: false,
          timezone: "UTC",
          location: null,
          description: null,
          recurring: false,
          source: "mail.exemple.tld",
        },
      ]);
    return reply({}, 204);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const linkedDefs = () =>
  loadCalendars().filter((entry) => entry.source?.kind === "caldav" && entry.source.accountId);

const fromAccountCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/calendars/caldav/sources/from-account"));

beforeEach(() => {
  window.localStorage.clear();
});

describe("useZimbraCalendarAutoAttach", () => {
  it("attache l'agenda du compte mail au démarrage", async () => {
    const fetchMock = stub();
    const notify = vi.fn();
    const { unmount } = renderHook(() => useZimbraCalendarAutoAttach(notify));
    await waitFor(() => expect(window.localStorage.getItem("lavande.ics.v1")).toContain("caldav:mail-exemple-tld:z1"));
    expect(linkedDefs()).toHaveLength(1);
    expect(linkedDefs()[0].name).toBe("mail.exemple.tld");
    expect(linkedDefs()[0].source).toEqual({
      kind: "caldav",
      sourceId: "mail-exemple-tld",
      accountId: "perso",
    });
    expect(notify).toHaveBeenCalledWith("Calendrier ajouté · mail.exemple.tld");
    const [, init] = fromAccountCalls(fetchMock)[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ account_id: "perso" }));
    unmount();
  });

  it("ne réessaie pas un compte déjà traité (garde persistante)", async () => {
    window.localStorage.setItem("lavande.zimbra.autoattach.v1", JSON.stringify(["perso"]));
    const fetchMock = stub();
    const { unmount } = renderHook(() => useZimbraCalendarAutoAttach(vi.fn()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(linkedDefs()).toHaveLength(0);
    expect(fromAccountCalls(fetchMock)).toHaveLength(0);
    unmount();
  });

  it("reste silencieux quand le démon refuse le compte et le marque comme traité", async () => {
    const fetchMock = stub([GMAIL], 400);
    const notify = vi.fn();
    const { unmount } = renderHook(() => useZimbraCalendarAutoAttach(notify));
    await waitFor(() => expect(window.localStorage.getItem("lavande.zimbra.autoattach.v1")).toContain("gmail"));
    expect(linkedDefs()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(fromAccountCalls(fetchMock)).toHaveLength(1);
    unmount();
  });

  it("n'attache rien quand l'agenda du compte est déjà lié", async () => {
    saveCalendars([
      {
        id: "mail-exemple-tld",
        name: "mail.exemple.tld",
        tone: 3,
        source: { kind: "caldav", sourceId: "mail-exemple-tld", accountId: "perso" },
      },
    ]);
    const fetchMock = stub();
    const { unmount } = renderHook(() => useZimbraCalendarAutoAttach(vi.fn()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fromAccountCalls(fetchMock)).toHaveLength(0);
    expect(linkedDefs()).toHaveLength(1);
    unmount();
  });

  it("n'attache rien sans compte mail", async () => {
    const fetchMock = stub([]);
    const { unmount } = renderHook(() => useZimbraCalendarAutoAttach(vi.fn()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fromAccountCalls(fetchMock)).toHaveLength(0);
    expect(linkedDefs()).toHaveLength(0);
    unmount();
  });
});
