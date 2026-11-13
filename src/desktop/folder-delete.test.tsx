import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { DesktopSettings } from "@/desktop/settings";
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

function stubBackend(refusal: { error: string } | null = null) {
  const deletes: string[] = [];
  const vanished: string[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "DELETE" && /\/api\/accounts\/a1\/folders\//.test(url)) {
      const path = decodeURIComponent(url.split("/folders/")[1]);
      deletes.push(path);
      if (refusal) return response({ error: refusal.error, kind: "imap" }, 502);
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
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

async function openFoldersPanel() {
  fireEvent.click(await screen.findByLabelText("Dossiers synchronisés de Perso"));
  return screen.findByLabelText("Supprimer le dossier Projets");
}

describe("réglages · suppression d'un dossier", () => {
  it("supprime un dossier personnalisé après confirmation nominative", async () => {
    const { deletes } = stubBackend();
    render(<DesktopSettings />, { wrapper });

    fireEvent.click(await openFoldersPanel());
    expect(screen.queryByLabelText("Supprimer le dossier Boîte de réception")).toBeNull();
    fireEvent.click(screen.getByLabelText("Confirmer la suppression du dossier Projets"));

    await waitFor(() => expect(deletes).toEqual(["Projets"]));
    await waitFor(() => expect(screen.queryByLabelText("Supprimer le dossier Projets")).toBeNull());
  });

  it("garde le dossier quand le serveur refuse", async () => {
    const { deletes } = stubBackend({ error: "serveur IMAP : DELETE refusé" });
    render(<DesktopSettings />, { wrapper });

    fireEvent.click(await openFoldersPanel());
    fireEvent.click(screen.getByLabelText("Confirmer la suppression du dossier Projets"));

    await waitFor(() => expect(deletes).toEqual(["Projets"]));
    await waitFor(() => expect(screen.getByLabelText("Supprimer le dossier Projets")).toBeTruthy());
  });

  it("renonce quand on annule", async () => {
    const { deletes } = stubBackend();
    render(<DesktopSettings />, { wrapper });

    fireEvent.click(await openFoldersPanel());
    fireEvent.click(screen.getByLabelText("Annuler la suppression du dossier"));

    expect(screen.getByLabelText("Supprimer le dossier Projets")).toBeTruthy();
    expect(deletes).toEqual([]);
  });
});

describe("rail des dossiers · suppression retirée", () => {
  it("ne propose plus la suppression depuis la boîte de réception", async () => {
    stubBackend();
    render(<DesktopInbox />, { wrapper });

    await screen.findByLabelText("Masquer le dossier Projets");
    expect(screen.queryByLabelText(/Supprimer le dossier/)).toBeNull();
  });
});
