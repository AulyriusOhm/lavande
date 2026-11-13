import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MailboxSheet } from "@/screens/inbox-screen";
import { useFolderTree } from "@/components/folder-tree";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
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
  folders: 4,
};

const folder = (path: string, name: string, role: ApiFolder["role"]): ApiFolder => ({
  account_id: "a1",
  path,
  name,
  role,
  uidvalidity: 7,
  uidnext: 42,
  last_sync_at: null,
  delimiter: "/",
});

const FOLDERS: ApiFolder[] = [
  folder("INBOX", "Boîte de réception", "inbox"),
  folder("Travail", "Travail", "other"),
  folder("Travail/2026", "2026", "other"),
  folder("Voyages", "Voyages", "other"),
];

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "/api/accounts") return response([ACCOUNT]);
      if (url.endsWith("/folders")) return response(FOLDERS);
      if (url.endsWith("/folder-counts")) return response([]);
      if (url.endsWith("/sync")) return response({ reports: [] });
      return response([]);
    }),
  );
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <PrefsProvider>
    <PlanningProvider storage={createMemoryStorage()}>
      <MailStoreProvider>{children}</MailStoreProvider>
    </PlanningProvider>
  </PrefsProvider>
);

const ITEMS = [
  { path: "INBOX", delimiter: "/" },
  { path: "INBOX/Travail", delimiter: "/" },
  { path: "INBOX/Travail/2026", delimiter: "/" },
  { path: "Envoyés", delimiter: "/" },
];

describe("useFolderTree", () => {
  it("aplatit l'arbre avec la profondeur de chaque nœud", () => {
    const { result } = renderHook(() => useFolderTree(ITEMS));

    expect(result.current.map((row) => [row.depth, row.node.path])).toEqual([
      [0, "INBOX"],
      [1, "INBOX/Travail"],
      [2, "INBOX/Travail/2026"],
      [0, "Envoyés"],
    ]);
    expect(result.current.map((row) => row.hasChildren)).toEqual([true, true, false, false]);
  });

  it("replie puis déplie les enfants d'un palier", () => {
    const { result } = renderHook(() => useFolderTree(ITEMS));

    act(() => result.current[0].toggle());
    expect(result.current.map((row) => row.node.path)).toEqual(["INBOX", "Envoyés"]);

    act(() => result.current[0].toggle());
    expect(result.current.map((row) => row.node.path)).toEqual([
      "INBOX",
      "INBOX/Travail",
      "INBOX/Travail/2026",
      "Envoyés",
    ]);
  });
});

describe("arbre des dossiers dans la feuille des dossiers", () => {
  const mountSheet = (onSelect = vi.fn()) => {
    render(<MailboxSheet folder="inbox" onSelect={onSelect} onClose={() => {}} />, { wrapper });
    return onSelect;
  };

  beforeEach(() => {
    window.localStorage.clear();
    stubBackend();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubEnv("VITE_MAIL_BACKEND", "api");
  });

  it("imbrique les sous-dossiers et garde les rôles à plat", async () => {
    mountSheet();

    await waitFor(() => expect(screen.getByText("2026")).toBeTruthy());
    const indented = screen.getByText("2026").closest("div[style]") as HTMLElement | null;
    const flat = screen.getByText("Voyages").closest("div[style]") as HTMLElement | null;

    expect(indented?.style.paddingLeft).toBe("18px");
    expect(flat).toBeNull();
  });

  it("replie un palier et le déplie", async () => {
    mountSheet();

    await waitFor(() => expect(screen.getByText("2026")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Replier Travail"));
    expect(screen.queryByText("2026")).toBeNull();

    fireEvent.click(screen.getByLabelText("Déplier Travail"));
    expect(screen.getByText("2026")).toBeTruthy();
  });

  it("sélectionne un sous-dossier par son chemin complet", async () => {
    const onSelect = mountSheet();

    await waitFor(() => expect(screen.getByText("2026")).toBeTruthy());
    fireEvent.click(screen.getByText("2026"));

    expect(onSelect).toHaveBeenCalledWith("other", "Travail/2026");
  });
});
