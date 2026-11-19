import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchScreen } from "@/screens/search-screen";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
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
  folders: 1,
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

const message = (uid: number, unread: boolean): ApiMessage => ({
  account_id: ALPHA,
  folder_path: "INBOX",
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
  flags: { unread, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "Aperçu de la facture",
  body_text: "Corps",
  body_html: null,
  attachments:
    uid === 2 ? [{ filename: "facture.pdf", mime: "application/pdf", size: 10, inline: false }] : [],
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

let searches: URLSearchParams[] = [];
let contactQueries: URLSearchParams[] = [];

const CONTACT = {
  email: "pantaleo.s@grenoble.archi.fr",
  name: "Pantaleo Sanchez",
  received: 4,
  sent: 1,
  last_seen: "2026-11-10T10:00:00Z",
};

function mockBackend() {
  searches = [];
  contactQueries = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/api/accounts")) return reply([account]);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path.endsWith("/api/contacts")) {
      contactQueries.push(searchParams);
      return reply([CONTACT]);
    }
    if (path.endsWith("/search")) {
      searches.push(searchParams);
      const unread = searchParams.get("unread") === "true";
      const attached = searchParams.get("has_attachment") === "true";
      return reply(
        [message(1, true), message(2, false)].filter(
          (entry) => (!unread || entry.flags.unread) && (!attached || entry.attachments.length > 0),
        ),
      );
    }
    const match = /\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    if (match[2] === undefined) return reply([folder("INBOX", "inbox")]);
    return reply([]);
  });
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <ThemeProvider>
          <MailStoreProvider>{children}</MailStoreProvider>
        </ThemeProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return render(
    <SearchScreen
      onOpen={() => {}}
      onToggleStar={() => {}}
      onMailAction={() => {}}
      onReply={() => {}}
    />,
    { wrapper },
  );
}

const input = () => screen.getByLabelText("Rechercher un message ou un contact");
const status = () => screen.getByRole("status").textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recherche mobile · scopes côté démon", () => {
  it("« Non lus » envoie unread=true sans toucher au texte", async () => {
    mockBackend();
    mount();
    fireEvent.change(input(), { target: { value: "facture" } });

    await waitFor(() => expect(searches).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Non lus" }));

    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1].get("q")).toBe("facture");
    expect(searches[1].get("unread")).toBe("true");
    await waitFor(() => expect(status()).toBe("1 résultat pour « facture »"));
  });

  it("« Fichiers » envoie has_attachment=true", async () => {
    mockBackend();
    mount();
    fireEvent.change(input(), { target: { value: "facture" } });

    await waitFor(() => expect(searches).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Fichiers" }));

    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1].get("has_attachment")).toBe("true");
    expect(searches[1].get("unread")).toBeNull();
  });

  it("« Contacts » interroge le carnet du démon", async () => {
    mockBackend();
    mount();
    fireEvent.change(input(), { target: { value: "panta" } });
    await waitFor(() => expect(searches).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Contacts" }));

    await waitFor(() =>
      expect(contactQueries[contactQueries.length - 1]?.get("q")).toBe("panta"),
    );
    await waitFor(() => expect(status()).toBe("1 contact pour « panta »"));
    expect(screen.getByText("Pantaleo Sanchez")).toBeTruthy();
    expect(screen.getByText("pantaleo.s@grenoble.archi.fr")).toBeTruthy();
  });

  it("revient au tout-venant en quittant le scope", async () => {
    mockBackend();
    mount();
    fireEvent.change(input(), { target: { value: "facture" } });

    await waitFor(() => expect(searches).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Non lus" }));
    await waitFor(() => expect(searches).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Tout" }));

    await waitFor(() => expect(searches).toHaveLength(3));
    expect(searches[2].get("unread")).toBeNull();
    expect(searches[2].get("has_attachment")).toBeNull();
  });
});

describe("recherche mobile · promesse marketing", () => {
  it("n'annonce plus de recherche en langage naturel et liste les opérateurs", () => {
    mockBackend();
    mount();

    expect(screen.queryByText(/langage naturel/i)).toBeNull();
    expect(screen.getByText("Opérateurs de recherche")).toBeTruthy();
    expect(screen.getByText(/from: to: subject: in:/)).toBeTruthy();
  });
});
