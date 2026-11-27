import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopSettings } from "@/desktop/settings";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const ACCOUNT: ApiAccount = {
  id: "a1",
  label: "Perso",
  email: "roman@lavande.mail",
  username: "roman",
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 2,
};

const OAUTH_ACCOUNT: ApiAccount = {
  id: "g1",
  label: "Gmail",
  email: "roman.lanro@gmail.com",
  username: "roman.lanro@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 1,
  auth_kind: "oauth2",
  needs_reauth: true,
};

const FOLDERS: ApiFolder[] = [
  {
    account_id: "a1",
    path: "INBOX",
    name: "Boîte de réception",
    role: "inbox",
    uidvalidity: 7,
    uidnext: 42,
    last_sync_at: "2026-03-12T10:00:00Z",
  },
  {
    account_id: "a1",
    path: "Archives",
    name: "Archives",
    role: "archive",
    uidvalidity: 8,
    uidnext: 9,
    last_sync_at: null,
  },
];

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const noContent = (): Response => ({ ok: true, status: 204 }) as unknown as Response;

function stubFetch() {
  const state = { label: ACCOUNT.label, purged: [] as string[], synced: null as string[] | null };
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    if (url === "/api/accounts" ) return response([{ ...ACCOUNT, label: state.label }]);
    if (method === "PATCH" && url === "/api/accounts/a1") {
      state.label = (JSON.parse(String(init?.body)) as { label: string }).label;
      return response({ ...ACCOUNT, label: state.label });
    }
    if (method === "PATCH" && url === "/api/accounts/a1/sync-folders") {
      state.synced = (JSON.parse(String(init?.body)) as { folders: string[] | null }).folders;
      return response({ ...ACCOUNT, synced_folders: state.synced });
    }
    if (url.endsWith("/folders")) {
      return response(FOLDERS.filter((folder) => !state.purged.includes(folder.path)));
    }
    if (method === "DELETE" && url.endsWith("/local")) {
      const path = decodeURIComponent(url.split("/folders/")[1].replace(/\/local$/, ""));
      state.purged.push(path);
      return noContent();
    }
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, state };
}

