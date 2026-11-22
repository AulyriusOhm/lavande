import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { tagColorLabel, tagDot } from "@/lib/zimbra-tags";
import type { ApiAccount, ZimbraTag } from "@/lib/api";

const ACCOUNTS: ApiAccount[] = [
  {
    id: "pro",
    label: "Pro",
    email: "roman@exemple.tld",
    username: "roman@exemple.tld",
    imap: { host: "mail.exemple.tld", port: 993, encryption: "tls" },
    smtp: { host: "mail.exemple.tld", port: 465, encryption: "tls" },
    folders: 1,
    auth_kind: "password",
  },
];

const TRAVAIL: ZimbraTag = { id: "1", name: "Travail", color: 1, count: 3 };
const FACTURE: ZimbraTag = { id: "2", name: "Facture", color: 5 };

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(
  options: { tags?: ZimbraTag[]; readStatus?: number; writeStatus?: number } = {},
) {
  let tags = options.tags ?? [TRAVAIL, FACTURE];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/api/accounts")) return reply(ACCOUNTS);
    if (pathname.endsWith("/folders") || pathname.endsWith("/folder-counts")) return reply([]);
    if (pathname.endsWith("/zimbra/filters")) return reply([]);
    if (pathname.endsWith("/zimbra/vacation")) return reply({ enabled: false, message: "" });
    if (pathname.includes("/zimbra/tags")) {
      if (method !== "GET" && (options.writeStatus ?? 204) >= 400) {
        return reply(
          { error: "serveur Zimbra : service failure (service.FAILURE)", kind: "soap" },
          options.writeStatus ?? 502,
        );
      }
      if ((options.readStatus ?? 200) >= 400) {
        return reply({ error: "serveur Zimbra injoignable", kind: "soap" }, options.readStatus);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string; color: number };
        const created = { id: "9", ...body };
        tags = [...tags, created];
        return reply(created, 201);
      }
      if (method === "PATCH") {
        const id = pathname.split("/").pop() ?? "";
        const body = JSON.parse(String(init?.body)) as { name?: string; color?: number };
        tags = tags.map((tag) => (tag.id === id ? { ...tag, ...body } : tag));
        return reply({}, 204);
      }
      if (method === "DELETE") {
        const id = pathname.split("/").pop() ?? "";
        tags = tags.filter((tag) => tag.id !== id);
        return reply({}, 204);
      }
      return reply(tags);
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

const panel = () => document.querySelector('[data-testid="zimbra-tags"]') as HTMLElement;

function renderSettings() {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <DesktopSettings />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
});

describe("Réglages · étiquettes Zimbra", () => {
  it("liste les étiquettes du compte avec leur couleur et leur compte d'items", async () => {
    stubDaemon();
    renderSettings();

    await waitFor(() => expect(within(panel()).getByText("Travail")).toBeTruthy());
    expect(within(panel()).getByText("Facture")).toBeTruthy();
    expect(within(panel()).getByText("bleu")).toBeTruthy();
    expect(within(panel()).getByText("rouge")).toBeTruthy();
    expect(within(panel()).getByText("3")).toBeTruthy();
    expect(within(panel()).getByLabelText("Étiquettes de Pro")).toBeTruthy();
    expect(tagDot(5)).toBe("#e5484d");
    expect(tagColorLabel(0)).toBe("sans couleur");
  });

  it("crée, renomme puis supprime une étiquette sur le serveur", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    await waitFor(() => expect(within(panel()).getByText("Travail")).toBeTruthy());

    fireEvent.change(within(panel()).getByLabelText("Nom de l'étiquette"), {
      target: { value: " Projet " },
    });
    fireEvent.click(within(panel()).getByRole("button", { name: "vert" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Créer l'étiquette" }));

    await waitFor(() => expect(calls(fetchMock, "/zimbra/tags", "POST")).toHaveLength(1));
    const [, created] = calls(fetchMock, "/zimbra/tags", "POST")[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(created.body))).toEqual({ name: "Projet", color: 3 });
    await waitFor(() => expect(within(panel()).getByText("Projet")).toBeTruthy());
    expect(within(panel()).getByRole("status").textContent).toContain("créée");

    fireEvent.click(within(panel()).getByRole("button", { name: "Renommer l'étiquette Travail" }));
    fireEvent.change(within(panel()).getByLabelText("Nouveau nom de l'étiquette Travail"), {
      target: { value: "Bureau" },
    });
    fireEvent.click(within(panel()).getByRole("button", { name: "Enregistrer l'étiquette Travail" }));

    await waitFor(() => expect(calls(fetchMock, "/zimbra/tags/1", "PATCH")).toHaveLength(1));
    const [, renamed] = calls(fetchMock, "/zimbra/tags/1", "PATCH")[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(renamed.body))).toEqual({ name: "Bureau", color: 1 });
    await waitFor(() => expect(within(panel()).getByText("Bureau")).toBeTruthy());

    fireEvent.click(within(panel()).getByRole("button", { name: "Supprimer l'étiquette Facture" }));
    expect(calls(fetchMock, "/zimbra/tags/2", "DELETE")).toHaveLength(0);
    fireEvent.click(
      within(panel()).getByRole("button", { name: "Confirmer la suppression de l'étiquette Facture" }),
    );

    await waitFor(() => expect(calls(fetchMock, "/zimbra/tags/2", "DELETE")).toHaveLength(1));
    await waitFor(() => expect(within(panel()).queryByText("Facture")).toBeNull());
  });

  it("refuse une étiquette sans nom sans appeler le serveur", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    await waitFor(() => expect(within(panel()).getByText("Travail")).toBeTruthy());

    fireEvent.change(within(panel()).getByLabelText("Nom de l'étiquette"), { target: { value: "  " } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Créer l'étiquette" }));

    await waitFor(() => expect(within(panel()).getByRole("alert").textContent).toContain("nom de l'étiquette"));
    expect(calls(fetchMock, "/zimbra/tags", "POST")).toHaveLength(0);
  });

  it("dit un serveur muet sans crier", async () => {
    stubDaemon({ readStatus: 502 });
    renderSettings();

    await waitFor(() =>
      expect(within(panel()).getByRole("status").textContent).toContain("serveur Zimbra injoignable"),
    );
    expect(within(panel()).getByText(/Étiquettes illisibles/)).toBeTruthy();
  });

  it("annonce un refus d'écriture du serveur", async () => {
    stubDaemon({ writeStatus: 502 });
    renderSettings();
    await waitFor(() => expect(within(panel()).getByText("Travail")).toBeTruthy());

    fireEvent.change(within(panel()).getByLabelText("Nom de l'étiquette"), { target: { value: "Projet" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Créer l'étiquette" }));

    await waitFor(() =>
      expect(within(panel()).getByRole("alert").textContent).toContain("service.FAILURE"),
    );
    expect(within(panel()).getByRole("alert").textContent).toContain("Écriture refusée");
  });
});
