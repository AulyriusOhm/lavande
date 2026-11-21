import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const { notifyNewMail } = vi.hoisted(() => ({ notifyNewMail: vi.fn(async () => {}) }));

vi.mock("@/lib/notify", () => ({ notifyNewMail, setUnreadBadge: vi.fn() }));

const ALPHA = "alpha";
const BETA = "beta";

const apiAccount = (id: string, overrides: Partial<ApiAccount> = {}): ApiAccount => ({
  id,
  label: id === ALPHA ? "Perso" : "Travail",
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: `imap.${id}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${id}.test`, port: 465, encryption: "tls" },
  folders: 1,
  ...overrides,
});

const apiFolder = (accountId: string): ApiFolder => ({
  account_id: accountId,
  path: "INBOX",
  name: "Boîte de réception",
  role: "inbox",
  uidvalidity: 1,
  uidnext: 2,
  last_sync_at: null,
});

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

const requested: string[] = [];

function mockBackend(accounts: ApiAccount[] = [apiAccount(ALPHA), apiAccount(BETA)]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    requested.push(path);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/api/accounts")) return reply(accounts);
    if (path.endsWith("/folder-counts")) return reply([]);
    if (/\/api\/accounts\/[^/]+\/folders$/.test(path)) {
      return reply([apiFolder(path.includes(ALPHA) ? ALPHA : BETA)]);
    }
    if (path.endsWith("/threads")) return reply([] as ApiThread[]);
    throw new Error(`requête inattendue : ${path}`);
  });
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

const notice = (accountId: string, uid: number, from: string, subject: string) => ({
  id: `${accountId}:INBOX:${uid}`,
  account: accountId,
  label: accountId === ALPHA ? "Perso" : "Travail",
  subject,
  from,
  date: 1_731_000_000 + uid,
  unread: true,
  message_id: `<m${uid}@x>`,
});

const arrivalWith = (accountId: string, notices: ReturnType<typeof notice>[], inserted = notices.length) => ({
  ...arrival(accountId, inserted),
  new_mails: notices,
});

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

const storedPrefs = (notifications: Record<string, unknown>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ notifications }));

const storePerimeters = (perimeters: Record<string, unknown>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ perimeters }));

async function arrivalListener() {
  await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
  return FakeEventSource.current as FakeEventSource;
}

beforeEach(() => {
  window.localStorage.clear();
  FakeEventSource.current = null;
  notifyNewMail.mockClear();
  requested.length = 0;
  mockBackend();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications de nouveaux mails · filtrage", () => {
  it("notifie un nouveau message dans la boîte de réception, avec le compte en titre", async () => {
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrival(ALPHA, 2));

    await waitFor(() => expect(notifyNewMail).toHaveBeenCalledTimes(1));
    expect(notifyNewMail).toHaveBeenCalledWith(
      "Nouveau message · Perso",
      "2 nouveaux messages dans la boîte de réception.",
    );
  });

  it("se tait quand l'interrupteur général est coupé", async () => {
    storedPrefs({ enabled: false });
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrival(ALPHA));

    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    expect(notifyNewMail).not.toHaveBeenCalled();
  });

  it("se tait pour un compte dont les notifications sont coupées, pas pour les autres", async () => {
    storedPrefs({ accounts: { [ALPHA]: false } });
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrival(ALPHA));
    source.emit("mail", arrival(BETA));

    await waitFor(() => expect(notifyNewMail).toHaveBeenCalledTimes(1));
    expect(notifyNewMail).toHaveBeenCalledWith(
      "Nouveau message · Travail",
      "Vous avez reçu un nouveau message.",
    );
  });

  it("ne notifie pas un événement sans message inséré ni hors boîte de réception", async () => {
    mount();
    const source = await arrivalListener();

    source.emit("mail", { ...arrival(ALPHA, 0) });
    source.emit("mail", { ...arrival(ALPHA), folder_path: "Archive" });

    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    expect(notifyNewMail).not.toHaveBeenCalled();
  });
});