/** Deux comptes : un mot de passe, un Google dont la connexion a expiré. */
function stubOAuthFetch() {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    if (url === "/api/accounts") return response([ACCOUNT, OAUTH_ACCOUNT]);
    if (method === "POST" && url === "/api/oauth/reconnect") {
      return response(
        {
          session: "s1",
          auth_url: "https://exemple.test/consent",
          redirect_uri: "http://127.0.0.1:8790/api/oauth/callback",
        },
        201,
      );
    }
    if (url.startsWith("/api/oauth/status")) {
      return response({ status: "failed", error: "consentement refusé" });
    }
    if (url.endsWith("/folders")) return response(FOLDERS);
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

function mount() {
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

beforeEach(() => {
  window.localStorage.clear();
});

describe("Réglages · comptes", () => {
  it("renomme un compte et met à jour l'affichage", async () => {
    const { fetchMock, state } = stubFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Renommer Perso"));
    fireEvent.change(screen.getByLabelText("Nouveau nom pour roman@lavande.mail"), {
      target: { value: "Bureau" },
    });
    fireEvent.click(screen.getByText("Valider"));

    await waitFor(() => expect(state.label).toBe("Bureau"));
    const patch = fetchMock.mock.calls.find(
      ([url, init]) => init?.method === "PATCH" && String(url) === "/api/accounts/a1",
    );
    expect(patch?.[1]?.body).toBe(JSON.stringify({ label: "Bureau" }));
    expect((await screen.findAllByText("Bureau")).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Renommer Perso")).toBeNull();
  });

  it("reconnecte un compte OAuth2 sans le retirer", async () => {
    const { fetchMock } = stubOAuthFetch();
    vi.spyOn(window, "open").mockReturnValue(null);
    mount();

    fireEvent.click(await screen.findByLabelText("Reconnecter Gmail"));

    await waitFor(() => {
      const reconnect = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === "POST" && String(url) === "/api/oauth/reconnect",
      );
      expect(reconnect?.[1]?.body).toBe(JSON.stringify({ account_id: "g1" }));
    });
    expect(screen.queryByLabelText("Reconnecter Perso")).toBeNull();
  });

  it("signale la connexion expirée du compte concerné", async () => {
    stubOAuthFetch();
    mount();

    expect(await screen.findByText("Connexion expirée")).toBeTruthy();
    expect(screen.getAllByText("Connexion expirée")).toHaveLength(1);
  });

  it("laisse la rangée d'actions se replier dans la carte étroite", async () => {
    stubFetch();
    mount();

    const actions = (await screen.findByLabelText("Renommer Perso")).parentElement;
    expect(actions?.className).toContain("flex-wrap");
    expect(actions?.parentElement?.className).toContain("min-w-0");
  });
});

describe("Réglages · dossiers synchronisés", () => {
  it("décoche un dossier et enregistre la sélection", async () => {
    const { state } = stubFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers synchronisés de Perso"));
    const inbox = (await screen.findByLabelText("Synchroniser Boîte de réception")) as HTMLInputElement;
    const archive = screen.getByLabelText("Synchroniser Archives") as HTMLInputElement;
    expect(inbox.checked).toBe(true);
    expect(archive.checked).toBe(true);

    fireEvent.click(archive);

    await waitFor(() => expect(state.synced).toEqual(["INBOX"]));
    await waitFor(() =>
      expect((screen.getByLabelText("Synchroniser Archives") as HTMLInputElement).checked).toBe(false),
    );
    expect(screen.getByText("1 dossier synchronisé")).toBeTruthy();
  });

  it("coupe la synchronisation des dossiers avec le commutateur", async () => {
    const { state } = stubFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers synchronisés de Perso"));
    fireEvent.click(await screen.findByRole("switch", { name: /Synchroniser les dossiers/ }));

    await waitFor(() => expect(state.synced).toEqual([]));
    expect(await screen.findByText("aucun dossier synchronisé automatiquement")).toBeTruthy();
    expect(screen.queryByLabelText("Synchroniser Boîte de réception")).toBeNull();
  });
});

describe("Réglages · PGP par compte", () => {
  const saved = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

  it("affiche l'interrupteur du compte et enregistre sa coupure", async () => {
    stubFetch();
    mount();
    openSection("Sécurité & PGP");

    const master = await screen.findByRole("switch", { name: /PGP pour Perso/ });
    expect(master.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/PGP désactivé : ce compte/)).toBeNull();

    fireEvent.click(master);

    expect(await screen.findByText(/PGP désactivé : ce compte/)).toBeTruthy();
    await waitFor(() =>
      expect(saved().pgpAccounts).toEqual({ a1: { enabled: false, encrypt: true, sign: true } }),
    );
    expect(screen.getByRole("switch", { name: /PGP pour Perso/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("règle la signature du compte sans toucher au chiffrement", async () => {
    stubFetch();
    mount();
    openSection("Sécurité & PGP");

    fireEvent.click(await screen.findByRole("switch", { name: /Signer ses messages/ }));

    await waitFor(() =>
      expect(saved().pgpAccounts).toEqual({ a1: { enabled: true, encrypt: true, sign: false } }),
    );
    expect(screen.getByRole("switch", { name: /Chiffrer ses messages/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});

describe("Réglages · dossiers analysés par l'IA", () => {
  const AI_FOLDERS: ApiFolder[] = [
    ...FOLDERS,
    {
      account_id: "a1",
      path: "INBOX/Informatique",
      name: "Informatique",
      role: "other",
      uidvalidity: 9,
      uidnext: 3,
      last_sync_at: null,
    },
  ];

  /** Le compte n'a rien choisi : le service renvoie `ai_folders` absent. */
  function stubAiFetch(folders: ApiFolder[] = AI_FOLDERS) {
    const state = { saved: undefined as string[] | null | undefined };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/pgp/keys")) return response({ keys: [] });
      if (url === "/api/accounts") return response([ACCOUNT]);
      if (method === "PATCH" && url === "/api/accounts/a1/ai-folders") {
        state.saved = (JSON.parse(String(init?.body)) as { folders: string[] | null }).folders;
        return response({ ...ACCOUNT, ai_folders: state.saved });
      }
      if (url.endsWith("/folders")) return response(folders);
      return response([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, state };
  }

  it("affiche la réception par défaut et enregistre le retrait d'un dossier", async () => {
    const { state } = stubAiFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers analysés par l'IA de Perso"));

    const inbox = (await screen.findByLabelText("Analyser Boîte de réception")) as HTMLInputElement;
    const informatique = screen.getByLabelText("Analyser Informatique") as HTMLInputElement;
    const archive = screen.getByLabelText("Analyser Archives") as HTMLInputElement;
    expect(screen.getByText("Réception (INBOX + dossiers perso)")).toBeTruthy();
    expect(inbox.checked).toBe(true);
    expect(informatique.checked).toBe(true);
    expect(archive.checked).toBe(false);

    fireEvent.click(informatique);

    await waitFor(() => expect(state.saved).toEqual(["INBOX"]));
    await waitFor(() =>
      expect((screen.getByLabelText("Analyser Informatique") as HTMLInputElement).checked).toBe(false),
    );
    expect(screen.getByText("1 dossier analysé")).toBeTruthy();
  });

  it("revient à la réception par défaut, enregistrée comme `null`", async () => {
    const { state } = stubAiFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers analysés par l'IA de Perso"));
    const informatique = (await screen.findByLabelText("Analyser Informatique")) as HTMLInputElement;

    fireEvent.click(informatique);
    await waitFor(() => expect(state.saved).toEqual(["INBOX"]));

    fireEvent.click(screen.getByLabelText("Analyser Informatique"));

    await waitFor(() => expect(state.saved).toBeNull());
    expect(await screen.findByText("Réception (INBOX + dossiers perso)")).toBeTruthy();
  });

  it("retient la sélection renvoyée par le service", async () => {
    const { state } = stubAiFetch([FOLDERS[0]]);
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers analysés par l'IA de Perso"));

    expect(await screen.findByLabelText("Analyser Boîte de réception")).toBeTruthy();
    expect(screen.queryByLabelText("Analyser Archives")).toBeNull();
    expect(state.saved).toBeUndefined();
  });
});
