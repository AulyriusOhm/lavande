import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, ApiFolder, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const BETA = "beta";
const INBOX: Record<string, string> = { [ALPHA]: "INBOX", [BETA]: "Boîte de réception" };
const SUBJECT: Record<string, string> = { [ALPHA]: "Sujet alpha", [BETA]: "Sujet beta" };

const apiAccount = (id: string): ApiAccount => ({
  id,
  label: id,
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: `imap.${id}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${id}.test`, port: 465, encryption: "tls" },
  folders: 1,
});

const apiFolder = (accountId: string): ApiFolder => ({
  account_id: accountId,
  path: INBOX[accountId],
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 2,
  last_sync_at: null,
});

const apiMessage = (accountId: string): ApiMessage => ({
  account_id: accountId,
  folder_path: INBOX[accountId],
  uid: 1,
  uidvalidity: 1,
  thread_id: `t-${accountId}`,
  message_id: `<${accountId}@test.fr>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: `camille@${accountId}.test` },
  to: [{ name: null, email: `${accountId}@test.fr` }],
  cc: [],
  subject: SUBJECT[accountId],
  date: "2026-01-05T10:00:00Z",
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: `Aperçu ${accountId}`,
  body_text: `Corps ${accountId}`,
  body_html: null,
  attachments: [],
});

const apiThread = (accountId: string): ApiThread => {
  const primary = apiMessage(accountId);
  return {
    id: primary.thread_id,
    account_id: accountId,
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

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, statusText: "", json: async () => body }) as unknown as Response;

function mockBackend(options: { failing?: string } = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/api/accounts")) return reply([apiAccount(ALPHA), apiAccount(BETA)]);
    const match = path.match(/\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    const [, accountId, folderPath] = match;
    if (folderPath === undefined) return reply([apiFolder(accountId)]);
    if (options.failing === accountId) return reply({ error: "échec IMAP simulé", kind: "imap" }, 502);
    return reply([apiThread(accountId)]);
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

describe("boîte unifiée en mode api", () => {
  it("charge les messages de tous les comptes sur « Tous les comptes »", async () => {
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.account).toBe(ALL_ACCOUNTS));
    await waitFor(() => expect(result.current.mails).toHaveLength(2));

    expect(result.current.mails.map((mail) => mail.subject).sort()).toEqual([
      SUBJECT[ALPHA],
      SUBJECT[BETA],
    ]);
    expect(result.current.mails.map((mail) => mail.account).sort()).toEqual([ALPHA, BETA]);
  });

  it("ne garde que les messages du compte sélectionné", async () => {
    mockBackend();
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));

    act(() => result.current.setAccount(ALPHA));

    await waitFor(() => {
      expect(result.current.mails).toHaveLength(1);
      expect(result.current.mails[0]?.account).toBe(ALPHA);
      expect(result.current.mails[0]?.subject).toBe(SUBJECT[ALPHA]);
    });
  });

  it("affiche le compte sain et une seule notice quand un compte échoue", async () => {
    mockBackend({ failing: BETA });
    const { result } = mount();

    await waitFor(() => {
      expect(result.current.mails).toHaveLength(1);
      expect(result.current.mails[0]?.subject).toBe(SUBJECT[ALPHA]);
    });

    await waitFor(() => expect(result.current.notices).toHaveLength(1));
    expect(result.current.notices[0]?.message).toBe("imap · échec IMAP simulé");
  });
});
