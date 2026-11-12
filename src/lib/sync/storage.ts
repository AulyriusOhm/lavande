import { generateDeviceKeys, randomUuid, unwrapFromDevice, type WrappedKey } from "./crypto";
import { docKey, LOCAL_SCHEMA_VERSION, type Doc, type DocKind, type RefIndex } from "./merge";
import type { SecretVault } from "./vault";

export const STORAGE_KEY = "lavande.sync.v1";

const FALLBACK_DEVICE_NAME = "Cet appareil";
const FALLBACK_DEVICE_PLATFORM = "web";

export type DeviceState = {
  id: string;
  name: string;
  platform: string;
  pubKey: string;
  privKey: string;
  schemaVersion: number;
  opCounter: number;
};

export type AccountState = {
  serverUrl: string;
  userId: string;
  email: string;
  accountSalt: string;
  token: string;
};

export type SyncOp = {
  opId: string;
  deviceId: string;
  kind: DocKind;
  entityRef: string;
  hlc: string;
  schemaVersion: number;
  nonce: string;
  ciphertext: string;
};

export type SyncState = {
  proto: 1;
  device: DeviceState;
  account?: AccountState;
  envelopes: { password?: WrappedKey; devices: Record<string, WrappedKey> };
  cursor: number;
  docs: Record<string, Doc>;
  refs: RefIndex;
  outbox: SyncOp[];
  autoSync: boolean;
  status: { lastSyncAt?: string; lastError?: string };
};

/**
 * L'état complet vit en mémoire ; `createLocalStorageSyncStorage` n'en persiste
 * que la part non sensible (docs, refs, outbox, statut, métadonnées du compte).
 */
export type SyncStorage = {
  read(): SyncState;
  write(state: SyncState): void;
  subscribe(listener: () => void): () => void;
  /** `true` quand les secrets ont rejoint le coffre (ou que le repli local est acté). */
  vaulted(): boolean;
  /** Attente de la fin des allers-retours avec le coffre, migration comprise. */
  settled(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function asKind(value: unknown): DocKind | null {
  return value === "task" || value === "suggestion" || value === "event" ? value : null;
}

function createNotifier(): { subscribe(listener: () => void): () => void; notify(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}

function normalizeDevice(value: unknown): DeviceState | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.pubKey !== "string" ||
    value.pubKey.length === 0
  ) {
    return null;
  }
  return {
    id: value.id,
    name: text(value.name, FALLBACK_DEVICE_NAME),
    platform: text(value.platform, FALLBACK_DEVICE_PLATFORM),
    pubKey: value.pubKey,
    privKey: text(value.privKey),
    schemaVersion: counter(value.schemaVersion) || LOCAL_SCHEMA_VERSION,
    opCounter: counter(value.opCounter),
  };
}

function normalizeEnvelope(value: unknown): WrappedKey | null {
  if (!isRecord(value)) return null;
  const ephPub = text(value.ephPub);
  const nonce = text(value.nonce);
  const ct = text(value.ct);
  if (ephPub === "" || nonce === "" || ct === "") return null;
  return { v: 1, ephPub, nonce, ct };
}

function normalizeEnvelopes(value: unknown): SyncState["envelopes"] {
  if (!isRecord(value)) return { devices: {} };
  const devices: Record<string, WrappedKey> = {};
  if (isRecord(value.devices)) {
    for (const [deviceId, envelope] of Object.entries(value.devices)) {
      const wrapped = normalizeEnvelope(envelope);
      if (wrapped !== null) devices[deviceId] = wrapped;
    }
  }
  const password = normalizeEnvelope(value.password);
  return password === null ? { devices } : { password, devices };
}

function normalizeDoc(value: unknown): Doc | null {
  if (!isRecord(value)) return null;
  const kind = asKind(value.kind);
  const id = text(value.id);
  if (kind === null || id === "") return null;
  return {
    id,
    kind,
    v: counter(value.v),
    raw: isRecord(value.raw) ? value.raw : {},
    fields: stringMap(value.fields),
    ...(typeof value.deletedAt === "string" ? { deletedAt: value.deletedAt } : {}),
    readOnly: value.readOnly === true,
    updatedAt: text(value.updatedAt),
  };
}

function normalizeDocs(value: unknown): Record<string, Doc> {
  const docs: Record<string, Doc> = {};
  if (!isRecord(value)) return docs;
  for (const entry of Object.values(value)) {
    const doc = normalizeDoc(entry);
    if (doc !== null) docs[docKey(doc.kind, doc.id)] = doc;
  }
  return docs;
}

function stringMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!isRecord(value)) return map;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") map[key] = entry;
  }
  return map;
}

