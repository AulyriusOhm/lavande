/**
 * Coffre des secrets de synchronisation : la clé privée de l'appareil (elle
 * déchiffre les documents E2EE) et le jeton de session de chaque compte.
 *
 * - `createDaemonVault` : le coffre du démon local (`/api/sync/secrets…`,
 *   derrière le jeton Bearer), trousseau système ou fichier chiffré — le même
 *   que les identifiants CalDAV.
 * - `createMemoryVault` : en mémoire, pour les tests.
 *
 * `src/lib/sync/storage.ts` ne supprime un secret du `localStorage` qu'une fois
 * le coffre confirmé : un coffre muet laisse le secret sur place.
 */

import { mailApi } from "@/lib/api";

export type SecretVault = {
  readDeviceKey(): Promise<string | null>;
  writeDeviceKey(privateKey: string): Promise<void>;
  readAccountToken(accountId: string): Promise<string | null>;
  writeAccountToken(accountId: string, token: string): Promise<void>;
  deleteAccountToken(accountId: string): Promise<void>;
};

export function createDaemonVault(): SecretVault {
  return {
    readDeviceKey: async () => (await mailApi.syncDeviceKey()).private_key,
    writeDeviceKey: (privateKey) => mailApi.setSyncDeviceKey(privateKey),
    readAccountToken: async (accountId) => (await mailApi.syncAccountToken(accountId)).token,
    writeAccountToken: (accountId, token) => mailApi.setSyncAccountToken(accountId, token),
    deleteAccountToken: (accountId) => mailApi.deleteSyncAccountToken(accountId),
  };
}

export type MemoryVault = SecretVault & {
  snapshot(): { deviceKey: string | null; accountTokens: Record<string, string> };
};

export function createMemoryVault(
  initial: { deviceKey?: string; accountTokens?: Record<string, string> } = {},
): MemoryVault {
  let deviceKey = initial.deviceKey ?? null;
  const accountTokens = { ...initial.accountTokens };
  return {
    readDeviceKey: async () => deviceKey,
    writeDeviceKey: async (privateKey) => {
      deviceKey = privateKey;
    },
    readAccountToken: async (accountId) => accountTokens[accountId] ?? null,
    writeAccountToken: async (accountId, token) => {
      accountTokens[accountId] = token;
    },
    deleteAccountToken: async (accountId) => {
      delete accountTokens[accountId];
    },
    snapshot: () => ({ deviceKey, accountTokens: { ...accountTokens } }),
  };
}
