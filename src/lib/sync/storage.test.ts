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

  it("normalise un état partiellement corrompu", () => {
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

describe("createMemoryStorage", () => {
  it("garde l'état en mémoire et notifie", () => {
    const initial = emptyState(createDevice("Portable", "web"));
    const storage = createMemoryStorage(initial);
    const listener = vi.fn();
    storage.subscribe(listener);
    expect(storage.read()).toBe(initial);
    const next = { ...initial, cursor: 5 };
    storage.write(next);
    expect(storage.read()).toBe(next);
    expect(listener).toHaveBeenCalledTimes(1);
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
