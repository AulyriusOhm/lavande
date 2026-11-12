import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiAccount } from "@/lib/api";
import { accountDecrypts, setAccountDecryptPolicy } from "@/lib/mail-backend";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
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

const reply = (body: unknown) =>
  ({ ok: true, status: 200, statusText: "", json: async () => body }) as unknown as Response;

type PgpCall = { id: string; enabled: boolean };

function mockBackend(ids: string[]) {
  const pgp: PgpCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input), "http://localhost").pathname);
    const match = /\/api\/accounts\/([^/]+)\/pgp$/.exec(path);
    if (match && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { enabled: boolean };
      pgp.push({ id: match[1], enabled: body.enabled });
      return reply(apiAccount(match[1]));
    }
    if (path.endsWith("/api/accounts")) return reply(ids.map(apiAccount));
    return reply([]);
  });
  return pgp;
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

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "api");
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  setAccountDecryptPolicy({});
  vi.unstubAllEnvs();
});

describe("interrupteur PGP poussé au démon", () => {
  it("transmet l'interrupteur effectif de chaque compte, une seule fois", async () => {
    const pgp = mockBackend(["perso", "pro"]);
    mount();

    await waitFor(() => expect(pgp).toHaveLength(2), { timeout: 3000 });
    expect(pgp).toEqual(
      expect.arrayContaining([
        { id: "perso", enabled: true },
        { id: "pro", enabled: true },
      ]),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(pgp).toHaveLength(2);
  });

  it("tient compte du réglage du compte et le rejoue quand il change", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ pgpAccounts: { pro: { enabled: false } } }),
    );
    const pgp = mockBackend(["perso", "pro"]);
    const { result } = mount();

    await waitFor(() => expect(pgp).toHaveLength(2), { timeout: 3000 });
    expect(pgp).toEqual(
      expect.arrayContaining([
        { id: "perso", enabled: true },
        { id: "pro", enabled: false },
      ]),
    );
    expect(accountDecrypts("pro")).toBe(false);
    expect(accountDecrypts("perso")).toBe(true);

    act(() => result.current.prefs.setAccountPgp("perso", { enabled: false }));

    await waitFor(() =>
      expect(pgp).toEqual(
        expect.arrayContaining([
          { id: "perso", enabled: false },
          { id: "pro", enabled: false },
        ]),
      ),
    );
    expect(accountDecrypts("perso")).toBe(false);
    expect(pgp.filter((call) => call.id === "perso")).toEqual([
      { id: "perso", enabled: true },
      { id: "perso", enabled: false },
    ]);
  });
});
