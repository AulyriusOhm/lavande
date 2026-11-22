import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MessageTags } from "@/components/message-tags";
import type { ZimbraTag } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "local");

const SOURCE = { accountId: "pro", folderPath: "INBOX", uid: 7 };

const TRAVAIL: ZimbraTag = { id: "1", name: "Travail", color: 1 };
const FACTURE: ZimbraTag = { id: "2", name: "Facture", color: 5 };

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(options: { tags?: ZimbraTag[]; catalog?: ZimbraTag[]; readStatus?: number; writeStatus?: number } = {}) {
  let onMessage = options.tags ?? [TRAVAIL];
  let catalog = options.catalog ?? [TRAVAIL, FACTURE];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/zimbra/tags")) {
      if (method === "POST") {
        const created: ZimbraTag = { id: "9", name: "Projet", color: 3 };
        catalog = [...catalog, created];
        return reply(created, 201);
      }
      return reply(catalog);
    }
    if (pathname.endsWith("/zimbra/message-tags")) {
      if (method === "POST") {
        if ((options.writeStatus ?? 204) >= 400) {
          return reply({ error: "serveur Zimbra : service failure", kind: "soap" }, options.writeStatus ?? 502);
        }
        const body = JSON.parse(String(init?.body)) as { tag_id: string; add: boolean };
        const tag = catalog.find((entry) => entry.id === body.tag_id);
        if (tag) {
          onMessage = body.add
            ? [...onMessage.filter((entry) => entry.id !== tag.id), tag]
            : onMessage.filter((entry) => entry.id !== tag.id);
        }
        return reply(onMessage);
      }
      if ((options.readStatus ?? 200) >= 400) {
        return reply({ error: "message introuvable sur le serveur Zimbra", kind: "soap" }, options.readStatus);
      }
      return reply(onMessage);
    }
    return reply({}, 204);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string, method?: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const request = init as RequestInit | undefined;
    return String(input).includes(suffix) && (method === undefined || (request?.method ?? "GET") === method);
  });

const chips = () => screen.queryAllByTestId("message-tag");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
});

describe("lecteur · étiquettes Zimbra", () => {
  it("affiche les pastilles du message sans bouton quand il n'y a pas de source", async () => {
    const fetchMock = stubDaemon();
    const { rerender } = render(<MessageTags source={SOURCE} />);

    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(screen.getByTestId("message-tags").textContent).toContain("Travail");
    expect(calls(fetchMock, "/zimbra/message-tags", "GET")[0][0]).toBe(
      "/api/accounts/pro/zimbra/message-tags?folder=INBOX&uid=7",
    );

    rerender(<MessageTags source={undefined} />);
    expect(screen.queryByTestId("message-tags")).toBeNull();
  });

  it("pose puis retire une étiquette et suit la réponse du serveur", async () => {
    const fetchMock = stubDaemon();
    render(<MessageTags source={SOURCE} />);
    await waitFor(() => expect(chips()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Étiqueter le message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Poser l'étiquette Facture" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Poser l'étiquette Facture" }));

    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(chips().map((chip) => chip.textContent)).toEqual(["Facture", "Travail"]);
    const [posted] = calls(fetchMock, "/zimbra/message-tags", "POST");
    expect(posted[0]).toBe("/api/accounts/pro/zimbra/message-tags");
    expect(JSON.parse(String((posted[1] as RequestInit).body))).toEqual({
      folder: "INBOX",
      uid: 7,
      tag_id: "2",
      add: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retirer l'étiquette Travail" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    const sent = calls(fetchMock, "/zimbra/message-tags", "POST").map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(sent[1]).toEqual({ folder: "INBOX", uid: 7, tag_id: "1", add: false });
  });

  it("crée une étiquette à la volée puis la pose sur le message", async () => {
    const fetchMock = stubDaemon({ catalog: [TRAVAIL] });
    render(<MessageTags source={SOURCE} />);
    await waitFor(() => expect(chips()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Étiqueter le message" }));
    await waitFor(() => expect(screen.getByLabelText("Nom de la nouvelle étiquette")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Nom de la nouvelle étiquette"), { target: { value: "Projet" } });
    fireEvent.click(screen.getByRole("button", { name: "vert" }));
    fireEvent.click(screen.getByRole("button", { name: "Créer et étiqueter" }));

    await waitFor(() => expect(calls(fetchMock, "/zimbra/tags", "POST")).toHaveLength(1));
    const [, created] = calls(fetchMock, "/zimbra/tags", "POST")[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(created.body))).toEqual({ name: "Projet", color: 3 });
    await waitFor(() => expect(calls(fetchMock, "/zimbra/message-tags", "POST")).toHaveLength(1));
    const [, tagged] = calls(fetchMock, "/zimbra/message-tags", "POST")[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(tagged.body))).toEqual({ folder: "INBOX", uid: 7, tag_id: "9", add: true });
    await waitFor(() => expect(chips().map((chip) => chip.textContent)).toContain("Projet"));
  });

  it("reste muet quand le serveur ne répond pas, et le dit dans le choix", async () => {
    stubDaemon({ readStatus: 502 });
    render(<MessageTags source={SOURCE} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Étiqueter le message" })).toBeTruthy());
    expect(screen.getByTestId("message-tags").textContent).not.toContain("introuvable");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Étiqueter le message" }));
    await waitFor(() =>
      expect(within(screen.getByTestId("message-tags")).getByRole("status").textContent).toContain("Zimbra"),
    );
  });

  it("annonce un refus d'écriture sans perdre les pastilles", async () => {
    stubDaemon({ writeStatus: 502 });
    render(<MessageTags source={SOURCE} />);
    await waitFor(() => expect(chips()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Étiqueter le message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Poser l'étiquette Facture" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Poser l'étiquette Facture" }));

    await waitFor(() => expect(within(screen.getByTestId("message-tags")).getByRole("status").textContent).toContain("service failure"));
    expect(chips()).toHaveLength(1);
  });
});
