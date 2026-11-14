/**
 * Synchronisation de fond Android : relevé périodique des boîtes par le plugin
 * natif `lavandebgsync`. Hors coquille Android, tout répond « non pris en
 * charge » sans charger de plugin.
 */
import { useEffect } from "react";
import { isNativeShell } from "@/lib/native";
import { perimeterOf, type AccountPerimeter } from "@/lib/prefs";

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<T>(`plugin:lavandebgsync|${command}`, args),
  );
}

export function backgroundSyncSupported(): boolean {
  return isNativeShell();
}

export async function readBackgroundSync(): Promise<boolean> {
  if (!backgroundSyncSupported()) return false;
  try {
    const { enabled } = await call<{ enabled: boolean }>("background_sync_state");
    return enabled === true;
  } catch {
    return false;
  }
}

export async function writeBackgroundSync(enabled: boolean): Promise<void> {
  if (!backgroundSyncSupported()) return;
  await call("set_background_sync", { enabled });
}

/** Dernier jeu d'identifiants poussé : un même jeu n'est jamais renvoyé. */
let pushed: string | null = null;

export async function syncMutedAccounts(
  accounts: { id: string }[],
  perimeters: Record<string, AccountPerimeter>,
): Promise<void> {
  if (!backgroundSyncSupported()) return;
  const ids = accounts
    .filter((account) => !perimeterOf(perimeters, account.id).mails)
    .map((account) => account.id);
  const key = [...ids].sort().join("\n");
  if (key === pushed) return;
  await call("set_muted_accounts", { ids });
  pushed = key;
}

/** Le natif suit le périmètre mails de chaque compte (#32), sans bruit. */
export function useMutedAccountsSync(
  accounts: { id: string }[],
  perimeters: Record<string, AccountPerimeter>,
): void {
  useEffect(() => {
    void syncMutedAccounts(accounts, perimeters).catch(() => undefined);
  }, [accounts, perimeters]);
}