function normalizeOp(value: unknown): SyncOp | null {
  if (!isRecord(value)) return null;
  const kind = asKind(value.kind);
  if (kind === null) return null;
  const opId = text(value.opId);
  const deviceId = text(value.deviceId);
  const entityRef = text(value.entityRef);
  const hlc = text(value.hlc);
  const nonce = text(value.nonce);
  const ciphertext = text(value.ciphertext);
  if (opId === "" || deviceId === "" || entityRef === "" || hlc === "" || nonce === "" || ciphertext === "") return null;
  return { opId, deviceId, kind, entityRef, hlc, schemaVersion: counter(value.schemaVersion), nonce, ciphertext };
}

function normalizeOutbox(value: unknown): SyncOp[] {
  if (!Array.isArray(value)) return [];
  const ops: SyncOp[] = [];
  for (const entry of value) {
    const op = normalizeOp(entry);
    if (op !== null) ops.push(op);
  }
  return ops;
}

function normalizeAccount(value: unknown): AccountState | undefined {
  if (!isRecord(value)) return undefined;
  const serverUrl = text(value.serverUrl);
  const userId = text(value.userId);
  if (serverUrl === "" || userId === "") return undefined;
  return {
    serverUrl,
    userId,
    email: text(value.email),
    accountSalt: text(value.accountSalt),
    token: text(value.token),
  };
}

function normalizeStatus(value: unknown): SyncState["status"] {
  if (!isRecord(value)) return {};
  const lastSyncAt = text(value.lastSyncAt);
  const lastError = text(value.lastError);
  return {
    ...(lastSyncAt === "" ? {} : { lastSyncAt }),
    ...(lastError === "" ? {} : { lastError }),
  };
}

function normalizeState(value: unknown): SyncState | null {
  if (!isRecord(value)) return null;
  const device = normalizeDevice(value.device);
  if (device === null) return null;
  const state = emptyState(device);
  const account = normalizeAccount(value.account);
  return {
    ...state,
    ...(account === undefined ? {} : { account }),
    envelopes: normalizeEnvelopes(value.envelopes),
    cursor: counter(value.cursor),
    docs: normalizeDocs(value.docs),
    refs: stringMap(value.refs),
    outbox: normalizeOutbox(value.outbox),
    autoSync: typeof value.autoSync === "boolean" ? value.autoSync : state.autoSync,
    status: normalizeStatus(value.status),
  };
}

function errorName(error: unknown): string {
  if (!isRecord(error) || typeof error.name !== "string") return "";
  return error.name;
}

export function createDevice(name: string, platform: string): DeviceState {
  const keys = generateDeviceKeys();
  return {
    id: randomUuid(),
    name,
    platform,
    pubKey: keys.pubKey,
    privKey: keys.privKey,
    schemaVersion: LOCAL_SCHEMA_VERSION,
    opCounter: 0,
  };
}

export function emptyState(device: DeviceState): SyncState {
  return {
    proto: 1,
    device,
    envelopes: { devices: {} },
    cursor: 0,
    docs: {},
    refs: {},
    outbox: [],
    autoSync: true,
    status: {},
  };
}

