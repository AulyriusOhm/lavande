import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function stubFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/pgp/keys")) return response({ keys: [] });
    if (url === "/api/accounts") return response([ACCOUNT]);
    if (url.endsWith("/folders")) return response(FOLDERS);
    return response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

const saved = () =>
  JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
    hiddenFolders?: Record<string, string[]>;
  };

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

describe("Réglages PC · masquage d'un dossier", () => {
  it("masque le dossier depuis le périmètre du compte puis propose de le réafficher", async () => {
    stubFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers synchronisés de Perso"));
    fireEvent.click(await screen.findByLabelText("Masquer le dossier Projets"));

    await waitFor(() => expect(saved().hiddenFolders).toEqual({ a1: ["Projets"] }));
    expect(await screen.findByLabelText("Réafficher le dossier Projets")).toBeTruthy();
    expect(screen.queryByLabelText("Masquer le dossier Projets")).toBeNull();
  });

  it("réaffiche le dossier masqué et retire le réglage", async () => {
    window.localStorage.setItem("lavande.prefs", JSON.stringify({ hiddenFolders: { a1: ["Projets"] } }));
    stubFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers synchronisés de Perso"));
    fireEvent.click(await screen.findByLabelText("Réafficher le dossier Projets"));

    await waitFor(() => expect(saved().hiddenFolders).toEqual({}));
    expect(await screen.findByLabelText("Masquer le dossier Projets")).toBeTruthy();
    expect(screen.queryByLabelText("Réafficher le dossier Projets")).toBeNull();
  });

  it("ne propose le masquage que pour les dossiers personnalisés", async () => {
    stubFetch();
    mount();

    fireEvent.click(await screen.findByLabelText("Dossiers synchronisés de Perso"));

    await screen.findByLabelText("Masquer le dossier Projets");
    expect(screen.queryByLabelText("Masquer le dossier Boîte de réception")).toBeNull();
    expect(screen.getAllByLabelText(/^Masquer le dossier/)).toHaveLength(1);
  });
});
