import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// Le drapeau de la démo vitrine est évalué au chargement des modules : ce mock
// le rend pilotable pour éprouver le refus en lecture seule dans ce fichier.
const readonly = vi.hoisted(() => ({ on: false }));

vi.mock("@/lib/demo-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-mode")>();
  return {
    ...actual,
    get demoReadOnly() {
      return readonly.on;
    },
  };
});

import { ALL_ACCOUNTS } from "@/lib/accounts";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage, ApiThread } from "@/lib/api";
import { mailApi } from "@/lib/api";
import type { Mail } from "@/lib/mail";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const ALPHA = "alpha";
const BETA = "beta";
const INBOX = "INBOX";
const ARCHIVE = "Archive";
const TRASH = "Corbeille";

const apiAccount = (id: string): ApiAccount => ({
  id,
  label: id,
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: `imap.${id}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${id}.test`, port: 465, encryption: "tls" },
  folders: 3,
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

const apiMessage = (
  accountId: string,
  uid: number,
  overrides: Partial<ApiMessage> = {},
): ApiMessage => ({
  account_id: accountId,
  folder_path: INBOX,
  uid,
  uidvalidity: 1,
  thread_id: `t-${accountId}-${uid}`,
  message_id: `<${accountId}-${uid}@test.fr>`,
  in_reply_to: null,
  references: [],
  from: { name: "Camille", email: `camille@${accountId}.test` },
  to: [{ name: null, email: `${accountId}@test.fr` }],
  cc: [],
  subject: `Sujet ${uid}`,
  date: "2026-01-05T10:00:00Z",
  flags: { unread: true, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: `Aperçu ${uid}`,
  body_text: `Corps ${uid}`,
  body_html: null,
  attachments: [],
  ...overrides,
});

const apiThread = (message: ApiMessage): ApiThread => ({
  id: message.thread_id,
  account_id: message.account_id,
  messages: [message],
  primary: message,
  count: 1,
  unread: message.flags.unread ? 1 : 0,
  starred: message.flags.starred,
  encrypted: 0,
  attachments: 0,
  participants: [message.from.email],
  subject: message.subject,
  preview: message.preview,
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

type Backend = {
  /** Chemins décodés vus par le faux démon. */
  calls: string[];
  /** Messages servis par dossier, clé `compte:chemin`. */
  threads: Record<string, ApiMessage[]>;
};

const inboxThreads = (accountId: string): Record<string, ApiMessage[]> => ({
  [`${accountId}:${INBOX}`]: [apiMessage(accountId, 1), apiMessage(accountId, 2)],
});

function mockBackend(options: { accounts?: string[]; threads?: Record<string, ApiMessage[]> } = {}): Backend {
  const ids = options.accounts ?? [ALPHA];
  const backend: Backend = { calls: [], threads: options.threads ?? inboxThreads(ALPHA) };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    backend.calls.push(path);
    if (path === "/api/accounts") return reply(ids.map(apiAccount));
    if (path.endsWith("/folder-counts")) return reply([{ path: INBOX, total: 2, unread: 2 }]);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/search")) return reply([]);
    const threads = /\/api\/accounts\/([^/]+)\/folders\/([^/]+)\/threads$/.exec(path);
    if (threads) {
      return reply((backend.threads[`${threads[1]}:${threads[2]}`] ?? []).map(apiThread));
    }
    const folders = /\/api\/accounts\/([^/]+)\/folders$/.exec(path);
    if (folders) {
      return reply([
        apiFolder(folders[1], INBOX, "inbox"),
        apiFolder(folders[1], ARCHIVE, "archive"),
        apiFolder(folders[1], TRASH, "trash"),
      ]);
    }
    return reply([]);
  });
  return backend;
}

const synthetic = (accountId: string, count: number): Mail[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${accountId}:${INBOX}:${index + 1}`,
    account: accountId,
    folder: "inbox" as const,
    source: { accountId, folderPath: INBOX, uid: index + 1 },
    name: "Camille",
    email: `camille@${accountId}.test`,
    subject: `Sujet ${index + 1}`,
    preview: "Aperçu",
    body: [],
    time: "10:00",
    unread: true,
    starred: false,
    pgp: "none" as const,
    tone: 0,
  }));

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
  window.localStorage.clear();
  readonly.on = false;
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("actions groupées · drapeaux", () => {
  it("marque lu sans toucher à l'étoile", async () => {
    mockBackend();
    const bulkFlags = vi.spyOn(mailApi, "bulkFlags").mockResolvedValue(undefined);
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));
    expect(result.current.folderStats("inbox").unread).toBe(2);

    act(() => result.current.bulkMailAction("read", result.current.mails));

    expect(result.current.mails.every((mail) => !mail.unread)).toBe(true);
    expect(result.current.mails.every((mail) => !mail.starred)).toBe(true);
    expect(result.current.folderStats("inbox").unread).toBe(0);
    await waitFor(() => expect(bulkFlags).toHaveBeenCalledTimes(1));
    expect(bulkFlags).toHaveBeenCalledWith(ALPHA, {
      folder_path: INBOX,
      uids: [1, 2],
      unread: false,
      starred: false,
    });
  });

  it("étoile sans toucher au non-lu", async () => {
    mockBackend();
    const bulkFlags = vi.spyOn(mailApi, "bulkFlags").mockResolvedValue(undefined);
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));

    act(() => result.current.bulkMailAction("star", result.current.mails));

    expect(result.current.mails.every((mail) => mail.starred)).toBe(true);
    expect(result.current.mails.every((mail) => mail.unread)).toBe(true);
    expect(result.current.folderStats("inbox").unread).toBe(2);
    await waitFor(() =>
      expect(bulkFlags).toHaveBeenCalledWith(ALPHA, {
        folder_path: INBOX,
        uids: [1, 2],
        unread: true,
        starred: true,
      }),
    );
  });

  it("groupe par compte : deux comptes, deux appels", async () => {
    mockBackend({
      accounts: [ALPHA, BETA],
      threads: { [`${ALPHA}:${INBOX}`]: [apiMessage(ALPHA, 1)], [`${BETA}:${INBOX}`]: [apiMessage(BETA, 1)] },
    });
    const bulkFlags = vi.spyOn(mailApi, "bulkFlags").mockResolvedValue(undefined);
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));
    expect(result.current.account).toBe(ALL_ACCOUNTS);

    act(() => result.current.bulkMailAction("read", result.current.mails));

    await waitFor(() => expect(bulkFlags).toHaveBeenCalledTimes(2));
    expect(bulkFlags.mock.calls.map(([accountId]) => accountId).sort()).toEqual([ALPHA, BETA]);
    expect(
      bulkFlags.mock.calls.every(
        ([, input]) => input.folder_path === INBOX && input.unread === false && input.uids.length === 1,
      ),
    ).toBe(true);
  });

  it("découpe en tronçons de 500 uids", async () => {
    mockBackend();
    const bulkFlags = vi.spyOn(mailApi, "bulkFlags").mockResolvedValue(undefined);
    const { result } = mount();
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    act(() => result.current.bulkMailAction("read", synthetic(ALPHA, 1200)));

    await waitFor(() => expect(bulkFlags).toHaveBeenCalledTimes(3));
    expect(bulkFlags.mock.calls.map(([, input]) => input.uids.length)).toEqual([500, 500, 200]);
    expect(bulkFlags.mock.calls.flatMap(([, input]) => input.uids)).toEqual(
      Array.from({ length: 1200 }, (_, index) => index + 1),
    );
  });

  it("restaure les drapeaux et prévient quand le serveur refuse", async () => {
    mockBackend();
    vi.spyOn(mailApi, "bulkFlags").mockRejectedValue(new Error("serveur muet"));
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));

    act(() => result.current.bulkMailAction("read", result.current.mails));
    expect(result.current.mails.every((mail) => !mail.unread)).toBe(true);

    await waitFor(() => expect(result.current.mails.every((mail) => mail.unread)).toBe(true));
    expect(result.current.mails.every((mail) => !mail.starred)).toBe(true);
    expect(result.current.notices.at(-1)?.message).toBe("serveur muet");
    expect(result.current.folderStats("inbox").unread).toBe(2);
  });
});

describe("actions groupées · déplacements", () => {
  it("archive en un appel et retire les mails de la liste", async () => {
    mockBackend();
    const bulkMove = vi.spyOn(mailApi, "bulkMove").mockResolvedValue(undefined);
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));

    act(() => result.current.bulkMailAction("archive", result.current.mails));

    expect(result.current.mails).toHaveLength(0);
    await waitFor(() =>
      expect(bulkMove).toHaveBeenCalledWith(ALPHA, {
        from_path: INBOX,
        uids: [1, 2],
        to_path: ARCHIVE,
      }),
    );
    await waitFor(() => expect(result.current.notices.at(-1)?.message).toBe("2 messages archivés"));
  });

  it("supprime définitivement un mail de la corbeille", async () => {
    mockBackend({
      threads: { [`${ALPHA}:${TRASH}`]: [apiMessage(ALPHA, 7, { folder_path: TRASH })] },
    });
    const bulkDelete = vi.spyOn(mailApi, "bulkDelete").mockResolvedValue(undefined);
    const bulkMove = vi.spyOn(mailApi, "bulkMove").mockResolvedValue(undefined);
    const { result } = mount();
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    act(() => result.current.setFolder("trash"));
    await waitFor(() => expect(result.current.mails).toHaveLength(1));

    act(() => result.current.bulkMailAction("delete", result.current.mails));

    expect(result.current.mails).toHaveLength(0);
    await waitFor(() =>
      expect(bulkDelete).toHaveBeenCalledWith(ALPHA, { folder_path: TRASH, uids: [7] }),
    );
    expect(bulkMove).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.notices.at(-1)?.message).toBe("1 message supprimé définitivement"),
    );
  });

  it("réinsère les mails et prévient quand le serveur refuse", async () => {
    mockBackend();
    vi.spyOn(mailApi, "bulkMove").mockRejectedValue(new Error("dossier plein"));
    const { result } = mount();
    await waitFor(() => expect(result.current.mails).toHaveLength(2));

    act(() => result.current.bulkMailAction("archive", result.current.mails));
    expect(result.current.mails).toHaveLength(0);

    await waitFor(() => expect(result.current.mails).toHaveLength(2));
    expect(result.current.notices.at(-1)?.message).toBe("dossier plein");
    expect(result.current.mails.every((mail) => mail.folder === "inbox")).toBe(true);
  });
});

describe("actions groupées · démo", () => {
  it("applique le lot d'un coup et ne prévient qu'une fois", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    const bulkMove = vi.spyOn(mailApi, "bulkMove");
    const bulkFlags = vi.spyOn(mailApi, "bulkFlags");
    const { result } = mount();
    const inbox = result.current.mails.filter((mail) => mail.folder === "inbox").slice(0, 2);
    expect(inbox).toHaveLength(2);

    act(() => result.current.bulkMailAction("archive", inbox));

    expect(result.current.notices).toHaveLength(1);
    expect(result.current.notices[0].message).toBe("2 messages archivés");
    expect(result.current.notices[0].actionLabel).toBe("Annuler");
    const archived = result.current.mails.filter((mail) => inbox.some((sent) => sent.id === mail.id));
    expect(archived).toHaveLength(2);
    expect(archived.every((mail) => mail.folder === "archive")).toBe(true);
    expect(bulkMove).not.toHaveBeenCalled();
    expect(bulkFlags).not.toHaveBeenCalled();
  });

  it("ne touche à rien en lecture seule", async () => {
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    readonly.on = true;
    const bulkMove = vi.spyOn(mailApi, "bulkMove");
    const { result } = mount();
    const inbox = result.current.mails.filter((mail) => mail.folder === "inbox");

    act(() => result.current.bulkMailAction("archive", inbox));

    const untouched = result.current.mails.filter((mail) => inbox.some((sent) => sent.id === mail.id));
    expect(untouched.every((mail) => mail.folder === "inbox")).toBe(true);
    expect(result.current.notices.at(-1)?.message).toBe("Action indisponible dans la démo");
    expect(bulkMove).not.toHaveBeenCalled();
  });
});
