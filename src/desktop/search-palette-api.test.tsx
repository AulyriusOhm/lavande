import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopSearch } from "@/desktop/search";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const ALPHA = "alpha";

const account: ApiAccount = {
  id: ALPHA,
  label: "Perso",
  email: "perso@test.fr",
  username: "perso@test.fr",
  imap: { host: "imap.test.fr", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test.fr", port: 465, encryption: "tls" },
  folders: 2,
};

const folder = (path: string, role: ApiFolderRole): ApiFolder => ({
  account_id: ALPHA,
  path,
  name: path,
  role,
  uidvalidity: 1,
  uidnext: 2,
  last_sync_at: null,
});

const FOLDERS = [folder("INBOX", "inbox"), folder("Projets", "other")];

const message = (uid: number, folderPath = "INBOX"): ApiMessage => ({
  account_id: ALPHA,
  folder_path: folderPath,
  uid,
  uidvalidity: 1,
  thread_id: `t-${uid}`,
  message_id: `<${uid}@test.fr>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: "perso@test.fr" }],
  cc: [],
  subject: `Facture ${uid}`,
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "Aperçu de la facture",
  body_text: "Corps",
  body_html: null,
  attachments: [],
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

let searches: URLSearchParams[] = [];
let answer: (params: URLSearchParams) => ApiMessage[] = () => [];

function mockBackend() {
  searches = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/api/accounts")) return reply([account]);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path.endsWith("/search")) {
      searches.push(searchParams);
      return reply(answer(searchParams));
    }
    const match = /\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    if (match[2] === undefined) return reply(FOLDERS);
    return reply([]);
  });
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return render(<DesktopSearch open onClose={() => {}} />, { wrapper });
}

const input = () => screen.getByLabelText("Rechercher dans tous les comptes");
const status = () => screen.getByRole("status").textContent ?? "";

function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("palette PC · pagination", () => {
  it("charge la page suivante quand la première est pleine", async () => {
    mockBackend();
    answer = (params) =>
      params.get("offset") === null
        ? Array.from({ length: 50 }, (_, index) => message(index + 1))
        : [message(99)];
    mount();

    type("facture");
    await waitFor(() => expect(status()).toBe("50 résultats pour « facture »"));

    fireEvent.click(screen.getByRole("button", { name: "Charger plus" }));

    await waitFor(() => expect(status()).toBe("51 résultats pour « facture »"));
    expect(searches[0].get("q")).toBe("facture");
    expect(searches[1].get("offset")).toBe("50");
    expect(screen.queryByRole("button", { name: "Charger plus" })).toBeNull();
  });
});

describe("palette PC · étiquette de dossier", () => {
  it("nomme le dossier personnalisé au lieu de « Boîte de réception »", async () => {
    mockBackend();
    answer = () => [message(1, "Projets")];
    mount();

    type("facture");
    await waitFor(() => expect(status()).toBe("1 résultat pour « facture »"));

    expect(screen.getByText("Projets")).toBeTruthy();
    expect(screen.queryByText("Boîte de réception")).toBeNull();
  });
});
