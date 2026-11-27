import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomDek, wrapForDevice } from "./crypto";
import { docKey, type Doc } from "./merge";
import {
  ackOps,
  createDevice,
  createLocalStorageSyncStorage,
  createMemoryStorage,
  emptyState,
  enqueueOp,
  nextOpId,
  resolveDek,
  setDeviceEnvelope,
  STORAGE_KEY,
  type SyncOp,
  type SyncState,
} from "./storage";
import { createMemoryVault, type SecretVault } from "./vault";

const KEY = "lavande.test.sync";

function sampleOp(state: SyncState, overrides: Partial<SyncOp> = {}): SyncOp {
  return {
    opId: nextOpId(state).opId,
    deviceId: state.device.id,
    kind: "task",
    entityRef: "ref-1",
    hlc: "001700000000000-00000-abc123",
    schemaVersion: 1,
    nonce: "bm9uY2U",
    ciphertext: "Y2lwaGVy",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("createDevice", () => {
  it("génère un identifiant et une paire de clés", () => {
    const device = createDevice("Portable", "tauri");
    expect(device.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createDevice("Portable", "tauri").id).not.toBe(device.id);
    expect(device.pubKey).toHaveLength(43);
    expect(device.privKey).toHaveLength(43);
    expect(device.pubKey).not.toBe(device.privKey);
    expect(device.schemaVersion).toBe(1);
    expect(device.opCounter).toBe(0);
  });
});

describe("createLocalStorageSyncStorage", () => {
  it("renvoie un état neuf quand la clé est absente et fixe l'identité de l'appareil", () => {
    const state = createLocalStorageSyncStorage(KEY).read();
    expect(state.proto).toBe(1);
    expect(state.device.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(state.device.privKey).toHaveLength(43);
    expect(state.device.pubKey).toHaveLength(43);
    expect(state.docs).toEqual({});
    expect(state.refs).toEqual({});
    expect(state.outbox).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(state.envelopes).toEqual({ devices: {} });
    expect(JSON.parse(localStorage.getItem(KEY) as string).device.id).toBe(state.device.id);
    expect(createLocalStorageSyncStorage(KEY).read().device.id).toBe(state.device.id);
  });

  it("ne lève pas sur un JSON invalide", () => {
    localStorage.setItem(KEY, "{oops");
    const state = createLocalStorageSyncStorage(KEY).read();
    expect(state.proto).toBe(1);
    expect(state.device.privKey).toHaveLength(43);
    expect(state.cursor).toBe(0);
  });

  it("normalise un état partiellement corrompu (identité d'appareil illisible)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        proto: 1,
        device: {},
        cursor: "x",
        outbox: "nope",
        docs: { "task:a": { id: "a", kind: "task" }, perdu: null },
        status: 3,
      }),
    );
    const state = createLocalStorageSyncStorage(KEY).read();
    expect(state.cursor).toBe(0);
    expect(state.outbox).toEqual([]);
    expect(state.device.privKey).toHaveLength(43);
    expect(state.docs).toEqual({});
    expect(state.status).toEqual({});
  });

  it("garde les documents d'un état dont l'appareil est encore lisible", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        proto: 1,
        device: { id: "device-1", pubKey: "pub", name: "Portable", platform: "web" },
        cursor: "x",
        outbox: "nope",
        docs: { "task:a": { id: "a", kind: "task" }, perdu: null },
        status: 3,
      }),
    );
    const state = createLocalStorageSyncStorage(KEY).read();
    expect(state.device.id).toBe("device-1");
    expect(state.cursor).toBe(0);
    expect(state.outbox).toEqual([]);
    expect(Object.keys(state.docs)).toEqual([docKey("task", "a")]);
    expect(state.docs[docKey("task", "a")]).toEqual({
      id: "a",
      kind: "task",
      v: 0,
      raw: {},
      fields: {},
      readOnly: false,
      updatedAt: "",
    });
    expect(state.status).toEqual({});
  });

  it("relit ce qui a été écrit", () => {
    const storage = createLocalStorageSyncStorage(KEY);
    const base = emptyState(createDevice("Portable", "tauri"));
    const doc: Doc = {
      id: "tk:1",
      kind: "task",
      v: 2,
      raw: { title: "A", labels: ["client"] },
      fields: { title: "001700000000000-00000-abc123" },
      readOnly: true,
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const state: SyncState = {
      ...base,
      cursor: 841,
      docs: { [docKey("task", "tk:1")]: doc },
      refs: { "ref-1": docKey("task", "tk:1") },
      outbox: [sampleOp(base)],
      autoSync: false,
      status: { lastSyncAt: "2024-01-02T00:00:00.000Z" },
    };
    storage.write(state);
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toMatchObject({ proto: 1, cursor: 841 });
    expect(storage.read()).toEqual(state);
  });

  it("garde un doc de kind ai à l'aller-retour", () => {
    const storage = createLocalStorageSyncStorage(KEY);
    const base = emptyState(createDevice("Portable", "tauri"));
    const doc: Doc = {
      id: "usage:appareil-1",
      kind: "ai",
      v: 1,
      raw: { usage: { prompt: 12, completion: 3, calls: 1 }, byDay: { "2026-01-01": { prompt: 12, completion: 3, calls: 1 } } },
      fields: { usage: "001700000000000-00000-abc123" },
      readOnly: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    storage.write({ ...base, docs: { [docKey("ai", doc.id)]: doc } });

    const reread = createLocalStorageSyncStorage(KEY).read();

    expect(reread.docs[docKey("ai", "usage:appareil-1")]).toEqual(doc);
  });

  it("notifie les abonnés et se désabonne", () => {
    const storage = createLocalStorageSyncStorage(KEY);
    const state = emptyState(createDevice("Portable", "web"));
    const listener = vi.fn();
    const unsubscribe = storage.subscribe(listener);
    storage.write(state);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    storage.write({ ...state, cursor: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lève quand le quota est dépassé", () => {
    const storage = createLocalStorageSyncStorage(KEY);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Object.assign(new Error("plein"), { name: "QuotaExceededError" });
    });
    expect(() => storage.write(emptyState(createDevice("Portable", "web")))).toThrow(/quota/);
  });

  it("expose la clé de stockage par défaut", () => {
    expect(STORAGE_KEY).toBe("lavande.sync.v1");
  });
});

