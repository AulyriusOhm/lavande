import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MailboxSheet } from "@/screens/inbox-screen";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
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
  folder("a1", "Travail", "other"),
  folder("a1", "Travail/2026", "other"),
  folder("a1", "Voyages", "other"),
  folder("a2", "INBOX", "inbox"),
  folder("a2", "Travail", "other"),
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

const mountSheet = () =>
  render(<MailboxSheet folder="inbox" onSelect={() => {}} onClose={() => {}} />, { wrapper });

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("feuille des dossiers · réordonnancement tactile", () => {
  it("réordonne un dossier avec les flèches et persiste l'ordre", async () => {
    stubBackend();
    mountSheet();
    await screen.findByText("Voyages");

    expect(shown()).toEqual(["INBOX", "Travail", "Travail/2026", "Voyages"]);
    expect(screen.queryByLabelText("Monter Voyages")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Réordonner" }));
    fireEvent.click(screen.getByLabelText("Monter Voyages"));

    await waitFor(() => expect(shown()).toEqual(["INBOX", "Voyages", "Travail", "Travail/2026"]));
    expect(storedOrder()).toEqual({ a1: ["INBOX", "Voyages", "Travail"] });
  });

  it("descend un dossier d'un cran dans son niveau", async () => {
    stubBackend();
    mountSheet();
    await screen.findByText("Voyages");

    fireEvent.click(screen.getByRole("button", { name: "Réordonner" }));
    fireEvent.click(screen.getByLabelText("Descendre Travail"));

    await waitFor(() => expect(shown()).toEqual(["INBOX", "Voyages", "Travail", "Travail/2026"]));
  });

  it("ne fait pas sortir un sous-dossier de son niveau", async () => {
    stubBackend();
    mountSheet();
    await screen.findByText("Voyages");

    fireEvent.click(screen.getByRole("button", { name: "Réordonner" }));

    const disabled = (label: string) =>
      (screen.getByLabelText(label) as HTMLButtonElement).disabled;

    expect(disabled("Monter Travail/2026")).toBe(true);
    expect(disabled("Descendre Travail/2026")).toBe(true);
    expect(disabled("Monter Boîte de réception")).toBe(true);
    expect(disabled("Descendre Voyages")).toBe(true);
    expect(disabled("Monter Voyages")).toBe(false);
  });

  it("relit l'ordre enregistré à l'ouverture", async () => {
    stubBackend();
    seedOrder({ a1: ["Voyages", "INBOX", "Travail"] });
    mountSheet();

    await screen.findByText("Voyages");
    expect(shown()).toEqual(["Voyages", "INBOX", "Travail", "Travail/2026"]);
  });

  it("n'offre pas le réordonnancement en vue tous comptes", async () => {
    stubBackend([A1, A2]);
    mountSheet();

    await screen.findByText("Voyages");
    expect(screen.queryByRole("button", { name: "Réordonner" })).toBeNull();
  });

  it("garde les flèches dans le groupe du même parent", async () => {
    stubBackend(
      [A1],
      [
        folder("a1", "INBOX", "inbox"),
        folder("a1", "Travail", "other"),
        folder("a1", "Travail/2026", "other"),
        folder("a1", "Voyages", "other"),
        folder("a1", "Voyages/Asie", "other"),
        folder("a1", "Voyages/Japon", "other"),
      ],
    );
    mountSheet();
    await screen.findByText("Voyages");

    fireEvent.click(screen.getByRole("button", { name: "Réordonner" }));

    const disabled = (label: string) =>
      (screen.getByLabelText(label) as HTMLButtonElement).disabled;
    expect(disabled("Descendre Travail/2026")).toBe(true);
    expect(disabled("Monter Voyages/Asie")).toBe(true);
    expect(disabled("Descendre Voyages/Japon")).toBe(true);
    expect(disabled("Monter Voyages/Japon")).toBe(false);

    fireEvent.click(screen.getByLabelText("Monter Voyages/Japon"));

    await waitFor(() =>
      expect(shown()).toEqual([
        "INBOX",
        "Travail",
        "Travail/2026",
        "Voyages",
        "Voyages/Japon",
        "Voyages/Asie",
      ]),
    );
    expect(storedOrder()).toEqual({ a1: ["Voyages/Japon", "Voyages/Asie"] });
  });
});
