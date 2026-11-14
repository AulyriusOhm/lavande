import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsScreen } from "@/screens/settings-screen";
import { MailStoreProvider } from "@/lib/store";
import { PlanningProvider } from "@/lib/planning-store";
import { PrefsProvider } from "@/lib/prefs";
import { ThemeProvider } from "@/lib/theme";
import { createMemoryStorage } from "@/lib/sync/storage";
import type { ApiAccount } from "@/lib/api";

const { invokeMock, native } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  native: { value: true },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/native")>()),
  isNativeShell: () => native.value,
}));

const GMAIL: ApiAccount = {
  id: "gmail",
  label: "Gmail",
  email: "roman@gmail.com",
  username: "roman@gmail.com",
  imap: { host: "imap.gmail.com", port: 993, encryption: "tls" },
  smtp: { host: "smtp.gmail.com", port: 465, encryption: "tls" },
  folders: 1,
};

const reply = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function nativeState(enabled: boolean, failure?: string) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "plugin:lavandebgsync|background_sync_state") return { enabled };
    if (failure && command === "plugin:lavandebgsync|set_background_sync") throw new Error(failure);
    return {};
  });
}

function mount() {
  return render(
    <PrefsProvider>
      <ThemeProvider>
        <PlanningProvider storage={createMemoryStorage()}>
          <MailStoreProvider>
            <SettingsScreen
              mails={[]}
              account="all"
              onOpenAccounts={() => {}}
              onOpenPgp={() => {}}
              onOpenMcp={() => {}}
            />
          </MailStoreProvider>
        </PlanningProvider>
      </ThemeProvider>
    </PrefsProvider>,
  );
}

async function openSync() {
  fireEvent.click(await screen.findByRole("button", { name: /^Synchronisation/ }));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MAIL_BACKEND", "local");
  window.localStorage.clear();
  native.value = true;
  invokeMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/accounts")) return reply([GMAIL]);
      return reply([]);
    }),
  );
});

describe("Réglages mobile · synchronisation de fond", () => {
  it("affiche l'interrupteur avec la valeur stockée et l'écrit au clic", async () => {
    nativeState(true);
    mount();
    await openSync();

    const toggle = await screen.findByRole("switch", { name: /^Synchronisation en arrière-plan/ });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugin:lavandebgsync|set_background_sync", { enabled: false }),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("revient à l'état précédent quand le natif refuse", async () => {
    nativeState(false, "plugin absent");
    mount();
    await openSync();

    const toggle = await screen.findByRole("switch", { name: /^Synchronisation en arrière-plan/ });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText(/Réglage non enregistré · plugin absent/)).toBeTruthy());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reste absent hors coquille Android", async () => {
    native.value = false;
    nativeState(true);
    mount();
    await openSync();

    expect(screen.queryByRole("switch", { name: /^Synchronisation en arrière-plan/ })).toBeNull();
  });
});
