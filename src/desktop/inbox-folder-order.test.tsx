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

const account = (id: string, label: string): ApiAccount => ({
  id,
  label,
  email: `${id}@lavande.mail`,
  username: id,
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 3,
});

const folder = (accountId: string, path: string, role: ApiFolderRole): ApiFolder => ({
  account_id: accountId,
  path,
  name: path === "INBOX" ? "Boîte de réception" : path,
  role,
  uidvalidity: 7,
  uidnext: 42,
  last_sync_at: null,
  delimiter: "/",
});

const A1 = account("a1", "Perso");
const A2 = account("a2", "Travail");

const FOLDERS: ApiFolder[] = [
  folder("a1", "INBOX", "inbox"),
  folder("a1", "Projets", "other"),
  folder("a1", "Voyages", "other"),
  folder("a2", "INBOX", "inbox"),
  folder("a2", "Projets", "other"),
  folder("a2", "Voyages", "other"),
];

const response = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubBackend(accounts: ApiAccount[] = [A1], folders: ApiFolder[] = FOLDERS) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/accounts") return response(accounts);
    const found = /^\/api\/accounts\/([^/]+)\/folders$/.exec(url);
    if (found) return response(folders.filter((entry) => entry.account_id === found[1]));
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

const seedOrder = (folderOrder: Record<string, string[]>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ folderOrder }));

const storedOrder = () =>
  (
    JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as {
      folderOrder?: Record<string, string[]>;
    }
  ).folderOrder;

const shown = () =>
  Array.from(document.querySelectorAll("[data-folder-row]")).map((row) =>
    row.getAttribute("data-folder-row"),
  );

const rowOf = (path: string) => {
  const row = document.querySelector(`[data-folder-row="${path}"]`);
  if (!row) throw new Error(`ligne absente : ${path}`);
  return row as HTMLElement;
};

const dragEvent = (element: HTMLElement, type: string, clientY = 0) =>
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));

const drop = (from: string, to: string, clientY = 0) => {
  dragEvent(rowOf(from), "dragstart");
  dragEvent(rowOf(to), "dragover", clientY);
  dragEvent(rowOf(to), "drop", clientY);
};

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("rail des dossiers · ordre d'affichage", () => {
  it("déplace un dossier devant un frère par glisser-déposer et persiste l'ordre", async () => {
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });
    await screen.findByRole("button", { name: /^Voyages/ });

    expect(shown()).toEqual(["INBOX", "Projets", "Voyages"]);

    drop("Voyages", "Projets");

    await waitFor(() => expect(shown()).toEqual(["INBOX", "Voyages", "Projets"]));
    expect(storedOrder()).toEqual({ a1: ["INBOX", "Voyages", "Projets"] });
  });

  it("dépose après le frère visé quand le pointeur est dans la moitié basse", async () => {
    stubBackend();
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });
    await screen.findByRole("button", { name: /^Projets/ });

    const target = rowOf("Projets");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 20,
      bottom: 20,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    dragEvent(rowOf("INBOX"), "dragstart");
    dragEvent(target, "dragover", 18);
    dragEvent(target, "drop", 18);

    await waitFor(() => expect(shown()).toEqual(["Projets", "INBOX", "Voyages"]));
  });

  it("relit l'ordre enregistré au remontage", async () => {
    stubBackend();
    seedOrder({ a1: ["INBOX", "Voyages", "Projets"] });
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await screen.findByRole("button", { name: /^Voyages/ });
    expect(shown()).toEqual(["INBOX", "Voyages", "Projets"]);
  });

  it("garde un ordre indépendant par compte", async () => {
    stubBackend([A1, A2]);
    seedOrder({ a1: ["INBOX", "Voyages", "Projets"], a2: ["Voyages", "Projets", "INBOX"] });
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await screen.findByRole("button", { name: "Perso" });
    fireEvent.click(screen.getByRole("button", { name: "Perso" }));
    await waitFor(() => expect(shown()).toEqual(["INBOX", "Voyages", "Projets"]));

    fireEvent.click(screen.getByRole("button", { name: "Travail" }));
    await waitFor(() => expect(shown()).toEqual(["Voyages", "Projets", "INBOX"]));
  });

  it("ne rend pas les dossiers déplaçables en vue tous comptes", async () => {
    stubBackend([A1, A2]);
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });

    await screen.findByRole("button", { name: "Perso" });
    expect(rowOf("Projets").getAttribute("draggable")).toBe("false");
  });

  const NESTED: ApiFolder[] = [
    folder("a1", "INBOX", "inbox"),
    folder("a1", "Projets", "other"),
    folder("a1", "Projets/2025", "other"),
    folder("a1", "Projets/2026", "other"),
    folder("a1", "Voyages", "other"),
    folder("a1", "Voyages/Asie", "other"),
  ];

  it("réordonne les enfants d'un même parent", async () => {
    stubBackend([A1], NESTED);
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });
    await screen.findByText("Voyages");

    drop("Projets/2026", "Projets/2025");

    await waitFor(() =>
      expect(shown()).toEqual([
        "INBOX",
        "Projets",
        "Projets/2026",
        "Projets/2025",
        "Voyages",
        "Voyages/Asie",
      ]),
    );
    expect(storedOrder()).toEqual({ a1: ["Projets/2026", "Projets/2025"] });
  });

  it("ignore un dépôt sur un enfant d'un autre parent", async () => {
    stubBackend([A1], NESTED);
    render(<DesktopInbox onOpenSearch={() => {}} />, { wrapper });
    await screen.findByText("Voyages");

    const before = shown();
    drop("Projets/2026", "Voyages/Asie");

    expect(shown()).toEqual(before);
    expect(storedOrder()?.a1).toBeUndefined();
  });
});