export function createLocalStorageSyncStorage(
  key: string = STORAGE_KEY,
  vault: SecretVault | null = null,
): SyncStorage {
  const notifier = createNotifier();
  const loaded = loadState();
  const secrets = createSecretCache(vault, loaded);
  let ready = vault === null;
  let chain: Promise<void> = Promise.resolve();

  function loadState(): SyncState | null {
    let stored: string | null;
    try {
      stored = globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
    if (stored === null) return null;
    try {
      return normalizeState(JSON.parse(stored));
    } catch {
      return null;
    }
  }

  function read(): SyncState {
    const stored = loadState();
    if (stored !== null) return withSecrets(stored);
    const fresh = withSecrets(emptyState(createDevice(FALLBACK_DEVICE_NAME, FALLBACK_DEVICE_PLATFORM)));
    secrets.capture(fresh);
    try {
      persist(fresh);
    } catch {
      return fresh;
    }
    void schedule();
    return fresh;
  }

  function write(state: SyncState): void {
    secrets.capture(state);
    persist(state);
    void schedule();
    notifier.notify();
  }

  /** Ajoute les secrets gardés en mémoire à un état relu du localStorage. */
  function withSecrets(state: SyncState): SyncState {
    const privKey = secrets.deviceKey() === "" ? state.device.privKey : secrets.deviceKey();
    const device = privKey === state.device.privKey ? state.device : { ...state.device, privKey };
    if (state.account === undefined) return { ...state, device };
    const kept = secrets.accountId() === state.account.userId ? secrets.accountToken() : "";
    const token = kept === "" ? state.account.token : kept;
    const account = token === state.account.token ? state.account : { ...state.account, token };
    return { ...state, device, account };
  }

  function persist(state: SyncState): void {
    const full = withSecrets(state);
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(secrets.stored() ? stripSecrets(full) : full));
    } catch (error) {
      const name = errorName(error);
      const quota = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
      throw new Error(
        quota
          ? "quota localStorage dépassé : état de synchronisation non persisté"
          : "écriture de l'état de synchronisation impossible",
        { cause: error },
      );
    }
  }

  /** Réécrit la part persistée après un mouvement dans le coffre. */
  function persistCurrent(): void {
    const stored = loadState();
    if (stored === null) return;
    persist(stored);
  }

  function schedule(): Promise<void> {
    chain = chain
      .then(async () => {
        const before = secrets.vaulted();
        if (await secrets.push()) persistCurrent();
        if (before !== secrets.vaulted()) notifier.notify();
      })
      .catch(() => undefined);
    return chain;
  }

  async function settle(): Promise<void> {
    try {
      await secrets.push();
      await secrets.pull(loaded);
    } finally {
      ready = true;
    }
    try {
      persistCurrent();
    } catch {
      return;
    }
    notifier.notify();
  }

  if (vault !== null) chain = settle();

  return {
    read,
    write,
    subscribe: notifier.subscribe,
    vaulted: () => ready && secrets.vaulted(),
    settled: () => chain,
  };
}

/**
 * Ce que `localStorage` reçoit : tout sauf la clé privée de l'appareil et le
 * jeton de session, qui vivent dans le coffre du démon.
 */
function stripSecrets(state: SyncState): unknown {
  const { privKey: _private, ...device } = state.device;
  if (state.account === undefined) return { ...state, device };
  const { token: _token, ...account } = state.account;
  return { ...state, device, account };
}

type SecretCache = {
  deviceKey(): string;
  accountId(): string;
  accountToken(): string;
  /** Le coffre détient tous les secrets connus : le localStorage peut s'en passer. */
  stored(): boolean;
  /** Plus rien à attendre du coffre : secrets à l'abri, ou repli local assumé. */
  vaulted(): boolean;
  capture(state: SyncState): void;
  push(): Promise<boolean>;
  pull(state: SyncState | null): Promise<void>;
};

/**
 * Les secrets de la synchro en mémoire, et leur place dans le coffre. Un secret
 * n'est retiré du `localStorage` qu'une fois le coffre confirmé : sans réponse
 * du démon il y reste (repli local), et la clé privée n'est jamais perdue.
 */
