import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiFolderRole, ApiMessage } from "@/lib/api";
import type { Mail } from "@/lib/mail";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

vi.stubEnv("VITE_MAIL_BACKEND", "api");

vi.mock("@/lib/notify", () => ({ notifyNewMail: vi.fn(async () => {}), setUnreadBadge: vi.fn() }));

const ALPHA = "alpha";
const BETA = "beta";

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

const apiMessage = (
  accountId: string,
  uid: number,
  date: string,
  messageId: string,
): ApiMessage => ({
  account_id: accountId,
  folder_path: "INBOX",
  uid,
  uidvalidity: 1,
  thread_id: `t-${messageId}`,
  message_id: messageId,
  in_reply_to: null,
  references: [],
  from: { name: `Expéditeur ${uid}`, email: `exp${uid}@test.fr` },
  to: [{ name: null, email: `${accountId}@test.fr` }],
  cc: [],
  subject: `Sujet ${messageId}`,
  date,
  flags: { unread: false, starred: false, answered: false },
  size: 512,
  pgp: "none",
  preview: `Aperçu ${messageId}`,
  body_text: `Corps ${messageId}`,
  body_html: null,
  attachments: [],
});

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: "", json: async () => body }) as unknown as Response;

type SearchCall = { account: string; params: URLSearchParams };
type Answer = ApiMessage[] | null;

let calls: SearchCall[] = [];
let responder: (call: SearchCall) => Answer | Promise<Answer> = () => [];

function mockBackend() {
  calls = [];
  const folders = [apiFolder(ALPHA, "INBOX", "inbox"), apiFolder(BETA, "INBOX", "inbox")];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/api/accounts")) return reply([apiAccount(ALPHA), apiAccount(BETA)]);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/folder-counts")) return reply([]);
    if (path.endsWith("/search")) {
      const call = { account: /\/accounts\/([^/]+)\/search$/.exec(path)?.[1] ?? "", params: searchParams };
      calls.push(call);
      const answer = await responder(call);
      return answer === null ? reply({ error: "panne imap", kind: "search" }, 500) : reply(answer);
    }
    const match = /\/accounts\/([^/]+)\/folders(?:\/([^/]+)\/threads)?$/.exec(path);
    if (!match) throw new Error(`requête inattendue : ${path}`);
    if (match[2] === undefined) {
      return reply(folders.filter((entry) => entry.account_id === match[1]));
    }
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
  return renderHook(() => useMailStore(), { wrapper });
}

async function ready(result: { current: ReturnType<typeof useMailStore> }) {
  await waitFor(() => expect(result.current.mailAccounts).toHaveLength(2));
}

const ids = (mails: Mail[]) => mails.map((mail) => mail.messageId);

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recherche · tous les comptes", () => {
  it("trie par date décroissante et dédoublonne un même message reçu deux fois", async () => {
    mockBackend();
    responder = (call) =>
      call.account === ALPHA
        ? [
            apiMessage(ALPHA, 1, "2026-01-05T10:00:00Z", "<a1>"),
            apiMessage(ALPHA, 2, "2026-01-09T10:00:00Z", "<a2>"),
          ]
        : [
            apiMessage(BETA, 3, "2026-01-07T10:00:00Z", "<b1>"),
            apiMessage(BETA, 4, "2026-01-09T11:00:00Z", "<a2>"),
          ];
    const { result } = mount();
    await ready(result);

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails("sujet");
    });

    expect(ids(found)).toEqual(["<a2>", "<b1>", "<a1>"]);
    expect(calls.map((call) => call.account)).toEqual([ALPHA, BETA]);
  });

  it("transmet le texte libre, les filtres et le scope au démon", async () => {
    mockBackend();
    const { result } = mount();
    await ready(result);

    await act(async () => {
      await result.current.searchMails("facture from:camille", { hasAttachment: true });
    });

    const [call] = calls;
    expect(call.params.get("q")).toBe("facture");
    expect(call.params.get("from")).toBe("camille");
    expect(call.params.get("has_attachment")).toBe("true");
    expect(call.params.get("offset")).toBeNull();
  });

  it("n'envoie rien pour une requête vide", async () => {
    mockBackend();
    const { result } = mount();
    await ready(result);

    await act(async () => {
      await expect(result.current.searchMails("   ")).resolves.toEqual([]);
    });

    expect(calls).toEqual([]);
  });

  it("prévient quand un compte ne répond pas et garde les autres résultats", async () => {
    mockBackend();
    responder = (call) => (call.account === BETA ? null : [apiMessage(ALPHA, 1, "2026-01-05T10:00:00Z", "<a1>")]);
    const { result } = mount();
    await ready(result);

    let found: Mail[] = [];
    await act(async () => {
      found = await result.current.searchMails("sujet");
    });

    expect(ids(found)).toEqual(["<a1>"]);
    expect(result.current.notices.map((notice) => notice.message)).toContain(
      "Recherche incomplète : le compte beta n'a pas répondu",
    );
  });
});

describe("recherche · réponse obsolète", () => {
  it("ignore la réponse d'une frappe déjà remplacée", async () => {
    mockBackend();
    let release: (answer: Answer) => void = () => {};
    const slow = new Promise<Answer>((resolve) => {
      release = resolve;
    });
    responder = (call) =>
      call.params.get("q") === "premier" ? slow : [apiMessage(ALPHA, 9, "2026-01-09T10:00:00Z", "<second>")];
    const { result } = mount();
    await ready(result);

    let first: Promise<Mail[]> = Promise.resolve([]);
    act(() => {
      first = result.current.searchMails("premier");
    });
    await waitFor(() => expect(calls.some((call) => call.params.get("q") === "premier")).toBe(true));

    let second: Mail[] = [];
    await act(async () => {
      second = await result.current.searchMails("second");
    });
    expect(ids(second)).toEqual(["<second>"]);

    await act(async () => {
      release([apiMessage(ALPHA, 1, "2026-01-05T10:00:00Z", "<premier>")]);
      await expect(first).resolves.toEqual([]);
    });
  });
});

describe("recherche · page suivante", () => {
  it("recharge le même critère avec l'offset des messages déjà demandés", async () => {
    mockBackend();
    responder = (call) =>
      call.params.get("offset") === null
        ? Array.from({ length: 50 }, (_, index) =>
            apiMessage(
              call.account,
              index + 1,
              `2026-01-${String((index % 28) + 1).padStart(2, "0")}T10:00:00Z`,
              `<${call.account}${index}>`,
            ),
          )
        : [apiMessage(call.account, 90, "2025-12-01T10:00:00Z", `<vieux-${call.account}>`)];
    const { result } = mount();
    await ready(result);

    let first: Mail[] = [];
    await act(async () => {
      first = await result.current.searchMails("facture is:unread");
    });
    expect(first).toHaveLength(100);
    expect(result.current.searchHasMore).toBe(true);

    let merged: Mail[] = [];
    await act(async () => {
      merged = await result.current.loadMoreSearch();
    });

    const page = calls.filter((call) => call.account === ALPHA);
    expect(page).toHaveLength(2);
    expect(page[1].params.get("offset")).toBe("50");
    expect(page[1].params.get("q")).toBe("facture");
    expect(page[1].params.get("unread")).toBe("true");
    expect(merged).toHaveLength(102);
    expect(merged[merged.length - 1].timestamp).toBe(new Date("2025-12-01T10:00:00Z").getTime());
    expect(result.current.searchHasMore).toBe(false);
  });
});
