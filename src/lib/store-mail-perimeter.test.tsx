import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const { notifyNewMail, setUnreadBadge } = vi.hoisted(() => ({
  notifyNewMail: vi.fn(async () => {}),
  setUnreadBadge: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notifyNewMail, setUnreadBadge }));

const ALPHA = "alpha";
const BETA = "beta";
const GAMMA = "gamma";
const SUBJECT: Record<string, string> = {
  [ALPHA]: "Sujet alpha",
  [BETA]: "Sujet beta",
  [GAMMA]: "Sujet gamma",
};
const UNREAD: Record<string, number> = { [ALPHA]: 2, [BETA]: 5, [GAMMA]: 3 };

const apiAccount = (id: string): ApiAccount => ({
  id,
  label: id,
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: `imap.${id}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${id}.test`, port: 465, encryption: "tls" },
  folders: 1,
});

const apiFolder = (accountId: string, path: string, role: ApiFolderRole): ApiFolder => ({
  account_id: accountId,
  path,
  name: path,
  role,
  uidvalidity: 1,
  uidnext: 2,
  last_sync_at: null,
});

const FOLDERS = [
  apiFolder(ALPHA, "INBOX", "inbox"),
  apiFolder(BETA, "INBOX", "inbox"),
  apiFolder(BETA, "Compta", "other"),
];

const apiMessage = (accountId: string): ApiMessage => ({
  account_id: accountId,
  folder_path: "INBOX",
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
  flags: { unread: true, starred: false, answered: false },
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
    unread: 1,
    starred: false,
    encrypted: 0,
    attachments: 0,
    participants: [primary.from.email],
    subject: primary.subject,
    preview: primary.preview,
  };
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

type Calls = {
  threads: string[];
  counts: string[];
  search: string[];
  purge: string[];
  folderDeletes: string[];
};

function mockBackend(options: { withGamma?: boolean; withTrash?: boolean } = {}) {
  const ids = options.withGamma ? [ALPHA, BETA, GAMMA] : [ALPHA, BETA];
  const folders = [
    ...FOLDERS,
    ...(options.withGamma
      ? [apiFolder(GAMMA, "INBOX", "inbox"), apiFolder(GAMMA, "Compta", "other")]
      : []),
    ...(options.withTrash ? ids.map((id) => apiFolder(id, "Corbeille", "trash")) : []),
  ];
  const calls: Calls = { threads: [], counts: [], search: [], purge: [], folderDeletes: [] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/api/accounts")) return reply(ids.map(apiAccount));
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/purge")) {
      calls.purge.push(/\/api\/accounts\/([^/]+)\/purge$/.exec(path)?.[1] ?? "");
      return reply({ removed: 0 });
    }
    if (path.endsWith("/folder-counts")) {
      const accountId = /\/api\/accounts\/([^/]+)\/folder-counts$/.exec(path)?.[1] ?? "";
      calls.counts.push(accountId);
      return reply([{ path: "INBOX", total: 10, unread: UNREAD[accountId] ?? 0 }]);
    }
    if (path.endsWith("/search")) {
      calls.search.push(/\/api\/accounts\/([^/]+)\/search$/.exec(path)?.[1] ?? "");
      return reply([] as ApiMessage[]);
    }
    const folderDelete = /\/api\/accounts\/([^/]+)\/folders\/([^/]+)$/.exec(path);
    if (folderDelete) {
      calls.folderDeletes.push(`${folderDelete[1]}:${folderDelete[2]}`);
      return reply({});
    }
    const match = /\/api\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    const [, accountId, folderPath] = match;
    if (folderPath === undefined) {
      return reply(folders.filter((entry) => entry.account_id === accountId));
    }
    calls.threads.push(`${accountId}:${folderPath}`);
    return reply(folderPath === "INBOX" ? [apiThread(accountId)] : []);
  });
  return calls;
}

class FakeEventSource {
  static current: FakeEventSource | null = null;
  private listeners: Record<string, ((event: MessageEvent<string>) => void)[]> = {};
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  close() {}
  constructor() {
    FakeEventSource.current = this;
  }
  emit(type: string, payload: unknown) {
    for (const listener of this.listeners[type] ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
  }
}

const arrival = (accountId: string, inserted = 1) => ({
  type: "mail",
  account_id: accountId,
  folder_path: "INBOX",
  report: { folder_path: "INBOX", inserted, flags_updated: 0, removed: 0 },
});

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PrefsProvider>
      <PlanningProvider storage={createMemoryStorage()}>
        <MailStoreProvider>{children}</MailStoreProvider>
      </PlanningProvider>
    </PrefsProvider>
  );
  return renderHook(() => ({ store: useMailStore(), prefs: usePrefs() }), { wrapper });
}

const storePerimeters = (perimeters: Record<string, unknown>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters }));

