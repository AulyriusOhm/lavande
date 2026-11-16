import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
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
    const pgpMatch = path.match(/\/api\/accounts\/([^/]+)\/pgp$/);
    if (pgpMatch) return reply(apiAccount(pgpMatch[1]));
    const syncMatch = path.match(/\/api\/accounts\/([^/]+)\/sync$/);
    if (syncMatch) {
      const accountId = syncMatch[1];
      if (options.failing === accountId) return reply({ error: "échec IMAP simulé", kind: "imap" }, 502);
      return reply({ reports: [] });
    }
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

type FolderFixture = {
  accountId: string;
  path: string;
  role: ApiFolderRole;
  total: number;
  unread: number;
};

const FOLDER_FIXTURE: FolderFixture[] = [
  { accountId: ALPHA, path: "INBOX", role: "inbox", total: 10, unread: 2 },
  { accountId: ALPHA, path: "Sent", role: "sent", total: 4, unread: 0 },
  { accountId: ALPHA, path: "Projets", role: "other", total: 3, unread: 1 },
  { accountId: ALPHA, path: "Corbeille", role: "trash", total: 5, unread: 5 },
  { accountId: ALPHA, path: "Spam", role: "spam", total: 2, unread: 2 },
  { accountId: BETA, path: "INBOX", role: "inbox", total: 7, unread: 3 },
  { accountId: BETA, path: "Projets", role: "other", total: 1, unread: 1 },
  { accountId: BETA, path: "Corbeille", role: "trash", total: 2, unread: 2 },
];

function mockFolders() {
  const threads: string[] = [];
  const syncs: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    if (path.endsWith("/api/accounts")) return reply([apiAccount(ALPHA), apiAccount(BETA)]);
    if (path.endsWith("/sync")) {
      const accountId = /\/api\/accounts\/([^/]+)\/sync$/.exec(path)?.[1] ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as { folder_path?: string };
      syncs.push(`${accountId}:${body.folder_path ?? ""}`);
      return reply({ reports: [] });
    }
    if (path.endsWith("/folder-counts")) {
      const accountId = /\/api\/accounts\/([^/]+)\/folder-counts$/.exec(path)?.[1] ?? "";
      return reply(
        FOLDER_FIXTURE.filter((entry) => entry.accountId === accountId).map((entry) => ({
          path: entry.path,
          total: entry.total,
          unread: entry.unread,
        })),
      );
    }
    const match = /\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    const [, accountId, folderPath] = match;
    if (folderPath === undefined) {
      return reply(
        FOLDER_FIXTURE.filter((entry) => entry.accountId === accountId).map((entry) => ({
          account_id: entry.accountId,
          path: entry.path,
          name: entry.path,
          role: entry.role,
          uidvalidity: 1,
          uidnext: 2,
          last_sync_at: null,
        })),
      );
    }
    threads.push(`${accountId}:${folderPath}`);
    return reply([]);
  });
  return { threads, syncs };
}

function mountStore() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return renderHook(() => ({ store: useMailStore(), prefs: usePrefs() }), { wrapper });
}

describe("boîte unifiée · dossiers et compteurs", () => {
  it("atterrit sur la boîte unifiée, en tête de la liste des dossiers", async () => {
    mockFolders();
    const { result } = mountStore();

    await waitFor(() => expect(result.current.store.account).toBe(ALL_ACCOUNTS));
    await waitFor(() => expect(result.current.store.folder).toBe("unified"));

    expect(result.current.store.folderOptions[0]).toEqual({
      id: "unified",
      label: "Boîte unifiée",
      path: "unified",
      delimiter: null,
    });
  });

  it("charge les fils de tous les dossiers sauf corbeille et spam", async () => {
    const calls = mockFolders();
    const { result } = mountStore();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    await waitFor(() => expect(calls.threads.length).toBeGreaterThan(0));

    expect(new Set(calls.threads)).toEqual(
      new Set([
        `${ALPHA}:INBOX`,
        `${ALPHA}:Sent`,
        `${ALPHA}:Projets`,
        `${BETA}:INBOX`,
        `${BETA}:Projets`,
      ]),
    );
  });

  it("ne synchronise automatiquement que la réception en boîte unifiée", async () => {
    const calls = mockFolders();
    const { result } = mountStore();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    await waitFor(() => expect(calls.syncs).toContain(`${ALPHA}:INBOX`));
    await waitFor(() => expect(calls.syncs).toContain(`${BETA}:INBOX`));

    expect(new Set(calls.syncs)).toEqual(new Set([`${ALPHA}:INBOX`, `${BETA}:INBOX`]));
  });

  it("additionne les compteurs des dossiers inclus", async () => {
    mockFolders();
    const { result } = mountStore();

    await waitFor(() =>
      expect(result.current.store.folderStats("unified")).toEqual({ total: 25, unread: 7 }),
    );
    expect(result.current.store.folderStats("inbox")).toEqual({ total: 17, unread: 5 });
  });

  it("retire le dossier masqué des cibles et des compteurs", async () => {
    const calls = mockFolders();
    const { result } = mountStore();
    await waitFor(() => expect(result.current.store.folderStats("unified").total).toBe(25));

    calls.threads.length = 0;
    act(() => result.current.prefs.setFolderHidden(BETA, "Projets", true));

    await waitFor(() =>
      expect(result.current.store.folderStats("unified")).toEqual({ total: 24, unread: 6 }),
    );
    await waitFor(() => expect(calls.threads.length).toBeGreaterThan(0));
    expect(calls.threads).not.toContain(`${BETA}:Projets`);
  });

  it("revient à la réception d'un compte unique et refuse alors la boîte unifiée", async () => {
    mockFolders();
    const { result } = mountStore();
    await waitFor(() => expect(result.current.store.folder).toBe("unified"));

    act(() => result.current.store.setAccount(ALPHA));

    await waitFor(() => expect(result.current.store.folder).toBe("inbox"));
    expect(result.current.store.folderOptions.some((option) => option.id === "unified")).toBe(false);

    act(() => result.current.store.setFolder("unified"));
    expect(result.current.store.folder).toBe("inbox");
  });

  it("revient sur la boîte unifiée en repassant sur tous les comptes", async () => {
    mockFolders();
    const { result } = mountStore();
    await waitFor(() => expect(result.current.store.folder).toBe("unified"));

    act(() => result.current.store.setAccount(ALPHA));
    await waitFor(() => expect(result.current.store.folder).toBe("inbox"));

    act(() => result.current.store.setAccount(ALL_ACCOUNTS));

    await waitFor(() => expect(result.current.store.folder).toBe("unified"));
  });
});
