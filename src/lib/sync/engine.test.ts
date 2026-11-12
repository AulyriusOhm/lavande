import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullResult, ServerOp } from "./client";
import { decodeBase64Url, deriveIndexKey, entityRef, openOp, sealOp, type EntityKind, type OpMeta } from "./crypto";
import { createSyncEngine, type SyncEngine } from "./engine";
import { docKey, LOCAL_SCHEMA_VERSION, type OpPayload } from "./merge";
import {
  createDevice,
  createLocalStorageSyncStorage,
  createMemoryStorage,
  emptyState,
  resolveDek,
  type SyncOp,
  type SyncState,
  type SyncStorage,
} from "./storage";
import { createMemoryVault } from "./vault";

const SERVER = "https://sync.test/";
const ACCOUNT = { serverUrl: SERVER, email: "a@b.c", password: "mot-de-passe" };
const NOW = 1_700_000_000_000;
const FAST_KEY = new Uint8Array(32).fill(7);

type Call = { method: string; url: string; body: unknown };

type Handlers = {
  register: () => Response;
  devices: () => Response;
  logout: () => Response;
  push: (ops: SyncOp[]) => Response;
  pull: (since: number, limit: number) => Response;
};

type Harness = {
  engine: SyncEngine;
  storage: SyncStorage;
  calls: Call[];
  handlers: Handlers;
  connect: () => Promise<void>;
  pushCalls: () => Call[];
  pullCalls: () => Call[];
  pushBodies: () => SyncOp[][];
  pullSince: () => number[];
};

function json(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

function createHarness(initial?: SyncState, prepared?: SyncStorage): Harness {
  const storage = prepared ?? createMemoryStorage(initial ?? emptyState(createDevice("Test", "node")));
  const calls: Call[] = [];
  const handlers: Handlers = {
    register: () =>
      json(201, { userId: "user-1", token: "session-1", expiresAt: "2030-01-01T00:00:00.000Z", accountSalt: "salt-1" }),
    devices: () => json(201, { deviceId: "device-1" }),
    logout: () => json(204),
    push: (ops) => json(200, { acked: ops.map((op) => op.opId), nextSeq: ops.length }),
    pull: () => json(200, { ops: [], nextSeq: 0, hasMore: false }),
  };

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    if (call.method === "POST" && call.url.endsWith("/api/v1/auth/register")) return handlers.register();
    if (call.method === "POST" && call.url.endsWith("/api/v1/devices")) return handlers.devices();
    if (call.method === "POST" && call.url.endsWith("/api/v1/auth/logout")) return handlers.logout();
    if (call.method === "POST" && call.url.endsWith("/api/v1/auth/envelope")) return json(204);
    if (call.method === "POST" && call.url.endsWith("/api/v1/ops")) {
      return handlers.push((call.body as { ops: SyncOp[] }).ops);
    }
    if (call.method === "GET" && call.url.includes("/api/v1/ops")) {
      const query = new URL(call.url).searchParams;
      return handlers.pull(Number(query.get("since")), Number(query.get("limit")));
    }
    throw new Error(`appel inattendu : ${call.method} ${call.url}`);
  }) as unknown as typeof fetch;

  const engine = createSyncEngine(storage, {
    fetchImpl,
    now: () => NOW,
    deriveMasterKey: () => FAST_KEY,
  });

  const pushCalls = () => calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/v1/ops"));
  const pullCalls = () => calls.filter((call) => call.method === "GET" && call.url.includes("/api/v1/ops"));

  return {
    engine,
    storage,
    calls,
    handlers,
    connect: () => engine.createAccount(ACCOUNT),
    pushCalls,
    pullCalls,
    pushBodies: () => pushCalls().map((call) => (call.body as { ops: SyncOp[] }).ops),
    pullSince: () => pullCalls().map((call) => Number(new URL(call.url).searchParams.get("since"))),
  };
}

function dekOf(harness: Harness): Uint8Array {
  const dek = resolveDek(harness.engine.getState());
  if (dek === null) throw new Error("aucune DEK dans l'état de test");
  return dek;
}

