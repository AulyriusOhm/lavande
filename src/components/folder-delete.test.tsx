import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MailboxSheet } from "@/screens/inbox-screen";
import { SettingsScreen } from "@/screens/settings-screen";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
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

function mountSheet() {
  return render(
    <MailboxSheet folder="inbox" onSelect={() => {}} onClose={() => {}} />,
    { wrapper },
  );
}

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

describe("suppression d'un dossier · réglages mobiles", () => {
  it("ne propose que les dossiers personnalisés", async () => {
    stubBackend();
    mountSettings();

    expect(await screen.findByRole("heading", { name: "Dossiers" })).toBeTruthy();
    await screen.findByLabelText("Supprimer le dossier Projets");
    expect(screen.queryByLabelText("Supprimer le dossier Boîte de réception")).toBeNull();
  });

  it("écrit le nom du dossier puis supprime après confirmation", async () => {
    const { deletes } = stubBackend();
    mountSettings();

    fireEvent.click(await screen.findByLabelText("Supprimer le dossier Projets"));
    const confirm = screen.getByLabelText("Confirmer la suppression du dossier Projets");
    expect(confirm.textContent).toContain("Projets");
    expect(deletes).toEqual([]);

    fireEvent.click(confirm);

    await waitFor(() => expect(deletes).toEqual(["Projets"]));
    await waitFor(() => expect(screen.queryByLabelText("Supprimer le dossier Projets")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Dossiers" })).toBeNull());
  });

  it("renonce quand on annule", async () => {
    const { deletes } = stubBackend();
    mountSettings();

    fireEvent.click(await screen.findByLabelText("Supprimer le dossier Projets"));
    fireEvent.click(screen.getByLabelText("Annuler la suppression du dossier"));

    expect(screen.getByLabelText("Supprimer le dossier Projets")).toBeTruthy();
    expect(deletes).toEqual([]);
  });

  it("garde le dossier quand le serveur refuse", async () => {
    const { deletes } = stubBackend({ error: "serveur IMAP : DELETE refusé" });
    mountSettings();

    fireEvent.click(await screen.findByLabelText("Supprimer le dossier Projets"));
    fireEvent.click(screen.getByLabelText("Confirmer la suppression du dossier Projets"));

    await waitFor(() => expect(deletes).toEqual(["Projets"]));
    await waitFor(() => expect(screen.getByLabelText("Supprimer le dossier Projets")).toBeTruthy());
  });
});

describe("suppression d'un dossier · rail", () => {
  it("ne propose plus la suppression depuis la liste des dossiers", async () => {
    stubBackend();
    mountSheet();

    await screen.findByRole("button", { name: /^Projets/ });
    expect(screen.queryByLabelText(/Supprimer le dossier/)).toBeNull();
  });
});

describe("suppression d'un dossier · action du store", () => {
  it("remonte l'erreur du serveur et laisse le dossier en place", async () => {
    stubBackend({ error: "serveur IMAP : DELETE refusé" });
    const { result } = renderHook(() => useMailStore(), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    await act(async () => {
      await result.current.deleteFolder("Projets", "Projets");
    });

    expect(result.current.folderOptions.some((option) => option.path === "Projets")).toBe(true);
    expect(result.current.notices.at(-1)?.message).toContain("DELETE refusé");
  });

  it("revient sur la boîte de réception quand le dossier sélectionné disparaît", async () => {
    stubBackend();
    const { result } = renderHook(() => useMailStore(), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    act(() => result.current.setFolder("other", "Projets"));

    await act(async () => {
      await result.current.deleteFolder("Projets", "Projets");
    });

    expect(result.current.folder).toBe("inbox");
    expect(result.current.folderPath).toBeNull();
    expect(result.current.folderOptions.some((option) => option.path === "Projets")).toBe(false);
    expect(result.current.notices.at(-1)?.message).toBe("Dossier « Projets » supprimé");
  });
});
