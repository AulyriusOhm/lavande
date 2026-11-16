import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount, NewAccount } from "@/lib/api";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { MailStoreProvider, useMailStore } from "@/lib/store";
import { createMemoryStorage } from "@/lib/sync/storage";

const apiAccount = (id: string): ApiAccount => ({
  id,
  label: id,
  email: `${id}@test.fr`,
  username: `${id}@test.fr`,
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  folders: 0,
});

const INPUT: NewAccount = {
  id: "perso",
  label: "Perso",
  email: "perso@test.fr",
  username: "perso@test.fr",
  imap: { host: "imap.test", port: 993, encryption: "tls" },
  smtp: { host: "smtp.test", port: 465, encryption: "tls" },
  auth: { kind: "password", password: "secret" },
};

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

const failure = (error: string) =>
  ({
    ok: false,
    status: 500,
    statusText: "",
    json: async () => ({ error, kind: "store" }),
  }) as unknown as Response;

type Backend = { listed: boolean; deleteFails: boolean };

function mockBackend(): Backend {
  const calls: Backend = { listed: true, deleteFails: false };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    const method = init?.method ?? "GET";
    if (path.endsWith("/api/accounts") && method === "POST") return reply(apiAccount("perso"));
    if (path.endsWith("/api/accounts")) {
      return calls.listed ? reply([apiAccount("perso")]) : failure("démon injoignable");
    }
    if (/\/api\/accounts\/perso$/.test(path) && method === "DELETE") {
      return calls.deleteFails ? failure("suppression refusée") : reply(null);
    }
    return reply([]);
  });
  return calls;
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
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ajout et retrait d'un compte (api)", () => {
  it("garde le compte connecté quand le rechargement de la boîte échoue", async () => {
    const backend = mockBackend();
    const { result } = mount();
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    backend.listed = false;
    let created = "";
    await act(async () => {
      created = await result.current.createAccount(INPUT);
    });

    expect(created).toBe("perso");
    expect(result.current.account).toBe("perso");
    expect(result.current.connectOpen).toBe(false);
    expect(result.current.phase).toBe("ready");
    expect(result.current.backendError).toBeNull();
    expect(result.current.notices.at(-1)?.message).toBe(
      "Compte connecté · rechargement impossible · store · démon injoignable",
    );
  });

  it("rouvre le dialogue de suppression quand le démon refuse", async () => {
    const backend = mockBackend();
    const { result } = mount();
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    const target = result.current.accounts[0];
    backend.deleteFails = true;
    act(() => {
      result.current.askRemoveAccount(target);
    });
    expect(result.current.removeTarget?.id).toBe("perso");

    act(() => {
      result.current.confirmRemoveAccount();
    });

    await waitFor(() => expect(result.current.removeTarget?.id).toBe("perso"));
    expect(result.current.notices.at(-1)?.message).toContain("suppression refusée");
  });
});
