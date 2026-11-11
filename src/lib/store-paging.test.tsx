import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const FIRST_PAGE = 50;
const SECOND_PAGE = 3;

const apiAccount = (): ApiAccount => ({
  id: ALPHA,
  label: ALPHA,
  email: `${ALPHA}@test.fr`,
  username: `${ALPHA}@test.fr`,
  imap: { host: `imap.${ALPHA}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${ALPHA}.test`, port: 465, encryption: "tls" },
  folders: 1,
});

const apiFolder = (): ApiFolder => ({
  account_id: ALPHA,
  path: "INBOX",
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 2,
  last_sync_at: null,
});

const apiMessage = (uid: number): ApiMessage => ({
  account_id: ALPHA,
  folder_path: "INBOX",
  uid,
  uidvalidity: 1,
  thread_id: `t-${uid}`,
  message_id: `<${uid}@test.fr>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: "camille@test.fr" },
  to: [{ name: null, email: `${ALPHA}@test.fr` }],
  cc: [],
  subject: `Sujet ${uid}`,
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: `Aperçu ${uid}`,
  body_text: `Corps ${uid}`,
  body_html: null,
  attachments: [],
});

const apiThread = (uid: number): ApiThread => {
  const primary = apiMessage(uid);
  return {
    id: primary.thread_id,
    account_id: ALPHA,
    messages: [primary],
    primary,
    count: 1,
    unread: 0,
    starred: false,
    encrypted: 0,
    attachments: 0,
    participants: [primary.from.email],
    subject: primary.subject,
    preview: primary.preview,
  };
};

const THREADS = Array.from({ length: FIRST_PAGE + SECOND_PAGE }, (_, index) => apiThread(index + 1));

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend() {
  const offsets: number[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/api/accounts")) return reply([apiAccount()]);
    const match = path.match(/\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    const [, , folderPath] = match;
    if (folderPath === undefined) return reply([apiFolder()]);
    const limit = Number(searchParams.get("limit"));
    const offset = Number(searchParams.get("offset"));
    offsets.push(offset);
    return reply(THREADS.slice(offset, offset + limit));
  });
  return offsets;
}

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return renderHook(() => useMailStore(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pagination des fils en mode api", () => {
  it("charge la première page puis la suivante", async () => {
    const offsets = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.mails).toHaveLength(FIRST_PAGE));
    expect(result.current.pages).toBe(1);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.mails).toHaveLength(FIRST_PAGE + SECOND_PAGE));
    expect(result.current.hasMore).toBe(false);
    expect(offsets).toEqual([0, 0, FIRST_PAGE]);
  });
});
