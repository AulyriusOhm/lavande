import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder, ApiFolderRole } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const ACCOUNTS: ApiAccount[] = [
  {
    id: "a1",
    label: "Perso",
    email: "roman@lavande.mail",
    username: "roman",
    imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
    smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
    folders: 2,
  },
  {
    id: "a2",
    label: "Travail",
    email: "travail@lavande.mail",
    username: "travail",
    imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
    smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
    folders: 2,
  },
];

const folder = (accountId: string, path: string, role: ApiFolderRole): ApiFolder => ({
  account_id: accountId,
  path,
  name: path === "INBOX" ? "Boîte de réception" : path,
  role,
  uidvalidity: 7,
  uidnext: 42,
  last_sync_at: null,
});

const FOLDERS: ApiFolder[] = [
  folder("a1", "INBOX", "inbox"),
  folder("a1", "Projets", "other"),
  folder("a2", "INBOX", "inbox"),
  folder("a2", "Projets", "other"),
];

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubBackend(accounts: ApiAccount[] = [ACCOUNTS[0]]) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/accounts") return response(accounts);
    const folders = /^\/api\/accounts\/([^/]+)\/folders$/.exec(url);
    if (folders) return response(FOLDERS.filter((entry) => entry.account_id === folders[1]));
    if (url.endsWith("/folder-counts")) return response([]);
    if (url.endsWith("/sync")) return response({ reports: [] });
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
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

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("rail des dossiers · masquage", () => {
  it("masque un dossier personnalisé puis le réaffiche depuis le lien de récupération", async () => {
    stubBackend();
    render(<DesktopInbox />, { wrapper });

    fireEvent.click(await screen.findByLabelText("Masquer le dossier Projets"));

    await waitFor(() => expect(screen.queryByLabelText("Masquer le dossier Projets")).toBeNull());
    expect(screen.queryByText("Projets")).toBeNull();

    const toggle = screen.getByRole("button", { name: /1 masqué/ });
    fireEvent.click(toggle);

    fireEvent.click(await screen.findByLabelText("Réafficher le dossier Projets"));

    expect(await screen.findByLabelText("Masquer le dossier Projets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /masqué/ })).toBeNull();
  });

  it("n'offre pas le masquage en vue tous comptes", async () => {
    stubBackend(ACCOUNTS);
    render(<DesktopInbox />, { wrapper });

    await screen.findByText("Projets");
    expect(screen.queryByLabelText(/^Masquer le dossier/)).toBeNull();
  });
});
