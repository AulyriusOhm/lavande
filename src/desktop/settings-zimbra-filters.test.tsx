import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import { filterSummary } from "@/components/zimbra-filters";
import type { ApiAccount, ZimbraFilter, ZimbraVacation } from "@/lib/api";

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
  {
    id: "gmail",
    label: "Google",
    email: "roman@gmail.com",
    username: "roman@gmail.com",
    imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
    folders: 1,
    auth_kind: "oauth2",
  },
];

const FILTERS: ZimbraFilter[] = [
  {
    name: "facture",
    active: true,
    condition: "anyof",
    tests: [{ kind: "header", header: "Subject", comparison: "contains", value: "facture" }],
    actions: [{ kind: "file_into", folder_path: "Factures" }],
    read_only: false,
  },
  {
    name: "alerte",
    active: false,
    condition: "allof",
    tests: [],
    actions: [],
    read_only: true,
  },
];

const VACATION: ZimbraVacation = {
  enabled: true,
  message: "Absent jusqu'à lundi.",
  from: "2026-01-01",
  until: null,
};

const reply = (payload: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubDaemon(options: { filters?: ZimbraFilter[]; filterStatus?: number; writeStatus?: number } = {}) {
  let rules = options.filters ?? FILTERS;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/accounts") return reply(ACCOUNTS);
    if (url.endsWith("/folders") || url.endsWith("/folder-counts")) return reply([]);
    if (url.endsWith("/zimbra/tags")) return reply([]);
    if (url.endsWith("/zimbra/filters")) {
      if (method === "POST") {
        const status = options.writeStatus ?? 204;
        if (status >= 400) {
          return reply({ error: "serveur Zimbra : service failure (service.FAILURE)", kind: "soap" }, status);
        }
        const change = JSON.parse(String(init?.body)) as { action: string; rule: { name: string } };
        if (change.action === "delete") rules = rules.filter((rule) => rule.name !== change.rule.name);
        return reply({}, status);
      }
      if (options.filterStatus && options.filterStatus >= 400) {
        return reply({ error: "serveur Zimbra injoignable", kind: "soap" }, options.filterStatus);
      }
      return reply(rules);
    }
    if (url.endsWith("/zimbra/vacation")) {
      if (method === "PUT") return reply({}, options.writeStatus ?? 204);
      return reply(VACATION);
    }
    return reply({}, 204);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string, method?: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const request = init as RequestInit | undefined;
    return String(input).endsWith(suffix) && (method === undefined || (request?.method ?? "GET") === method);
  });

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

function openSection(label: string) {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sections des réglages" })).getByRole("button", { name: label }),
  );
}

const section = () => document.getElementById("reglages-messagerie") as HTMLElement;
/** Le panneau des filtres : la section porte aussi les étiquettes. */
const panel = () => document.querySelector('[data-testid="zimbra-filters"]') as HTMLElement;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
});

