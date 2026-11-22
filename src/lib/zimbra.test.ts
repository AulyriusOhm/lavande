import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount } from "@/lib/api";
import { calendarAccountId, loadCalendars, saveCalendars, type CalendarDef } from "@/lib/calendars";
import type { CaldavSource } from "@/lib/api";
import {
  ZIMBRA_CONTACTS_KEY,
  accountCalendarAttached,
  contactsReport,
  sourceCalendarName,
  syncAccountContacts,
  useZimbraContactsAutoSync,
} from "@/lib/zimbra";

const linked: CalendarDef = {
  id: "mail-exemple-tld",
  name: "mail.exemple.tld",
  tone: 3,
  source: { kind: "caldav", sourceId: "mail-exemple-tld", accountId: "perso" },
};

const manual: CalendarDef = {
  id: "travail",
  name: "Travail",
  tone: 1,
  source: { kind: "caldav", sourceId: "travail" },
};

const source = (over: Partial<CaldavSource> = {}): CaldavSource => ({
  id: "mail-exemple-tld",
  name: "mail.exemple.tld",
  url: "https://mail.exemple.tld/dav/",
  ...over,
});

describe("zimbra · source liée à un compte mail", () => {
  it("reconnaît le compte d'une source CalDAV liée", () => {
    expect(calendarAccountId(linked)).toBe("perso");
    expect(calendarAccountId(manual)).toBeUndefined();
  });

  it("garde le compte d'une source CalDAV dans le stockage local", () => {
    window.localStorage.clear();
    saveCalendars([linked, manual]);
    expect(loadCalendars()).toEqual([linked, manual]);
  });

  it("ignore un compte vide dans une source rangée", () => {
    window.localStorage.setItem(
      "lavande.calendars.v1",
      JSON.stringify([
        { id: "a", name: "A", tone: 0, source: { kind: "caldav", sourceId: "a", accountId: "  " } },
      ]),
    );
    expect(loadCalendars()[0].source).toEqual({ kind: "caldav", sourceId: "a" });
  });

  it("ne rattache pas deux fois l'agenda du même compte", () => {
    expect(accountCalendarAttached("perso", [linked, manual])).toBe(true);
    expect(accountCalendarAttached("autre", [linked, manual])).toBe(false);
    expect(accountCalendarAttached("perso", [manual])).toBe(false);
  });

  it("nomme la source par son hôte, à défaut par son URL", () => {
    expect(sourceCalendarName(source())).toBe("mail.exemple.tld");
    expect(sourceCalendarName(source({ name: "  " }))).toBe("mail.exemple.tld");
    expect(sourceCalendarName(source({ name: "", url: "pas une url" }))).toBe("Calendrier CalDAV");
  });
});

describe("zimbra · carnet CardDAV du compte", () => {
  const ZIMBRA: ApiAccount = {
    id: "perso",
    label: "Perso",
    email: "roman@exemple.tld",
    username: "roman@exemple.tld",
    imap: { host: "mail.exemple.tld", port: 993, encryption: "tls" },
    smtp: { host: "mail.exemple.tld", port: 465, encryption: "tls" },
    folders: 1,
  };

  const reply = (payload: unknown, status = 200) =>
    ({
      ok: status < 400,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response;

  const synced = () =>
    JSON.parse(window.localStorage.getItem(ZIMBRA_CONTACTS_KEY) ?? "[]") as string[];

  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("résume ce que le carnet a rapporté, cartes illisibles comprises", () => {
    expect(contactsReport({ count: 0, skipped: 0 })).toBe("Carnet synchronisé · 0 contacts");
    expect(contactsReport({ count: 1, skipped: 0 })).toBe("Carnet synchronisé · 1 contact");
    expect(contactsReport({ count: 12, skipped: 2 })).toBe(
      "Carnet synchronisé · 12 contacts · 2 cartes illisibles ignorées",
    );
    expect(contactsReport({ count: 5, skipped: 1 })).toBe(
      "Carnet synchronisé · 5 contacts · 1 carte illisible ignorée",
    );
  });

  it("lit le carnet du compte et retient qu'il a été lu", async () => {
    const fetchMock = vi.fn(async () => reply({ count: 4, skipped: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncAccountContacts("perso")).resolves.toBe("Carnet synchronisé · 4 contacts");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/perso/carddav/sync");
    expect(init.method).toBe("POST");
    expect(synced()).toEqual(["perso"]);
  });

  it("synchronise une fois par compte à l'ouverture", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/accounts") return reply([ZIMBRA, { ...ZIMBRA, id: "pro", label: "Pro" }]);
      return reply({ count: 2, skipped: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useZimbraContactsAutoSync());

    await waitFor(() => expect(synced().sort()).toEqual(["perso", "pro"]));
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/carddav/sync"))).toEqual([
      "/api/accounts/perso/carddav/sync",
      "/api/accounts/pro/carddav/sync",
    ]);
  });

  it("ne relit pas un carnet déjà lu, même en échec", async () => {
    window.localStorage.setItem(ZIMBRA_CONTACTS_KEY, JSON.stringify(["perso"]));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/accounts") return reply([ZIMBRA]);
      return reply({ count: 0, skipped: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useZimbraContactsAutoSync());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/accounts"]);
  });

  it("garde le compte quand le serveur refuse son carnet", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/accounts") return reply([ZIMBRA]);
      return reply({ error: "serveur de contacts : refusé", kind: "carddav" }, 502);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useZimbraContactsAutoSync());

    await waitFor(() => expect(synced()).toEqual(["perso"]));
  });
});