beforeEach(() => {
  window.localStorage.clear();
  FakeEventSource.current = null;
  notifyNewMail.mockClear();
  setUnreadBadge.mockClear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("périmètre mails · boîte", () => {
  it("retire le compte coupé de la boîte sans le retirer des réglages", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    const calls = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.mails).toHaveLength(1));

    expect(result.current.store.accounts.map((entry) => entry.id)).toEqual([ALPHA, BETA]);
    expect(result.current.store.mailAccounts.map((entry) => entry.id)).toEqual([ALPHA]);
    expect(result.current.store.accountById(BETA)?.id).toBe(BETA);
    expect(calls.threads.length).toBeGreaterThan(0);
    expect(calls.threads.every((entry) => entry.startsWith(`${ALPHA}:`))).toBe(true);
    expect(result.current.store.mails.map((mail) => mail.subject)).toEqual([SUBJECT[ALPHA]]);
  });

  it("n'offre pas les dossiers du compte coupé", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.folderOptions.length).toBeGreaterThan(0));

    expect(result.current.store.folderOptions.map((option) => option.path)).toEqual(["INBOX"]);
  });

  it("exclut le non-lu du compte coupé des compteurs agrégés", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.folderStats("inbox").unread).toBe(UNREAD[ALPHA]));

    expect(result.current.store.folderStats("inbox")).toEqual({ total: 10, unread: UNREAD[ALPHA] });
    expect(result.current.store.accountUnread(ALL_ACCOUNTS)).toBe(UNREAD[ALPHA]);
  });

  it("ne relève plus les compteurs du compte coupé", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    const calls = mockBackend();
    mount();

    await waitFor(() => expect(calls.counts.length).toBeGreaterThan(0));

    expect(calls.counts.every((id) => id === ALPHA)).toBe(true);
  });

  it("badge système · seul le non-lu des comptes visibles compte", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend();
    mount();

    await waitFor(() => expect(setUnreadBadge).toHaveBeenLastCalledWith(UNREAD[ALPHA]));

    expect(setUnreadBadge).not.toHaveBeenCalledWith(UNREAD[ALPHA] + UNREAD[BETA]);
  });

  it("replie sur le seul compte visible un compte coupé pendant sa consultation", async () => {
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.account).toBe(ALL_ACCOUNTS));
    act(() => result.current.store.setAccount(BETA));
    await waitFor(() => expect(result.current.store.mails.map((mail) => mail.subject)).toEqual([SUBJECT[BETA]]));

    act(() => result.current.prefs.setAccountPerimeter(BETA, { mails: false }));

    await waitFor(() => expect(result.current.store.account).toBe(ALPHA));
    await waitFor(() => expect(result.current.store.mails.map((mail) => mail.subject)).toEqual([SUBJECT[ALPHA]]));
  });

  it("ne reste pas sur « tous les comptes » quand un seul compte est visible", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.account).toBe(ALPHA));

    expect(result.current.store.mailAccounts.map((entry) => entry.id)).toEqual([ALPHA]);
  });

  it("garde « tous les comptes » quand plusieurs comptes restent visibles", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend({ withGamma: true });
    const { result } = mount();

    await waitFor(() => expect(result.current.store.mails).toHaveLength(2));

    expect(result.current.store.account).toBe(ALL_ACCOUNTS);
    expect(result.current.store.mailAccounts.map((entry) => entry.id)).toEqual([ALPHA, GAMMA]);
  });

  it("fait revenir le compte réactivé dans la boîte", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.mails).toHaveLength(1));
    expect(result.current.store.mailAccounts.map((entry) => entry.id)).toEqual([ALPHA]);

    act(() => result.current.prefs.setAccountPerimeter(BETA, { mails: true }));

    await waitFor(() =>
      expect(result.current.store.mailAccounts.map((entry) => entry.id)).toEqual([ALPHA, BETA]),
    );
    act(() => result.current.store.setAccount(ALL_ACCOUNTS));
    await waitFor(() =>
      expect(result.current.store.mails.map((mail) => mail.subject).sort()).toEqual([
        SUBJECT[ALPHA],
        SUBJECT[BETA],
      ]),
    );
  });
});

describe("périmètre mails · actions globales", () => {
  it("vide la corbeille des seuls comptes visibles", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    const calls = mockBackend({ withGamma: true, withTrash: true });
    const { result } = mount();

    await waitFor(() => expect(result.current.store.account).toBe(ALL_ACCOUNTS));
    await waitFor(() =>
      expect(result.current.store.folderOptions.some((option) => option.id === "trash")).toBe(true),
    );
    act(() => result.current.store.emptyTrash());

    await waitFor(() => expect(calls.purge.sort()).toEqual([ALPHA, GAMMA]));
    expect(calls.purge).not.toContain(BETA);
  });

  it("ne cherche pas dans le compte coupé", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    const calls = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    await act(async () => {
      await result.current.store.searchMails("camille");
    });

    expect(calls.search).toEqual([ALPHA]);
  });

  it("ne supprime pas le dossier du compte coupé", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    const calls = mockBackend({ withGamma: true });
    const { result } = mount();

    await waitFor(() => expect(result.current.store.account).toBe(ALL_ACCOUNTS));
    await waitFor(() =>
      expect(result.current.store.folderOptions.some((option) => option.path === "Compta")).toBe(true),
    );
    let deleted = false;
    await act(async () => {
      deleted = await result.current.store.deleteFolder("Compta", "Compta");
    });

    expect(deleted).toBe(true);
    expect(calls.folderDeletes).toEqual([`${GAMMA}:Compta`]);
  });
});

describe("périmètre mails · notifications live", () => {
  it("se tait pour un compte hors périmètre, pas pour les autres", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mockBackend();
    vi.stubGlobal("EventSource", FakeEventSource);
    mount();
    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());

    const source = FakeEventSource.current as FakeEventSource;
    source.emit("mail", arrival(BETA));
    source.emit("mail", arrival(ALPHA));

    await waitFor(() => expect(notifyNewMail).toHaveBeenCalledTimes(1));
    expect(notifyNewMail).toHaveBeenCalledWith("Nouveau message · alpha", "Vous avez reçu un nouveau message.");
  });
});
