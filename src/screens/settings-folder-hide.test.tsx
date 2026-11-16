import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const account = (id: string, label: string): ApiAccount => ({
  id,
  label,
  email: `${id}@lavande.mail`,
  username: id,
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 2,
});

const A1 = account("a1", "Perso");
const A2 = account("a2", "Travail");

const FOLDERS: ApiFolder[] = [
  {
    account_id: "a1",
    path: "INBOX",
    name: "Boîte de réception",
    role: "inbox",
    uidvalidity: 7,
    uidnext: 42,
    last_sync_at: null,
  },
  {
    account_id: "a1",
    path: "Projets",
    name: "Projets",
    role: "other",
    uidvalidity: 8,
    uidnext: 9,
    last_sync_at: null,
  },
  {
    account_id: "a2",
    path: "INBOX",
    name: "Boîte de réception",
    role: "inbox",
    uidvalidity: 7,
    uidnext: 42,
    last_sync_at: null,
  },
  {
    account_id: "a2",
    path: "Projets",
    name: "Projets",
    role: "other",
    uidvalidity: 8,
    uidnext: 9,
    last_sync_at: null,
  },
];

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubBackend(accounts: ApiAccount[] = [A1]) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/accounts") return response(accounts);
    const folders = /^\/api\/accounts\/([^/]+)\/folders$/.exec(url);
    if (folders) return response(FOLDERS.filter((entry) => entry.account_id === folders[1]));
    if (url.endsWith("/folder-counts")) return response([]);
    if (url.endsWith("/sync")) return response({ reports: [] });
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <PrefsProvider>
    <ThemeProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </ThemeProvider>
  </PrefsProvider>
);

const saved = () =>
  JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
    hiddenFolders?: Record<string, string[]>;
  };

const seedHidden = (hiddenFolders: Record<string, string[]>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ hiddenFolders }));

function mountSettings() {
  const view = render(
    <SettingsScreen
      mails={[]}
      account="a1"
      onOpenAccounts={() => {}}
      onOpenPgp={() => {}}
      onOpenMcp={() => {}}
    />,
    { wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: /^Comptes/ }));
  return view;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("Réglages mobile · masquage d'un dossier", () => {
  it("masque un dossier personnalisé et le garde réaffichable", async () => {
    stubBackend();
    mountSettings();

    fireEvent.click(await screen.findByLabelText("Masquer le dossier Projets"));

    await waitFor(() => expect(saved().hiddenFolders).toEqual({ a1: ["Projets"] }));
    expect(await screen.findByLabelText("Réafficher le dossier Projets")).toBeTruthy();
    expect(screen.queryByLabelText("Masquer le dossier Projets")).toBeNull();
    expect(screen.getByText("masqué")).toBeTruthy();
  });

  it("réaffiche un dossier masqué depuis la liste des réglages", async () => {
    stubBackend();
    seedHidden({ a1: ["Projets"] });
    mountSettings();

    expect(await screen.findByText("masqué")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Réafficher le dossier Projets"));

    await waitFor(() => expect(saved().hiddenFolders).toEqual({}));
    expect(await screen.findByLabelText("Masquer le dossier Projets")).toBeTruthy();
    expect(screen.queryByText("masqué")).toBeNull();
  });

  it("n'offre ni masquage ni réaffichage en vue tous comptes", async () => {
    stubBackend([A1, A2]);
    seedHidden({ a1: ["Projets"] });
    mountSettings();

    await screen.findByRole("heading", { name: "Dossiers" });
    expect(screen.queryByLabelText(/^Masquer le dossier/)).toBeNull();
    expect(screen.queryByLabelText(/^Réafficher le dossier/)).toBeNull();
    expect(screen.queryByText("masqué")).toBeNull();
    expect(screen.getAllByText("Projets").length).toBeGreaterThan(0);
  });
});