describe("Réglages · filtres et absence Zimbra", () => {
  it("liste les filtres du serveur et résume conditions puis actions", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    openSection("Filtres & absence");

    await waitFor(() => expect(within(section()).getByText("facture")).toBeTruthy());
    expect(within(section()).getByText("actif")).toBeTruthy();
    expect(within(section()).getByText(/Subject contient « facture » → ranger dans Factures/)).toBeTruthy();
    expect(within(section()).getByText("lecture seule")).toBeTruthy();
    expect(within(section()).getByText(/règle avancée · à modifier dans l'interface Zimbra/)).toBeTruthy();
    expect(within(section()).queryByRole("button", { name: "Modifier le filtre alerte" })).toBeNull();
    expect(within(section()).getByLabelText("Filtres de Pro")).toBeTruthy();
    expect(calls(fetchMock, "/api/accounts/pro/zimbra/filters", "GET")).toHaveLength(1);
    expect(calls(fetchMock, "/api/accounts/pro/zimbra/vacation", "GET")).toHaveLength(1);
    expect(filterSummary(FILTERS[0])).toBe("Subject contient « facture » → ranger dans Factures");
  });

  it("ajoute un filtre et n'envoie que la règle au serveur", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    openSection("Filtres & absence");
    await waitFor(() => expect(within(section()).getByText("facture")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Nouveau filtre" }));
    fireEvent.change(screen.getByLabelText("Nom du filtre"), { target: { value: "dossier" } });
    fireEvent.change(screen.getByLabelText("Valeur de la condition 1"), { target: { value: "exemple.tld" } });
    fireEvent.change(screen.getByLabelText("Dossier de l'action 1"), { target: { value: "Archive" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le filtre" }));

    await waitFor(() => expect(calls(fetchMock, "/api/accounts/pro/zimbra/filters", "POST")).toHaveLength(1));
    const [, init] = calls(fetchMock, "/api/accounts/pro/zimbra/filters", "POST")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe(
      JSON.stringify({
        action: "add",
        rule: {
          name: "dossier",
          active: true,
          condition: "allof",
          tests: [{ kind: "header", header: "From", comparison: "contains", value: "exemple.tld" }],
          actions: [{ kind: "file_into", folder_path: "Archive" }],
        },
      }),
    );
    await waitFor(() => expect(within(panel()).getByRole("status").textContent).toContain("créé sur le serveur"));
    expect(within(panel()).getByRole("status").textContent).toContain("dossier");
  });

  it("supprime un filtre après confirmation", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    openSection("Filtres & absence");
    await waitFor(() => expect(within(section()).getByText("facture")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le filtre facture" }));
    expect(calls(fetchMock, "/api/accounts/pro/zimbra/filters", "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => expect(calls(fetchMock, "/api/accounts/pro/zimbra/filters", "POST")).toHaveLength(1));
    const [, init] = calls(fetchMock, "/api/accounts/pro/zimbra/filters", "POST")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ action: "delete", rule: { name: "facture" } });
    await waitFor(() => expect(within(panel()).getByRole("status").textContent).toContain("supprimé du serveur"));
  });

  it("enregistre le message d'absence et ses dates sur le serveur", async () => {
    const fetchMock = stubDaemon();
    renderSettings();
    openSection("Filtres & absence");
    await waitFor(() => expect(within(section()).getByText("facture")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch", { name: /Répondre automatiquement/ }));
    fireEvent.change(screen.getByLabelText("Message d'absence"), {
      target: { value: "De retour lundi." },
    });
    fireEvent.change(screen.getByLabelText("Fin de l'absence"), { target: { value: "2026-01-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer l'absence" }));

    await waitFor(() => expect(calls(fetchMock, "/api/accounts/pro/zimbra/vacation", "PUT")).toHaveLength(1));
    const [, init] = calls(fetchMock, "/api/accounts/pro/zimbra/vacation", "PUT")[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: false,
      message: "De retour lundi.",
      from: "2026-01-01",
      until: "2026-01-15",
    });
    await waitFor(() => expect(within(panel()).getByRole("status").textContent).toContain("Message d'absence enregistré"));
  });

  it("remonte un serveur muet sans rien inventer", async () => {
    stubDaemon({ filterStatus: 502 });
    renderSettings();
    openSection("Filtres & absence");

    await waitFor(() => expect(within(panel()).getByRole("status").textContent).toContain("serveur Zimbra injoignable"));
    expect(within(panel()).getByRole("status").textContent).toContain("soap");
    expect(within(section()).getByText(/Filtres illisibles/)).toBeTruthy();
  });

  it("annonce un refus d'écriture du serveur", async () => {
    stubDaemon({ writeStatus: 502 });
    renderSettings();
    openSection("Filtres & absence");
    await waitFor(() => expect(within(section()).getByText("facture")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Nouveau filtre" }));
    fireEvent.change(screen.getByLabelText("Nom du filtre"), { target: { value: "dossier" } });
    fireEvent.change(screen.getByLabelText("Valeur de la condition 1"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Dossier de l'action 1"), { target: { value: "Archive" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le filtre" }));

    await waitFor(() => expect(within(panel()).getByRole("alert").textContent).toContain("Écriture refusée"));
    expect(within(panel()).getByRole("alert").textContent).toContain("service.FAILURE");
    expect(within(section()).queryByText(/créé sur le serveur/)).toBeNull();
  });

});
