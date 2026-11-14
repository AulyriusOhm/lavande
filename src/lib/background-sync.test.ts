import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPerimeter } from "@/lib/prefs";

const { invokeMock, native } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  native: { value: true },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/native", () => ({ isNativeShell: () => native.value }));

async function load() {
  vi.resetModules();
  return import("@/lib/background-sync");
}

const perimeter = (mails: boolean): AccountPerimeter => ({ mails, calendar: true, contacts: false });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  native.value = true;
});

describe("synchronisation de fond Android", () => {
  it("ne charge aucun plugin hors coquille Android", async () => {
    native.value = false;
    const { backgroundSyncSupported, readBackgroundSync, syncMutedAccounts, writeBackgroundSync } =
      await load();

    expect(backgroundSyncSupported()).toBe(false);
    expect(await readBackgroundSync()).toBe(false);
    await writeBackgroundSync(true);
    await syncMutedAccounts([{ id: "gmail" }], { gmail: perimeter(false) });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("lit l'état natif et retombe sur faux quand le natif échoue", async () => {
    const { readBackgroundSync } = await load();
    invokeMock.mockResolvedValueOnce({ enabled: true });

    expect(await readBackgroundSync()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandebgsync|background_sync_state", undefined);

    invokeMock.mockRejectedValueOnce("plugin absent");
    expect(await readBackgroundSync()).toBe(false);
  });

  it("écrit l'interrupteur avec son argument", async () => {
    const { writeBackgroundSync } = await load();

    await writeBackgroundSync(false);

    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandebgsync|set_background_sync", { enabled: false });
  });

  it("ne pousse que les comptes dont les mails sont coupés, une seule fois", async () => {
    const { syncMutedAccounts } = await load();
    const accounts = [{ id: "gmail" }, { id: "pro" }, { id: "ovh" }];
    const perimeters = { gmail: perimeter(false), ovh: perimeter(false) };

    await syncMutedAccounts(accounts, perimeters);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:lavandebgsync|set_muted_accounts", {
      ids: ["gmail", "ovh"],
    });

    await syncMutedAccounts(accounts, { ...perimeters, pro: perimeter(true) });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await syncMutedAccounts(accounts, { ...perimeters, pro: perimeter(false) });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith("plugin:lavandebgsync|set_muted_accounts", {
      ids: ["gmail", "pro", "ovh"],
    });
  });
});
