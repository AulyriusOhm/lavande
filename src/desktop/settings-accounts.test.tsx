import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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

const WHEN = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

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

    fireEvent.click(await screen.findByRole("switch", { name: /Signer ses messages/ }));

    await waitFor(() =>
      expect(saved().pgpAccounts).toEqual({ a1: { enabled: true, encrypt: true, sign: false } }),
    );
    expect(screen.getByRole("switch", { name: /Chiffrer ses messages/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});
