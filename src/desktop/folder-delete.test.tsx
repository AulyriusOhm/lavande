import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder } from "@/lib/api";

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
];

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
];

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const noContent = (): Response => ({ ok: true, status: 204 }) as unknown as Response;

function stubBackend() {
  const deletes: string[] = [];
  const vanished: string[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "DELETE" && /\/api\/accounts\/a1\/folders\//.test(url)) {
      const path = decodeURIComponent(url.split("/folders/")[1]);
      deletes.push(path);
      vanished.push(path);
      return noContent();
    }
    if (url === "/api/accounts") return response(ACCOUNTS);
    if (url === "/api/accounts/a1/folders") {
      return response(FOLDERS.filter((folder) => !vanished.includes(folder.path)));
    }
    if (url.endsWith("/folder-counts")) return response([]);
    if (url.endsWith("/sync")) return response({ reports: [] });
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { deletes };
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
});

describe("rail des dossiers · suppression", () => {
  it("supprime un dossier personnalisé après confirmation nominative", async () => {
    const { deletes } = stubBackend();
    render(<DesktopInbox />, { wrapper });

    fireEvent.click(await screen.findByLabelText("Supprimer le dossier Projets"));
    expect(screen.queryByLabelText("Supprimer le dossier Boîte de réception")).toBeNull();
    fireEvent.click(screen.getByLabelText("Confirmer la suppression du dossier Projets"));

    await waitFor(() => expect(deletes).toEqual(["Projets"]));
    await waitFor(() => expect(screen.queryByLabelText("Supprimer le dossier Projets")).toBeNull());
  });
});