const ACCOUNT = {
  serverUrl: "http://sync.test",
  userId: "user-1",
  email: "a@b.c",
  accountSalt: "salt-1",
  token: "session-1",
};

function readable(_state: SyncState): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) as string) as Record<string, unknown>;
}

function legacyState(): { state: SyncState; dek: Uint8Array } {
  const device = createDevice("Portable", "web");
  const dek = randomDek();
  const state: SyncState = {
    ...emptyState(device),
    account: ACCOUNT,
    envelopes: { devices: { [device.id]: wrapForDevice(dek, device.pubKey) } },
  };
  localStorage.setItem(KEY, JSON.stringify(state));
  return { state, dek };
}

describe("createLocalStorageSyncStorage · coffre des secrets", () => {
  it("migre clé privée et jeton du localStorage vers le coffre, sans perdre la clé", async () => {
    const { state, dek } = legacyState();
    const vault = createMemoryVault();
    const storage = createLocalStorageSyncStorage(KEY, vault);
    expect(storage.vaulted()).toBe(false);

    await storage.settled();

    expect(storage.vaulted()).toBe(true);
    expect(vault.snapshot()).toEqual({
      deviceKey: state.device.privKey,
      accountTokens: { "user-1": "session-1" },
    });
    const persisted = readable(state);
    expect((persisted.device as Record<string, unknown>).privKey).toBeUndefined();
    expect((persisted.account as Record<string, unknown>).token).toBeUndefined();
    expect(persisted.envelopes).toEqual(state.envelopes);

    const read = storage.read();
    expect(read.device.privKey).toBe(state.device.privKey);
    expect(read.account).toEqual(ACCOUNT);
    expect(resolveDek(read)).toEqual(dek);
  });

  it("relit les secrets du coffre quand le localStorage n'en porte plus", async () => {
    const device = createDevice("Portable", "web");
    const dek = randomDek();
    const state: SyncState = {
      ...emptyState(device),
      envelopes: { devices: { [device.id]: wrapForDevice(dek, device.pubKey) } },
    };
    const stored = { ...state, device: { ...device, privKey: "" } };
    localStorage.setItem(KEY, JSON.stringify(stored));
    const vault = createMemoryVault({ deviceKey: device.privKey });

    const storage = createLocalStorageSyncStorage(KEY, vault);
    await storage.settled();

    expect(storage.read().device.privKey).toBe(device.privKey);
    expect(resolveDek(storage.read())).toEqual(dek);
    expect(readable(state).device).toMatchObject({ id: device.id, pubKey: device.pubKey });
    expect((readable(state).device as Record<string, unknown>).privKey).toBeUndefined();
  });

  it("garde un secret dans le localStorage jusqu'à l'acquittement du coffre", async () => {
    const vault = createMemoryVault();
    const storage = createLocalStorageSyncStorage(KEY, vault);
    await storage.settled();
    const created = storage.read();
    await storage.settled();

    expect(vault.snapshot().deviceKey).toBe(created.device.privKey);
    expect(readable(created).device).not.toHaveProperty("privKey");
    expect(storage.read().device.privKey).toBe(created.device.privKey);

    storage.write({ ...storage.read(), account: { ...ACCOUNT } });
    expect((readable(created).account as Record<string, unknown>).token).toBe("session-1");

    await storage.settled();
    expect(vault.snapshot().accountTokens).toEqual({ "user-1": "session-1" });
    expect(readable(created).account).not.toHaveProperty("token");
    expect(storage.read().account?.token).toBe("session-1");
  });

  it("retire le jeton du coffre à la déconnexion", async () => {
    const vault = createMemoryVault();
    const storage = createLocalStorageSyncStorage(KEY, vault);
    await storage.settled();
    storage.write({ ...storage.read(), account: { ...ACCOUNT } });
    await storage.settled();
    expect(vault.snapshot().accountTokens).toEqual({ "user-1": "session-1" });

    storage.write({ ...storage.read(), account: undefined });
    await storage.settled();

    expect(vault.snapshot().accountTokens).toEqual({});
    expect(storage.read().account).toBeUndefined();
  });

  it("replie sur le localStorage quand le démon ne répond pas", async () => {
    const { state, dek } = legacyState();
    const unreachable = () => Promise.reject(new Error("démon absent"));
    const vault: SecretVault = {
      readDeviceKey: unreachable,
      writeDeviceKey: unreachable,
      readAccountToken: unreachable,
      writeAccountToken: unreachable,
      deleteAccountToken: unreachable,
    };
    const storage = createLocalStorageSyncStorage(KEY, vault);

    await storage.settled();

    expect(storage.vaulted()).toBe(true);
    expect((readable(state).device as Record<string, unknown>).privKey).toBe(state.device.privKey);
    expect((readable(state).account as Record<string, unknown>).token).toBe("session-1");
    expect(storage.read().device.privKey).toBe(state.device.privKey);
    expect(resolveDek(storage.read())).toEqual(dek);
  });

  it("sans coffre, garde les secrets dans le localStorage (mode démo)", async () => {
    const { state, dek } = legacyState();
    const storage = createLocalStorageSyncStorage(KEY);
    expect(storage.vaulted()).toBe(true);

    await storage.settled();

    expect((readable(state).device as Record<string, unknown>).privKey).toBe(state.device.privKey);
    expect(resolveDek(storage.read())).toEqual(dek);
  });
});