function createSecretCache(vault: SecretVault | null, initial: SyncState | null): SecretCache {
  let mode: "vault" | "local" = vault === null ? "local" : "vault";
  let deviceKey = initial?.device.privKey ?? "";
  let deviceStored = false;
  let accountId = initial?.account?.userId ?? "";
  let accountToken = initial?.account?.token ?? "";
  let tokenStored = false;
  let staleAccountId = "";

  function capture(state: SyncState): void {
    if (state.device.privKey !== "" && state.device.privKey !== deviceKey) {
      deviceKey = state.device.privKey;
      deviceStored = false;
    }
    const token = state.account?.token ?? "";
    const id = state.account?.userId ?? "";
    if (token !== "") {
      if (token !== accountToken || id !== accountId) {
        accountId = id;
        accountToken = token;
        tokenStored = false;
      }
      return;
    }
    if (state.account === undefined && accountToken !== "") {
      staleAccountId = accountId;
      accountId = "";
      accountToken = "";
    }
  }

  function stored(): boolean {
    return (
      mode === "vault" &&
      (deviceKey === "" || deviceStored) &&
      (accountToken === "" || tokenStored)
    );
  }

  function vaulted(): boolean {
    return mode === "local" || stored();
  }

  /** `true` quand le coffre a effectivement reçu (ou perdu) quelque chose. */
  async function push(): Promise<boolean> {
    if (mode === "local" || vault === null) return false;
    try {
      let moved = false;
      if (deviceKey !== "" && !deviceStored) {
        await vault.writeDeviceKey(deviceKey);
        deviceStored = true;
        moved = true;
      }
      if (staleAccountId !== "") {
        await vault.deleteAccountToken(staleAccountId);
        staleAccountId = "";
        moved = true;
      }
      if (accountId !== "" && accountToken !== "" && !tokenStored) {
        await vault.writeAccountToken(accountId, accountToken);
        tokenStored = true;
        moved = true;
      }
      return moved;
    } catch {
      mode = "local";
      return false;
    }
  }

  /** Comble ce que le coffre détient déjà : premier démarrage après migration. */
  async function pull(state: SyncState | null): Promise<void> {
    if (mode === "local" || vault === null) return;
    try {
      if (deviceKey === "") {
        const key = await vault.readDeviceKey();
        if (key !== null) {
          deviceKey = key;
          deviceStored = true;
        }
      }
      const id = state?.account?.userId ?? "";
      if (id !== "" && accountToken === "") {
        const token = await vault.readAccountToken(id);
        if (token !== null) {
          accountId = id;
          accountToken = token;
          tokenStored = true;
        }
      }
    } catch {
      mode = "local";
    }
  }

  return {
    deviceKey: () => deviceKey,
    accountId: () => accountId,
    accountToken: () => accountToken,
    stored,
    vaulted,
    capture,
    push,
    pull,
  };
}

export function createMemoryStorage(initial?: SyncState): SyncStorage {
  const notifier = createNotifier();
  let state = initial ?? emptyState(createDevice(FALLBACK_DEVICE_NAME, FALLBACK_DEVICE_PLATFORM));

  return {
    read: () => state,
    write(next) {
      state = next;
      notifier.notify();
    },
    subscribe: notifier.subscribe,
    vaulted: () => true,
    settled: () => Promise.resolve(),
  };
}

export function nextOpId(state: SyncState): { opId: string; state: SyncState } {
  const opCounter = state.device.opCounter + 1;
  return {
    opId: `${state.device.id}:${opCounter}`,
    state: { ...state, device: { ...state.device, opCounter } },
  };
}

export function enqueueOp(state: SyncState, op: SyncOp): SyncState {
  if (state.outbox.some((queued) => queued.opId === op.opId)) return state;
  return { ...state, outbox: [...state.outbox, op] };
}

export function ackOps(state: SyncState, opIds: string[]): SyncState {
  const acked = new Set(opIds);
  return { ...state, outbox: state.outbox.filter((op) => !acked.has(op.opId)) };
}

export function resolveDek(state: SyncState): Uint8Array | null {
  const envelope = state.envelopes.devices[state.device.id];
  if (envelope === undefined) return null;
  try {
    return unwrapFromDevice(envelope, state.device.privKey);
  } catch {
    return null;
  }
}

export function setDeviceEnvelope(state: SyncState, envelope: WrappedKey): SyncState {
  return {
    ...state,
    envelopes: {
      ...state.envelopes,
      devices: { ...state.envelopes.devices, [state.device.id]: envelope },
    },
  };
}
