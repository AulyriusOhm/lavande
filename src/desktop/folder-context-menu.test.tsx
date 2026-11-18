import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesktopInbox } from "@/desktop/inbox";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder, ApiFolderCount, ApiMessage, ApiThread } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const ALPHA = "alpha";
const INBOX = "INBOX";
const ARCHIVE = "Archive";
const TRASH = "Trash";

const ACCOUNT: ApiAccount = {
  id: ALPHA,
  label: "Alpha",
  email: `${ALPHA}@test.fr`,
  username: `${ALPHA}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 3,
};

const folder = (path: string, role: ApiFolder["role"]): ApiFolder => ({
  account_id: ALPHA,
  path,
  name: path,
  role,
  uidvalidity: 1,
  uidnext: 2,
  last_sync_at: null,
  delimiter: "/",
});

const FOLDERS: ApiFolder[] = [
  folder(INBOX, "inbox"),
  folder(ARCHIVE, "archive"),
  folder(TRASH, "trash"),
];

const MESSAGE: ApiMessage = {
  account_id: ALPHA,
  folder_path: INBOX,
  uid: 7,
  uidvalidity: 1,
  thread_id: "t-1",
  message_id: "<m1@test.fr>",
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: `${ALPHA}@test.fr` }],
  cc: [],
  subject: "Sujet alpha",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: true, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: "Aperçu alpha",
  body_text: "Corps alpha",
  body_html: null,
  attachments: [],
};

const THREAD: ApiThread = {
  id: MESSAGE.thread_id,
  account_id: ALPHA,
  messages: [MESSAGE],
  primary: MESSAGE,
  count: 1,
  unread: 1,
  starred: false,
  encrypted: 0,
  attachments: 0,
  participants: [MESSAGE.from.email],
  subject: MESSAGE.subject,
  preview: MESSAGE.preview,
};

const COUNTS: ApiFolderCount[] = [
  { path: INBOX, total: 1, unread: 1 },
  { path: TRASH, total: 4, unread: 0 },
];

type Call = { path: string; method: string; body: unknown };

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

function stubBackend() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path.endsWith("/api/accounts")) return reply([ACCOUNT]);
    if (path.endsWith("/folder-counts")) return reply(COUNTS);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/purge")) return reply({ removed: 4 });
    if (path.endsWith("/flags-bulk")) return reply(undefined, 204);
    if (path.endsWith("/pgp/keys")) return reply({ keys: [] });
    const folders = /\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (folders) {
      if (folders[2] === undefined) return reply(FOLDERS);
      return reply(folders[2] === INBOX ? [THREAD] : []);
    }
    return reply([]);
  });
  return calls;
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

const rowOf = (path: string) => {
  const row = document.querySelector(`[data-folder-row="${path}"]`);
  if (!row) throw new Error(`ligne absente : ${path}`);
  return row as HTMLElement;
};

const menu = () => screen.queryByRole("menu");
const labels = () =>
  menu()
    ? within(menu()!)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    : [];
const click = (name: string | RegExp) =>
  fireEvent.click(within(menu()!).getByRole("menuitem", { name }));

function rightClick(path: string, x = 150, y = 220) {
  fireEvent.contextMenu(rowOf(path), { clientX: x, clientY: y });
}

async function openRail() {
  render(<DesktopInbox />, { wrapper });
  await waitFor(() => expect(document.querySelector(`[data-folder-row="${INBOX}"]`)).toBeTruthy());
}

const posted = (calls: Call[], suffix: string) =>
  calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

beforeEach(() => {
  window.innerWidth = 1600;
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
});

describe("menu contextuel des dossiers", () => {
  it("s'ouvre au clic droit, ancré au curseur, avec les actions du dossier", async () => {
    stubBackend();
    await openRail();

    rightClick(INBOX);

    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute("aria-label")).toBe("Actions du dossier");
    expect(labels()[0]).toBe("Ouvrir");
    expect(labels()).toContain("Synchroniser ce dossier");
    expect(menu()!.style.left).toBe("150px");
    expect(menu()!.style.top).toBe("220px");
  });

  it("synchronise le dossier visé puis referme le panneau", async () => {
    const calls = stubBackend();
    await openRail();

    rightClick(ARCHIVE);
    click("Synchroniser ce dossier");

    await waitFor(() =>
      expect(posted(calls, "/sync").map((call) => call.body)).toContainEqual({
        folder_path: ARCHIVE,
      }),
    );
    expect(menu()).toBeNull();
  });

  it("vide la corbeille après un premier clic d'armement", async () => {
    const calls = stubBackend();
    await openRail();

    rightClick(TRASH);
    click("Vider la corbeille");

    expect(menu()).not.toBeNull();
    expect(labels()).toContain("Confirmer · 4 messages");
    expect(posted(calls, "/purge").length).toBe(0);

    click("Confirmer · 4 messages");

    await waitFor(() => expect(posted(calls, "/purge").length).toBe(1));
    expect(posted(calls, "/purge")[0].body).toEqual({ folder_path: TRASH });
    expect(menu()).toBeNull();
  });

  it("marque tout lu depuis le dossier actif qui a des non-lus", async () => {
    const calls = stubBackend();
    await openRail();
    await waitFor(() => expect(document.querySelectorAll("[data-mail-row]").length).toBe(1));

    rightClick(INBOX);
    expect(labels()).toContain("Marquer tout lu");

    click("Marquer tout lu");

    await waitFor(() => expect(posted(calls, "/flags-bulk").length).toBe(1));
    expect(posted(calls, "/flags-bulk")[0].body).toEqual({
      folder_path: INBOX,
      uids: [7],
      unread: false,
      starred: false,
    });
    expect(menu()).toBeNull();
  });

  it("se ferme au clic extérieur", async () => {
    stubBackend();
    await openRail();
    rightClick(INBOX);
    expect(menu()).not.toBeNull();

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(menu()).toBeNull());
  });
});
