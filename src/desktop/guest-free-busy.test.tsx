import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GuestFreeBusy, eventBounds, guestStatus } from "@/components/guest-free-busy";
import type { ZimbraFreeBusyUser } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

const GUESTS: ZimbraFreeBusyUser[] = [
  {
    email: "camille@exemple.tld",
    slots: [{ start: new Date("2026-03-15T14:30:00").getTime(), end: new Date("2026-03-15T15:30:00").getTime(), status: "busy" }],
  },
  {
    email: "support@exemple.tld",
    slots: [{ start: new Date("2026-03-15T09:00:00").getTime(), end: new Date("2026-03-15T18:00:00").getTime(), status: "out" }],
  },
];

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(options: { guests?: ZimbraFreeBusyUser[]; status?: number } = {}) {
  const fetchMock = vi.fn(async () => reply(options.status && options.status >= 400
    ? { error: "serveur Zimbra injoignable", kind: "soap" }
    : (options.guests ?? GUESTS), options.status ?? 200));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const panel = () => screen.getByTestId("guest-free-busy");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
});

describe("agenda · disponibilités des invités", () => {
  it("n'interroge rien avant l'ouverture puis pastille chaque invité", async () => {
    const fetchMock = stubDaemon();
    render(
      <GuestFreeBusy
        accountId="pro"
        attendees={["camille@exemple.tld", "support@exemple.tld"]}
        date="2026-03-15"
        start="14:00"
        end="15:00"
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disponibilités des invités" }));

    await waitFor(() => expect(panel().textContent).toContain("occupé"));
    expect(panel().textContent).toContain("camille@exemple.tld");
    expect(panel().textContent).toContain("absence");
    expect(panel().textContent).toContain("support@exemple.tld");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/accounts/pro/zimbra/freebusy");
    expect(JSON.parse(String(init.body))).toEqual({
      emails: ["camille@exemple.tld", "support@exemple.tld"],
      from: new Date("2026-03-15T14:00:00").getTime(),
      to: new Date("2026-03-15T15:00:00").getTime(),
    });
  });

  it("dit un serveur muet sans alerter la page", async () => {
    stubDaemon({ status: 502 });
    render(
      <GuestFreeBusy accountId="pro" attendees={["camille@exemple.tld"]} date="2026-03-15" start="09:00" end="10:00" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disponibilités des invités" }));

    await waitFor(() => expect(panel().textContent).toContain("Disponibilités illisibles"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("serveur Zimbra injoignable");
  });

  it("ne rend rien sans compte Zimbra ou sans invité", () => {
    stubDaemon();
    const { rerender } = render(
      <GuestFreeBusy accountId={null} attendees={["camille@exemple.tld"]} date="2026-03-15" start="09:00" end="10:00" />,
    );
    expect(screen.queryByTestId("guest-free-busy")).toBeNull();

    rerender(<GuestFreeBusy accountId="pro" attendees={[]} date="2026-03-15" start="09:00" end="10:00" />);
    expect(screen.queryByTestId("guest-free-busy")).toBeNull();
  });

  it("classe les créneaux du pire au meilleur", () => {
    expect(guestStatus([], 0, 1)).toBe("free");
    const slots = GUESTS[0].slots;
    expect(guestStatus(slots, new Date("2026-03-15T08:00:00").getTime(), new Date("2026-03-15T09:00:00").getTime())).toBe(
      "free",
    );
    expect(guestStatus(slots, new Date("2026-03-15T14:45:00").getTime(), new Date("2026-03-15T15:15:00").getTime())).toBe(
      "busy",
    );
    expect(
      guestStatus(
        [{ start: 10, end: 20, status: "tentative" }, { start: 12, end: 14, status: "busy" }],
        0,
        100,
      ),
    ).toBe("busy");
    expect(eventBounds("2026-03-15", "23:00", "00:30")).toEqual({
      from: new Date("2026-03-15T23:00:00").getTime(),
      to: new Date("2026-03-15T23:00:00").getTime() + 60 * 60 * 1000,
    });
    expect(eventBounds("", "09:00", "10:00")).toBeNull();
  });
});