describe("createMemoryStorage", () => {
  it("garde l'état en mémoire et notifie", async () => {
    const initial = emptyState(createDevice("Portable", "web"));
    const storage = createMemoryStorage(initial);
    const listener = vi.fn();
    storage.subscribe(listener);
    expect(storage.read()).toBe(initial);
    const next = { ...initial, cursor: 5 };
    storage.write(next);
    expect(storage.read()).toBe(next);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.vaulted()).toBe(true);
    await expect(storage.settled()).resolves.toBeUndefined();
  });
});

describe("nextOpId", () => {
  it("incrémente le compteur de l'appareil", () => {
    const state = emptyState(createDevice("Portable", "web"));
    const first = nextOpId(state);
    const second = nextOpId(first.state);
    expect(first.opId).toBe(`${state.device.id}:1`);
    expect(second.opId).toBe(`${state.device.id}:2`);
    expect(second.state.device.opCounter).toBe(2);
    expect(state.device.opCounter).toBe(0);
  });
});

describe("enqueueOp", () => {
  it("ajoute dans l'ordre sans doublon", () => {
    const state = emptyState(createDevice("Portable", "web"));
    const first = sampleOp(state, { opId: `${state.device.id}:1` });
    const second = sampleOp(state, { opId: `${state.device.id}:2` });
    const queued = enqueueOp(enqueueOp(state, first), second);
    expect(queued.outbox.map((op) => op.opId)).toEqual([first.opId, second.opId]);
    expect(enqueueOp(queued, first)).toBe(queued);
  });
});

describe("ackOps", () => {
  it("retire seulement les ops acquittées", () => {
    const state = emptyState(createDevice("Portable", "web"));
    const first = sampleOp(state, { opId: `${state.device.id}:1` });
    const second = sampleOp(state, { opId: `${state.device.id}:2` });
    const queued = enqueueOp(enqueueOp(state, first), second);
    const acked = ackOps(queued, [first.opId, "inconnu"]);
    expect(acked.outbox.map((op) => op.opId)).toEqual([second.opId]);
    expect(queued.outbox).toHaveLength(2);
  });
});

describe("resolveDek", () => {
  it("retrouve la DEK via l'enveloppe de l'appareil", () => {
    const device = createDevice("Portable", "web");
    const dek = randomDek();
    const state = setDeviceEnvelope(emptyState(device), wrapForDevice(dek, device.pubKey));
    expect(state.envelopes.devices[device.id]).toBeDefined();
    expect(resolveDek(state)).toEqual(dek);
  });

  it("rend null sans enveloppe", () => {
    expect(resolveDek(emptyState(createDevice("Portable", "web")))).toBeNull();
  });

  it("rend null pour une enveloppe indéchiffrable", () => {
    const device = createDevice("Portable", "web");
    const foreign = createDevice("Autre", "web");
    const state = setDeviceEnvelope(emptyState(device), wrapForDevice(randomDek(), foreign.pubKey));
    expect(resolveDek(state)).toBeNull();
  });
});
