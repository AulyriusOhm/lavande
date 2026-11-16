import { describe, expect, it } from "vitest";
import { calendarAccountId, loadCalendars, saveCalendars, type CalendarDef } from "@/lib/calendars";
import type { CaldavSource } from "@/lib/api";
import { accountCalendarAttached, sourceCalendarName } from "@/lib/zimbra";

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