describe("notifications de nouveaux mails · une par mail", () => {
  it("notifie chaque mail reçu, expéditeur en titre et sujet en texte", async () => {
    mount();
    const source = await arrivalListener();

    source.emit(
      "mail",
      arrivalWith(ALPHA, [
        notice(ALPHA, 3, "Marc Dupont", "Planning de la semaine"),
        notice(ALPHA, 2, "Léa", "Facture de mars"),
      ]),
    );

    await waitFor(() => expect(notifyNewMail).toHaveBeenCalledTimes(2));
    expect(notifyNewMail).toHaveBeenNthCalledWith(1, "Marc Dupont", "Planning de la semaine");
    expect(notifyNewMail).toHaveBeenNthCalledWith(2, "Léa", "Facture de mars");
  });

  it("se tait pour un compte hors périmètre mails", async () => {
    storePerimeters({ [BETA]: { mails: false } });
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrivalWith(BETA, [notice(BETA, 9, "Marc", "Hors périmètre")]));

    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    expect(notifyNewMail).not.toHaveBeenCalled();
  });

  it("se tait quand les notifications du compte sont coupées", async () => {
    storedPrefs({ accounts: { [ALPHA]: false } });
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrivalWith(ALPHA, [notice(ALPHA, 4, "Marc", "Silencieux")]));

    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    expect(notifyNewMail).not.toHaveBeenCalled();
  });

  it("replie sur l'ancien agrégat quand le démon ne pousse pas de mails", async () => {
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrival(ALPHA, 2));

    await waitFor(() => expect(notifyNewMail).toHaveBeenCalledTimes(1));
    expect(notifyNewMail).toHaveBeenCalledWith(
      "Nouveau message · Perso",
      "2 nouveaux messages dans la boîte de réception.",
    );
  });

  it("ne notifie rien sans message inséré ni mail poussé", async () => {
    mount();
    const source = await arrivalListener();

    source.emit("mail", arrival(ALPHA, 0));

    await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
    expect(notifyNewMail).not.toHaveBeenCalled();
  });
});

describe("reconnexion OAuth · popup de reconnexion", () => {
  const expired = (accountId: string) => ({
    type: "account-reauth",
    account_id: accountId,
    folder_path: "",
    report: null,
    new_mails: [],
  });

  const bulkRequest = (path: string) =>
    path.endsWith("/threads") || path.endsWith("/folder-counts");

  it("arme le popup avec le libellé du compte et relit la liste des comptes", async () => {
    const { result } = mount();
    const source = await arrivalListener();
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    const listed = requested.filter((path) => path.endsWith("/api/accounts")).length;

    source.emit("mail", expired(BETA));

    await waitFor(() =>
      expect(result.current.reauthAlert).toEqual({
        accountId: BETA,
        label: "Travail",
        email: `${BETA}@test.fr`,
      }),
    );
    await waitFor(() =>
      expect(requested.filter((path) => path.endsWith("/api/accounts")).length).toBeGreaterThan(
        listed,
      ),
    );
    expect(notifyNewMail).not.toHaveBeenCalled();
  });

  it("ne relance ni les fils ni les compteurs de la boîte", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    const source = await arrivalListener();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = requested.filter(bulkRequest).length;

    source.emit("mail", expired(ALPHA));

    await waitFor(() => expect(result.current.reauthAlert).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requested.filter(bulkRequest).length).toBe(before);
    expect(result.current.mails).toEqual([]);
  });

  it("signale au chargement le compte déjà marqué par le démon", async () => {
    mockBackend([apiAccount(ALPHA, { needs_reauth: true, auth_kind: "oauth2" }), apiAccount(BETA)]);
    const { result } = mount();

    await waitFor(() =>
      expect(result.current.reauthAlert).toEqual({
        accountId: ALPHA,
        label: "Perso",
        email: `${ALPHA}@test.fr`,
      }),
    );
    expect(result.current.accounts.find((entry) => entry.id === ALPHA)?.needsReauth).toBe(true);
    expect(result.current.accounts.find((entry) => entry.id === ALPHA)?.oauth).toBe(true);
  });
});
