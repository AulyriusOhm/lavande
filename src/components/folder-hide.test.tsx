import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MailboxSheet } from "@/screens/inbox-screen";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder, ApiFolderRole } from "@/lib/api";

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

const folder = (accountId: string, path: string, role: ApiFolderRole): ApiFolder => ({
  account_id: accountId,
  path,
  name: path === "INBOX" ? "Boîte de réception" : path,
  role,
  uidvalidity: 7,
  uidnext: 42,
  last_sync_at: null,
});

const A1 = account("a1", "Perso");
const A2 = account("a2", "Travail");

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
    <PlanningProvider storage={createMemoryStorage()}>
      <MailStoreProvider>{children}</MailStoreProvider>
    </PlanningProvider>
  </PrefsProvider>
);

const seedHidden = (hiddenFolders: Record<string, string[]>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ hiddenFolders }));

const hiddenStored = () =>
  (JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
    hiddenFolders?: Record<string, string[]>;
  }).hiddenFolders;

const mountSheet = () =>
  render(<MailboxSheet folder="inbox" onSelect={() => {}} onClose={() => {}} />, { wrapper });

const readyStore = async () => {
  const { result } = renderHook(() => useMailStore(), { wrapper });
  await waitFor(() => expect(result.current.phase).toBe("ready"));
  return result;
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("masquage d'un dossier · filtrage de la liste", () => {
  it("retire le dossier masqué de la vue mono-compte", async () => {
    stubBackend();
    seedHidden({ a1: ["Projets"] });
    const result = await readyStore();

    await waitFor(() => expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(false));
    expect(result.current.folderOptions.some((o) => o.id === "inbox")).toBe(true);
    expect(result.current.hiddenFolderOptions.map((o) => o.path)).toEqual(["Projets"]);
  });

  it("garde le dossier en vue tous comptes quand un autre compte ne le masque pas", async () => {
    stubBackend([A1, A2]);
    seedHidden({ a1: ["Projets"] });
    const result = await readyStore();

    await waitFor(() => expect(result.current.account).toBe("all"));
    expect(result.current.folderOptions.filter((o) => o.path === "Projets")).toHaveLength(1);

    act(() => result.current.setAccount("a1"));
    expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(false);

    act(() => result.current.setAccount("a2"));
    expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(true);
  });

  it("ne masque jamais la boîte de réception", async () => {
    stubBackend();
    seedHidden({ a1: ["INBOX"] });
    const result = await readyStore();

    await waitFor(() => expect(result.current.folderOptions.length).toBeGreaterThan(0));
    expect(result.current.folderOptions.some((o) => o.id === "inbox")).toBe(true);
  });

  it("expose les dossiers masqués du seul compte courant", async () => {
    stubBackend([A1, A2]);
    seedHidden({ a1: ["Projets"], a2: ["Projets"] });
    const result = await readyStore();

    await waitFor(() => expect(result.current.account).toBe("all"));
    expect(result.current.hiddenFolderOptions).toEqual([]);

    act(() => result.current.setAccount("a1"));
    expect(result.current.hiddenFolderOptions.map((o) => o.label)).toEqual(["Projets"]);
  });
});

describe("masquage d'un dossier · actions du store", () => {
  it("masque puis réaffiche le dossier courant et persiste le réglage", async () => {
    stubBackend();
    const result = await readyStore();
    await waitFor(() => expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(true));

    act(() => result.current.hideFolder("Projets"));

    expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(false);
    expect(hiddenStored()).toEqual({ a1: ["Projets"] });

    act(() => result.current.unhideFolder("Projets"));

    expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(true);
    expect(hiddenStored()).toEqual({});
  });

  it("relit le masquage après un remontage", async () => {
    stubBackend();
    const first = renderHook(() => useMailStore(), { wrapper });
    await waitFor(() => expect(first.result.current.phase).toBe("ready"));
    act(() => first.result.current.hideFolder("Projets"));
    expect(hiddenStored()).toEqual({ a1: ["Projets"] });
    first.unmount();

    const result = await readyStore();
    await waitFor(() => expect(result.current.folderOptions.some((o) => o.path === "Projets")).toBe(false));
  });

  it("revient sur la boîte de réception quand le dossier ouvert est masqué", async () => {
    stubBackend();
    const result = await readyStore();
    act(() => result.current.setFolder("other", "Projets"));

    act(() => result.current.hideFolder("Projets"));

    expect(result.current.folder).toBe("inbox");
    expect(result.current.folderPath).toBeNull();
  });

  it("ignore le masquage en vue tous comptes", async () => {
    stubBackend([A1, A2]);
    const result = await readyStore();
    await waitFor(() => expect(result.current.account).toBe("all"));

    act(() => result.current.hideFolder("Projets"));

    expect(hiddenStored()).toEqual({});
  });
});

describe("masquage d'un dossier · UI", () => {
  it("masque depuis la ligne du dossier puis le réaffiche", async () => {
    stubBackend();
    mountSheet();

    fireEvent.click(await screen.findByLabelText("Masquer le dossier Projets"));

    await waitFor(() => expect(screen.queryByLabelText("Masquer le dossier Projets")).toBeNull());
    const toggle = screen.getByRole("button", { name: /1 masqué/ });
    expect(toggle.textContent).toContain("Afficher");
    expect(screen.queryByLabelText("Réafficher le dossier Projets")).toBeNull();

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByLabelText("Réafficher le dossier Projets"));

    expect(await screen.findByLabelText("Masquer le dossier Projets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /masqué/ })).toBeNull();
  });

  it("n'offre pas le masquage en vue tous comptes", async () => {
    stubBackend([A1, A2]);
    mountSheet();

    await screen.findByLabelText("Supprimer le dossier Projets");
    expect(screen.queryByLabelText(/^Masquer le dossier/)).toBeNull();
  });

  it("garde un accès pour réafficher un dossier masqué d'avance", async () => {
    stubBackend();
    seedHidden({ a1: ["Projets"] });
    mountSheet();

    await screen.findByRole("button", { name: /1 masqué/ });
    expect(screen.queryByLabelText("Masquer le dossier Projets")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /1 masqué/ }));
    fireEvent.click(await screen.findByLabelText("Réafficher le dossier Projets"));

    expect(await screen.findByLabelText("Masquer le dossier Projets")).toBeTruthy();
  });
});
