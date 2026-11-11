import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, ApiFolder, ApiThread } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const ACCOUNT = "alpha";

const apiAccount = (): ApiAccount => ({
  id: ACCOUNT,
  label: ACCOUNT,
  email: `${ACCOUNT}@test.fr`,
  username: `${ACCOUNT}@test.fr`,
  imap: { host: `imap.${ACCOUNT}.test`, port: 993, encryption: "tls" },
  smtp: { host: `smtp.${ACCOUNT}.test`, port: 465, encryption: "tls" },
  folders: 1,
});

const apiFolder = (): ApiFolder => ({
  account_id: ACCOUNT,
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
  const syncs: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), "http://localhost");
    const path = decodeURIComponent(pathname);
    if (path.endsWith("/sync")) {
      syncs.push(init?.method ?? "GET");
      return reply({ reports: [] });
    }
    if (path.endsWith("/api/accounts")) return reply([apiAccount()]);
    if (path.endsWith("/folder-counts")) return reply([]);
    if (/\/api\/accounts\/[^/]+\/folders$/.test(path)) return reply([apiFolder()]);
    if (path.endsWith("/threads")) return reply([] as ApiThread[]);
    throw new Error(`requête inattendue : ${path}`);
  });
  return syncs;
}

class FakeEventSource {
  static opened = 0;
  addEventListener() {}
  close() {}
  constructor() {
    FakeEventSource.opened += 1;
  }
}

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

const storeSyncPrefs = (patch: Record<string, boolean>) =>
  window.localStorage.setItem("lavande.prefs", JSON.stringify({ sync: patch }));

beforeEach(() => {
  window.localStorage.clear();
  FakeEventSource.opened = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("synchronisation des mails · interrupteurs", () => {
  it("relève automatiquement la boîte et écoute les événements par défaut", async () => {
    const syncs = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(syncs).toHaveLength(1));
    await waitFor(() => expect(FakeEventSource.opened).toBeGreaterThan(0));
    expect(result.current.prefs.sync).toEqual({ enabled: true, mails: true, calendar: true, kanban: true });
  });

  it("ne relève plus rien quand les mails sont coupés, mais charge le cache local", async () => {
    storeSyncPrefs({ mails: false });
    const syncs = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    expect(result.current.store.accounts.map((entry) => entry.id)).toEqual([ACCOUNT]);
    expect(syncs).toHaveLength(0);
    expect(FakeEventSource.opened).toBe(0);
  });

  it("ne relève plus rien quand le maître est coupé", async () => {
    storeSyncPrefs({ enabled: false, mails: true });
    const syncs = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    expect(syncs).toHaveLength(0);
    expect(FakeEventSource.opened).toBe(0);
  });

  it("reprend la relève quand le domaine est réactivé à chaud", async () => {
    storeSyncPrefs({ mails: false });
    const syncs = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    expect(syncs).toHaveLength(0);

    act(() => result.current.prefs.setSync({ mails: true }));

    await waitFor(() => expect(syncs).toHaveLength(1));
    await waitFor(() => expect(FakeEventSource.opened).toBeGreaterThan(0));
  });

  it("garde la synchronisation manuelle d'un dossier quand les mails sont coupés", async () => {
    storeSyncPrefs({ mails: false });
    const syncs = mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    expect(syncs).toHaveLength(0);

    act(() => result.current.store.syncFolder());

    await waitFor(() => expect(syncs).toHaveLength(1));
    expect(result.current.store.notices.at(-1)?.message).toContain("Synchronisation terminée");
  });
});

describe("synchronisation du calendrier · interrupteurs", () => {
  it("persiste les rendez-vous par défaut", async () => {
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    act(() => {
      result.current.store.setEvents((current) => [
        ...current,
        { id: "new", date: "2026-02-02", start: "09:00", end: "10:00", title: "Rendez-vous", tone: 0 },
      ]);
    });

    const stored = JSON.parse(window.localStorage.getItem("lavande.events.v1") ?? "[]") as unknown[];
    expect(stored.some((entry) => (entry as { id: string }).id === "new")).toBe(true);
  });

  it("ne persiste plus rien quand le calendrier est coupé, sans perdre l'état en mémoire", async () => {
    storeSyncPrefs({ calendar: false });
    mockBackend();
    const { result } = mount();

    await waitFor(() => expect(result.current.store.phase).toBe("ready"));
    act(() => {
      result.current.store.setEvents([
        { id: "new", date: "2026-02-02", start: "09:00", end: "10:00", title: "Rendez-vous", tone: 0 },
      ]);
    });

    expect(result.current.store.events.map((event) => event.id)).toEqual(["new"]);
    expect(window.localStorage.getItem("lavande.events.v1")).toBeNull();
  });
});
