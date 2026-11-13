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

const apiAccount = (id: string): ApiAccount => ({
  id,
  label: id === ALPHA ? "Perso" : "Travail",
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: `imap.${id}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${id}.test`, port: 465, encryption: "tls" },
  folders: 1,
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

function mockBackend() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/sync")) return reply({ reports: [] });
    if (path.endsWith("/api/accounts")) return reply([apiAccount(ALPHA), apiAccount(BETA)]);
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

async function arrivalListener() {
  await waitFor(() => expect(FakeEventSource.current).not.toBeNull());
  return FakeEventSource.current as FakeEventSource;
}

beforeEach(() => {
  window.localStorage.clear();
  FakeEventSource.current = null;
  notifyNewMail.mockClear();
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