function remoteOp(
  dek: Uint8Array,
  input: {
    seq: number;
    opId: string;
    kind: EntityKind;
    id: string;
    hlc: string;
    patch: Record<string, unknown>;
  },
): ServerOp {
  const schemaVersion = LOCAL_SCHEMA_VERSION;
  const meta: OpMeta = {
    opId: input.opId,
    deviceId: "mobile-device",
    entityRef: entityRef(deriveIndexKey(dek), input.kind, input.id),
    hlc: input.hlc,
    schemaVersion,
  };
  const payload: OpPayload = { id: input.id, kind: input.kind, v: schemaVersion, op: "upsert", patch: input.patch };
  const sealed = sealOp(dek, meta, payload);
  return {
    seq: input.seq,
    opId: meta.opId,
    deviceId: meta.deviceId,
    kind: input.kind,
    entityRef: meta.entityRef,
    hlc: meta.hlc,
    schemaVersion,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSyncEngine", () => {
  it("démarre en phase unconfigured sans appel réseau", () => {
    const harness = createHarness();

    expect(harness.engine.getStatus()).toEqual({ phase: "unconfigured", pending: 0 });
    expect(harness.engine.getState().account).toBeUndefined();
    expect(harness.engine.getState().outbox).toEqual([]);
    expect(harness.calls).toHaveLength(0);
  });

  it("reprend la synchro après un redémarrage : les secrets viennent du coffre", async () => {
    const key = "lavande.test.engine";
    localStorage.removeItem(key);
    const vault = createMemoryVault();
    const first = createLocalStorageSyncStorage(key, vault);
    await first.settled();
    const harness = createHarness(undefined, first);
    await harness.connect();
    await first.settled();

    const device = harness.engine.getState().device;
    const dek = dekOf(harness);
    expect(device.privKey).toHaveLength(43);
    expect(vault.snapshot()).toMatchObject({ deviceKey: device.privKey, accountTokens: { "user-1": "session-1" } });
    const persisted = JSON.parse(localStorage.getItem(key) as string) as Record<string, Record<string, unknown>>;
    expect(persisted.device.privKey).toBeUndefined();
    expect(persisted.account.token).toBeUndefined();

    const restarted = createLocalStorageSyncStorage(key, vault);
    await restarted.settled();

    expect(restarted.read().device.id).toBe(device.id);
    expect(restarted.read().device.privKey).toBe(device.privKey);
    expect(restarted.read().account?.token).toBe("session-1");
    expect(resolveDek(restarted.read())).toEqual(dek);
    localStorage.removeItem(key);
  });

  it("createAccount configure le compte puis emitLocal produit l'op deviceId:1 scellée", async () => {
    const harness = createHarness();
    await harness.connect();

    const state = harness.engine.getState();
    expect(state.account).toMatchObject({
      serverUrl: SERVER,
      userId: "user-1",
      email: "a@b.c",
      token: "session-1",
    });
    expect(state.envelopes.password).toBeDefined();
    expect(resolveDek(state)).not.toBeNull();
    expect(harness.engine.getStatus()).toMatchObject({ phase: "offline", pending: 0 });

    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain", state: "todo" });

    const outbox = harness.engine.getState().outbox;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].opId).toBe(`${state.device.id}:1`);
    expect(outbox[0].deviceId).toBe(state.device.id);
    expect(outbox[0].kind).toBe("task");
    expect(outbox[0].schemaVersion).toBe(LOCAL_SCHEMA_VERSION);
    expect(harness.engine.getStatus().pending).toBe(1);
    expect(harness.pushCalls()).toHaveLength(0);

    const [op] = outbox;
    const payload = openOp<OpPayload>(
      dekOf(harness),
      {
        opId: op.opId,
        deviceId: op.deviceId,
        entityRef: op.entityRef,
        hlc: op.hlc,
        schemaVersion: op.schemaVersion,
      },
      { nonce: op.nonce, ciphertext: op.ciphertext },
    );
    expect(payload).toEqual({
      id: "tk:1",
      kind: "task",
      v: LOCAL_SCHEMA_VERSION,
      op: "upsert",
      patch: { title: "Acheter du pain", state: "todo" },
    });
  });

  it("createAccount publie l'enveloppe de clé dérivée du mot de passe", async () => {
    const harness = createHarness();
    await harness.connect();

    const call = harness.calls.find(
      (entry) => entry.method === "POST" && entry.url.endsWith("/api/v1/auth/envelope"),
    );
    expect(call).toBeDefined();
    const envelope = (call?.body as { envelope: string }).envelope;
    const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(envelope))) as Record<string, unknown>;
    expect(decoded.v).toBe(1);
    expect(typeof decoded.ephPub).toBe("string");
    expect(typeof decoded.nonce).toBe("string");
    expect(typeof decoded.ct).toBe("string");
  });

  it("emitLocal applique l'op localement sans attendre le serveur", async () => {
    const harness = createHarness();
    await harness.connect();

    harness.engine.emitLocal("task", "tk:9", { title: "Payer le loyer", state: "todo" });

    const state = harness.engine.getState();
    const doc = state.docs[docKey("task", "tk:9")];
    expect(doc.raw).toEqual({ title: "Payer le loyer", state: "todo" });
    expect(state.refs[state.outbox[0].entityRef]).toBe(docKey("task", "tk:9"));
    expect(harness.pushCalls()).toHaveLength(0);

    harness.engine.emitLocal("task", "tk:9", {}, "delete");

    const after = harness.engine.getState();
    expect(after.docs[docKey("task", "tk:9")].deletedAt).toBeDefined();
    expect(after.outbox).toHaveLength(2);
  });

  it("refuse emitLocal sans compte synchronisé", () => {
    const harness = createHarness();

    expect(() => harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" })).toThrow(/aucun compte/);
    expect(harness.engine.getState().outbox).toEqual([]);
  });

  it("syncNow pousse l'outbox, la vide et passe en synced", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });

    await harness.engine.syncNow();

    expect(harness.pushCalls()).toHaveLength(1);
    expect(harness.pushBodies()[0].map((op) => op.opId)).toEqual([`${harness.engine.getState().device.id}:1`]);
    expect(harness.engine.getState().outbox).toEqual([]);
    expect(harness.pullCalls()).toHaveLength(1);
    expect(harness.pullSince()).toEqual([0]);
    expect(harness.engine.getStatus()).toMatchObject({
      phase: "synced",
      pending: 0,
      lastSyncAt: new Date(NOW).toISOString(),
    });
  });

  it("pousse l'outbox par lots de 100", async () => {
    const harness = createHarness();
    await harness.connect();
    for (let index = 1; index <= 120; index++) {
      harness.engine.emitLocal("task", `tk:${index}`, { title: `Tâche ${index}` });
    }
    expect(harness.engine.getStatus().pending).toBe(120);

    await harness.engine.syncNow();

    expect(harness.pushBodies().map((batch) => batch.length)).toEqual([100, 20]);
    expect(harness.engine.getState().outbox).toEqual([]);
    expect(harness.engine.getStatus()).toMatchObject({ phase: "synced", pending: 0 });
  });

  it("tire deux pages, avance le curseur et applique les documents déchiffrés", async () => {
    const harness = createHarness();
    await harness.connect();
    const dek = dekOf(harness);
    const pages: PullResult[] = [
      {
        ops: [
          remoteOp(dek, {
            seq: 1,
            opId: "mobile-device:7",
            kind: "task",
            id: "tk:remote",
            hlc: "001700000000100-00000-abc123",
            patch: { title: "Depuis le mobile", state: "doing" },
          }),
        ],
        nextSeq: 1,
        hasMore: true,
      },
      {
        ops: [
          remoteOp(dek, {
            seq: 2,
            opId: "mobile-device:8",
            kind: "suggestion",
            id: "sg:remote",
            hlc: "001700000000200-00000-abc123",
            patch: { status: "accepted" },
          }),
        ],
        nextSeq: 2,
        hasMore: false,
      },
    ];
    harness.handlers.pull = () => json(200, pages.shift() ?? { ops: [], nextSeq: 2, hasMore: false });

    await harness.engine.syncNow();

    expect(harness.pullSince()).toEqual([0, 1]);
    expect(pages).toHaveLength(0);
    const state = harness.engine.getState();
    expect(state.cursor).toBe(2);
    expect(state.docs[docKey("task", "tk:remote")].raw).toEqual({ title: "Depuis le mobile", state: "doing" });
    expect(state.docs[docKey("task", "tk:remote")].readOnly).toBe(false);
    expect(state.docs[docKey("suggestion", "sg:remote")].raw).toEqual({ status: "accepted" });
    expect(harness.engine.getStatus()).toMatchObject({ phase: "synced", pending: 0 });
  });

  it("n'émet jamais dans l'outbox une op reçue du serveur", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.handlers.pull = () =>
      json(200, {
        ops: [
          remoteOp(dekOf(harness), {
            seq: 1,
            opId: "mobile-device:7",
            kind: "task",
            id: "tk:remote",
            hlc: "001700000000100-00000-abc123",
            patch: { title: "Depuis le mobile" },
          }),
        ],
        nextSeq: 1,
        hasMore: false,
      });

    await harness.engine.syncNow();

    const state = harness.engine.getState();
    expect(state.outbox).toEqual([]);
    expect(state.device.opCounter).toBe(0);
    expect(harness.pushCalls()).toHaveLength(0);
    expect(state.docs[docKey("task", "tk:remote")].raw).toEqual({ title: "Depuis le mobile" });
  });

  it("503 → phase error, outbox intacte et backoff de 2 s", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });
    harness.handlers.push = () => json(503, { code: "unavailable", message: "maintenance" });

    await harness.engine.syncNow();

    expect(harness.engine.getStatus()).toMatchObject({
      phase: "error",
      pending: 1,
      error: "maintenance",
      lastCode: "unavailable",
    });
    expect(harness.engine.getState().outbox).toHaveLength(1);
    expect(harness.engine.getState().status.lastError).toBe("maintenance");
    expect(harness.pullCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.pushCalls()).toHaveLength(2);
    expect(harness.engine.getState().outbox).toHaveLength(1);
  });

  it("401 → phase error unauthorized sans perdre l'outbox", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });
    harness.handlers.push = () => json(401, { code: "unauthorized", message: "jeton expiré" });

    await harness.engine.syncNow();

    expect(harness.engine.getStatus()).toMatchObject({
      phase: "error",
      pending: 1,
      error: "jeton expiré",
      lastCode: "unauthorized",
    });
    expect(harness.engine.getState().outbox).toHaveLength(1);
    expect(harness.pullCalls()).toHaveLength(0);
  });

  it("426 schema_too_new → read_only et émission refusée", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });
    harness.handlers.push = () => json(426, { code: "schema_too_new", message: "schemaVersion 2 > 1" });

    await harness.engine.syncNow();

    expect(harness.engine.getStatus()).toMatchObject({
      phase: "read_only",
      pending: 1,
      lastCode: "schema_too_new",
    });
    expect(harness.engine.readOnly("task", "tk:1")).toBe(true);
    expect(harness.engine.readOnly("task", "tk:jamais-vu")).toBe(true);
    expect(() => harness.engine.emitLocal("task", "tk:1", { title: "Édition" })).toThrow(/lecture seule/);
    expect(harness.engine.getState().outbox).toHaveLength(1);
  });

  it("deux syncNow concurrents ne produisent qu'un seul push", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });

    await Promise.all([harness.engine.syncNow(), harness.engine.syncNow(), harness.engine.syncNow()]);

    expect(harness.pushCalls()).toHaveLength(1);
    expect(harness.pullCalls()).toHaveLength(1);
    expect(harness.engine.getState().outbox).toEqual([]);
    expect(harness.engine.getStatus()).toMatchObject({ phase: "synced", pending: 0 });
  });

  it("programme un flush débattu de 800 ms après une mutation locale", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });

    await vi.advanceTimersByTimeAsync(799);
    expect(harness.pushCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.pushCalls()).toHaveLength(1);
    expect(harness.engine.getState().outbox).toEqual([]);
    expect(harness.engine.getStatus().phase).toBe("synced");
  });

  it("setPaused retient le flush automatique et syncNow, puis reprend au déblocage", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.setPaused(true);
    expect(harness.engine.isPaused()).toBe(true);

    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.pushCalls()).toHaveLength(0);
    expect(harness.engine.getState().outbox).toHaveLength(1);

    await harness.engine.syncNow();
    expect(harness.pushCalls()).toHaveLength(0);

    harness.engine.setPaused(false);
    expect(harness.engine.isPaused()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.pushCalls()).toHaveLength(1);
    expect(harness.engine.getState().outbox).toEqual([]);
  });

  it("logoutAccount efface compte et enveloppes mais garde docs et outbox", async () => {
    const harness = createHarness();
    await harness.connect();
    harness.engine.emitLocal("task", "tk:1", { title: "Acheter du pain" });
    const before = harness.engine.getState();

    await harness.engine.logoutAccount();

    const after = harness.engine.getState();
    expect(after.account).toBeUndefined();
    expect(after.envelopes).toEqual({ devices: {} });
    expect(after.outbox).toEqual(before.outbox);
    expect(after.docs).toEqual(before.docs);
    expect(after.device).toEqual(before.device);
    expect(harness.engine.getStatus()).toMatchObject({ phase: "unconfigured", pending: 1 });
  });
});
