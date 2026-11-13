import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const ACCOUNT: ApiAccount = {
  id: "a1",
  label: "Perso",
  email: "roman@lavande.mail",
  username: "roman",
  imap: { host: "imap.lavande.mail", port: 993, encryption: "tls" },
  smtp: { host: "smtp.lavande.mail", port: 465, encryption: "tls" },
  folders: 3,
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
  folder("Projets", "Projets", "other"),
  folder("Projets/2026", "2026", "other"),
];

const MESSAGE = (body: string | null): ApiMessage => ({
  account_id: "a1",
  folder_path: "INBOX",
  uid: 7,
  uidvalidity: 7,
  thread_id: "t1",
  message_id: null,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@lavande.mail" },
  to: [],
  cc: [],
  subject: "Planning de la phase 2",
  date: "2026-03-12T10:00:00Z",
  flags: { unread: true, starred: false, answered: false },
  size: 2048,
  pgp: "none",
  pgp_detail: null,
  preview: body === null ? "" : body,
  body_text: body,
  body_html: null,
  attachments: [],
});

const THREAD: ApiThread = {
  id: "t1",
  account_id: "a1",
  messages: [MESSAGE(null)],
  primary: MESSAGE(null),
  count: 1,
  unread: 1,
  starred: false,
  encrypted: 0,
  attachments: 0,
  participants: ["Camille"],
  subject: "Planning de la phase 2",
  preview: "",
};

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function stubBackend(onBody: (resolve: (value: Response) => void) => void) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === "/api/accounts") return response([ACCOUNT]);
    if (url === "/api/accounts/a1/folders") return response(FOLDERS);
    if (url.endsWith("/folder-counts")) return response([]);
    if (url.includes("/threads?")) return response([THREAD]);
    if (url.includes("/messages/7")) {
      return new Promise<Response>((resolve) => onBody(resolve));
    }
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

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("rail des dossiers · arbre", () => {
  function mountRail() {
    stubBackend(() => {});
    return render(<DesktopInbox />, { wrapper });
  }

  it("range les sous-dossiers sous leur parent", async () => {
    mountRail();

    const parent = await screen.findByRole("button", { name: /^Projets/ });
    const child = screen.getByRole("button", { name: "2026" });
    expect(child.closest("div")?.style.paddingLeft).toBe("14px");
    expect(parent.closest("div")?.style.paddingLeft).toBe("");
  });

  it("replie puis déplie un palier", async () => {
    mountRail();

    fireEvent.click(await screen.findByLabelText("Replier Projets"));
    expect(screen.queryByRole("button", { name: "2026" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Déplier Projets"));
    expect(screen.getByRole("button", { name: "2026" })).toBeTruthy();
  });

  it("sélectionne un sous-dossier au clic", async () => {
    mountRail();

    fireEvent.click(await screen.findByRole("button", { name: "2026" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "2026" }).getAttribute("aria-current")).toBe("true"),
    );
  });
});

describe("corps à la demande · état de chargement", () => {
  it("affiche un chargement puis le corps relu sur le serveur", async () => {
    let deliver: ((value: Response) => void) | null = null;
    stubBackend((resolve) => {
      deliver = resolve;
    });
    render(<DesktopInbox />, { wrapper });

    fireEvent.click(await screen.findByRole("button", { name: /Camille — Planning de la phase 2/ }));

    expect(await screen.findByText("Chargement du message…")).toBeTruthy();

    await waitFor(() => expect(deliver).not.toBeNull());
    deliver?.(response(MESSAGE("La phase 2 démarre lundi, voici le planning.")));

    expect(await screen.findByText("La phase 2 démarre lundi, voici le planning.")).toBeTruthy();
    expect(screen.queryByText("Chargement du message…")).toBeNull();
  });
});
