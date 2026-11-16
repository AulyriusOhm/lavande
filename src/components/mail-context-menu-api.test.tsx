import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MailContextMenu } from "@/components/mail-context-menu";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

const ALPHA = "alpha";
const INBOX = "INBOX";
const ARCHIVE = "Archive";

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
});

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
  cc: [{ name: null, email: "marc@test.fr" }],
  subject: "Sujet alpha",
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
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
  unread: 0,
  starred: false,
  encrypted: 0,
  attachments: 0,
  participants: [MESSAGE.from.email],
  subject: MESSAGE.subject,
  preview: MESSAGE.preview,
};

type Call = { path: string; method: string; body: unknown };

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path.endsWith("/api/accounts")) return reply([ACCOUNT]);
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    const folders = /\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (folders) {
      if (folders[2] === undefined) {
        return reply([folder(INBOX, "inbox"), folder(ARCHIVE, "archive"), folder("Trash", "trash")]);
      }
      return reply(folders[2] === INBOX ? [THREAD] : []);
    }
    if (path.endsWith("/move") || path.endsWith("/flags")) return reply(undefined, 204);
    throw new Error(`requête inattendue : ${method} ${path}`);
  });
  return calls;
}

function Harness({ onClose }: { onClose: () => void }) {
  const { mails } = useMailStore();
  const mail = mails[0];
  if (!mail) return null;
  return <MailContextMenu mail={mail} ancre={{ x: 10, y: 10 }} onClose={onClose} />;
}

function mount(onClose = () => {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  render(<Harness onClose={onClose} />, { wrapper });
}

const click = (name: string) =>
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("menu contextuel branché sur le démon", () => {
  it("« Archiver » envoie le déplacement existant puis referme", async () => {
    const calls = mockBackend();
    const onClose = vi.fn();
    mount(onClose);

    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    click("Archiver");

    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith("/move"))).toEqual({
        path: `/api/accounts/${ALPHA}/move`,
        method: "POST",
        body: { from_path: INBOX, uid: 7, to_path: ARCHIVE },
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("« Marquer non lu » envoie les drapeaux du message", async () => {
    const calls = mockBackend();
    mount();

    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    click("Marquer non lu");

    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith("/flags"))).toEqual({
        path: `/api/accounts/${ALPHA}/flags`,
        method: "POST",
        body: { folder_path: INBOX, uid: 7, unread: true, starred: false },
      }),
    );
  });
});
