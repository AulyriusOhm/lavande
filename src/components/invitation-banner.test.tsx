import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InvitationBanner, calendarAttachment } from "@/components/invitation-banner";
import type { Invitation } from "@/lib/api";
import type { MailAttachment } from "@/lib/mail";

const INVITATION_URI = "/api/accounts/perso/folders/INBOX/messages/7/invitation";
const RSVP_URI = `${INVITATION_URI}/rsvp`;

const CALENDAR_FILE: MailAttachment = {
  name: "invitation.ics",
  size: "1,2 Ko",
  mime: "text/calendar; charset=utf-8",
  index: 1,
};

const invitation = (over: Partial<Invitation> = {}): Invitation => ({
  method: "REQUEST",
  uid: "reunion-42",
  summary: "Revue de design",
  date: "2026-11-25",
  start: "14:00",
  end: "15:00",
  all_day: false,
  timezone: "Europe/Paris",
  organizer: { name: "Camille Roy", email: "camille@studio-lilas.fr" },
  attendees: [
    { email: "roman@lavande.mail", name: "Roman", partstat: "NEEDS-ACTION", role: "REQ-PARTICIPANT" },
    { email: "marc@mail.fr", name: null, partstat: "ACCEPTED", role: null },
  ],
  sequence: 3,
  ...over,
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stub(routes: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => routes(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(attachments: MailAttachment[], selfEmail = "roman@lavande.mail") {
  return render(
    <InvitationBanner
      accountId="perso"
      folderPath="INBOX"
      uid={7}
      attachments={attachments}
      selfEmail={selfEmail}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bannière d'invitation", () => {
  it("ne retient que la pièce de calendrier d'un message", () => {
    expect(calendarAttachment([{ name: "planning.pdf", size: "1 Ko", mime: "application/pdf" }])).toBeUndefined();
    expect(calendarAttachment([CALENDAR_FILE])).toBe(CALENDAR_FILE);
    expect(
      calendarAttachment([{ name: "invitation.ics", size: "1 Ko", mime: "application/ics" }])?.name,
    ).toBe("invitation.ics");
  });

  it("ne s'affiche pas sur un message sans invitation", () => {
    const fetchMock = stub(() => jsonResponse(null));
    const { container } = mount([{ name: "planning.pdf", size: "1 Ko", mime: "application/pdf" }]);

    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("affiche l'événement, l'organisateur et la réponse en cours", async () => {
    stub(() => jsonResponse(invitation()));
    mount([CALENDAR_FILE]);

    expect(await screen.findByText("Revue de design")).toBeTruthy();
    expect(screen.getByText(/organisé par Camille Roy/)).toBeTruthy();
    expect(screen.getByText(/25 novembre 2026 · 14:00 – 15:00/)).toBeTruthy();
    expect(screen.getByText(/Ta réponse : sans réponse/)).toBeTruthy();
  });

  it("répond par CalDAV et le dit honnêtement", async () => {
    const fetchMock = stub((url) =>
      url === INVITATION_URI
        ? jsonResponse(invitation())
        : jsonResponse({
            via: "caldav",
            invitation: invitation({
              attendees: [
                { email: "roman@lavande.mail", name: "Roman", partstat: "ACCEPTED", role: "REQ-PARTICIPANT" },
              ],
            }),
          }),
    );
    mount([CALENDAR_FILE]);
    await screen.findByText("Revue de design");

    fireEvent.click(screen.getByRole("button", { name: "Accepter" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("envoyée à l'organisateur depuis ton agenda"),
    );
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(RSVP_URI);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ status: "ACCEPTED" });
    expect(screen.getByText(/Ta réponse : accepté/)).toBeTruthy();
  });

  it("signale le repli par mail quand aucun agenda n'est lié", async () => {
    stub((url) =>
      url === INVITATION_URI
        ? jsonResponse(invitation())
        : jsonResponse({ via: "mail", invitation: invitation() }),
    );
    mount([CALENDAR_FILE]);
    await screen.findByText("Revue de design");

    fireEvent.click(screen.getByRole("button", { name: "Provisoire" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("par mail"));
  });

  it("surface un refus du serveur sans mentir sur la réponse", async () => {
    stub((url) =>
      url === INVITATION_URI
        ? jsonResponse(invitation())
        : jsonResponse({ error: "ETag périmé", kind: "caldav" }, 412),
    );
    mount([CALENDAR_FILE]);
    await screen.findByText("Revue de design");

    fireEvent.click(screen.getByRole("button", { name: "Refuser" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Réponse impossible"));
    expect(screen.getByText(/Ta réponse : sans réponse/)).toBeTruthy();
  });

  it("lit un événement annulé sans proposer de réponse", async () => {
    stub(() => jsonResponse(invitation({ method: "CANCEL" })));
    mount([CALENDAR_FILE]);

    expect(await screen.findByText("Événement annulé par l'organisateur")).toBeTruthy();
    expect(screen.getByText(/Aucun événement n'a été supprimé/)).toBeTruthy();
    for (const label of ["Accepter", "Provisoire", "Refuser"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("reste en lecture seule quand la démo l'impose", async () => {
    stub(() => jsonResponse(invitation()));
    render(
      <InvitationBanner
        accountId="perso"
        folderPath="INBOX"
        uid={7}
        attachments={[CALENDAR_FILE]}
        readOnly
      />,
    );

    await screen.findByText("Revue de design");
    expect(screen.queryByRole("button", { name: "Accepter" })).toBeNull();
  });
});
