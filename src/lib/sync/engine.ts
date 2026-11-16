import { sha256 } from "@noble/hashes/sha2.js";
import { createSyncApi, SyncHttpError, type PairingClaim, type SyncApi, type SyncDevice } from "./client";
import { createClock } from "./clock";
import {
  decodeBase64Url,
  deriveAuthKey,
  deriveIndexKey,
  deriveKek,
  deriveMasterKey,
  encodeBase64Url,
  entityRef,
  openOp,
  randomDek,
  randomSalt,
  sealOp,
  unwrapFromDevice,
  unwrapFromPassword,
  wrapForDevice,
  wrapForPassword,
  type EntityKind,
  type OpMeta,
  type WrappedKey,
} from "./crypto";
import { applyOp, docKey, LOCAL_SCHEMA_VERSION, type DecodedOp, type OpPayload } from "./merge";
import {
  ackOps,
  enqueueOp,
  nextOpId,
  resolveDek,
  setDeviceEnvelope,
  type SyncOp,
  type SyncState,
  type SyncStorage,
} from "./storage";

const PUSH_BATCH = 100;
const PULL_LIMIT = 500;
const FLUSH_DEBOUNCE_MS = 800;
const AUTO_SYNC_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const FINGERPRINT_LENGTH = 8;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type SyncPhase = "unconfigured" | "offline" | "syncing" | "synced" | "error" | "read_only";

export type SyncStatus = {
  phase: SyncPhase;
  pending: number;
  lastSyncAt?: string;
  error?: string;
  lastCode?: string;
};

export type SyncEngine = {
  getState(): SyncState;
  getStatus(): SyncStatus;
  subscribe(listener: () => void): () => void;
  start(): () => void;
  syncNow(): Promise<void>;
  emitLocal(kind: EntityKind, id: string, patch: Record<string, unknown>, op?: "upsert" | "delete"): void;
  readOnly(kind: EntityKind, id: string): boolean;
  canEmit(): boolean;
  setAutoSync(value: boolean): void;
  /** Met la synchronisation réseau en pause : les mutations restent dans l'outbox. */
  setPaused(value: boolean): void;
  isPaused(): boolean;
  /** Restreint les kinds synchronisés (push + pull) ; un kind réactivé est re-tiré depuis le serveur. */
  setEnabledKinds(kinds: readonly EntityKind[]): void;
  createAccount(input: { serverUrl: string; email: string; password: string }): Promise<void>;
  loginAccount(input: { serverUrl: string; email: string; password: string }): Promise<void>;
  logoutAccount(): Promise<void>;
  pairStart(serverUrl: string): Promise<{ code: string; expiresAt: string; pollSecret: string }>;
  pairClaim(code: string): Promise<{ deviceId: string; fingerprint: string }>;
  pairComplete(code: string): Promise<void>;
  pairPoll(code: string, pollSecret: string): Promise<"pending" | "completed">;
  listDevices(): Promise<Array<{ id: string; name: string; platform: string; schemaVersion: number; lastSeenAt: string; current: boolean }>>;
  revokeDevice(id: string): Promise<void>;
};

export type SyncEngineOptions = {
  api?: SyncApi;
  now?: () => number;
  fetchImpl?: typeof fetch;
  deriveMasterKey?: (password: string, accountSalt: string) => Uint8Array | Promise<Uint8Array>;
};

type StatusPatch = { phase?: SyncPhase; error?: string | null; lastCode?: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function readEnvelope(text: string): WrappedKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("enveloppe de clé invalide : JSON attendu");
  }
  if (!isRecord(parsed) || typeof parsed.ephPub !== "string" || typeof parsed.nonce !== "string" || typeof parsed.ct !== "string") {
    throw new Error("enveloppe de clé invalide : champs ephPub, nonce et ct requis");
  }
  return { v: 1, ephPub: parsed.ephPub, nonce: parsed.nonce, ct: parsed.ct };
}

function encodeEnvelopeWire(envelope: WrappedKey): string {
  return encodeBase64Url(textEncoder.encode(JSON.stringify(envelope)));
}

function readEnvelopeWire(text: string): WrappedKey {
  return readEnvelope(textDecoder.decode(decodeBase64Url(text)));
}

function fingerprintOf(publicKey: string): string {
  return encodeBase64Url(sha256(decodeBase64Url(publicKey))).slice(0, FINGERPRINT_LENGTH);
}

export function createSyncEngine(storage: SyncStorage, options: SyncEngineOptions = {}): SyncEngine {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const derive = options.deriveMasterKey ?? deriveMasterKey;
  const initial = storage.read();
  const clock = createClock(initial.device.id, now);

  const listeners = new Set<() => void>();
  const claims = new Map<string, PairingClaim>();
  const pendingPairings = new Map<string, string>();

  let phase: SyncPhase = initial.account === undefined ? "unconfigured" : "offline";
  let error: string | null = null;
  let lastCode: string | null = null;
  let inflight: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  let started = false;
  let paused = false;
  let enabledKinds = new Set<EntityKind>(["task", "suggestion", "event", "ai"]);

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function setStatus(patch: StatusPatch): void {
    if (patch.phase !== undefined) phase = patch.phase;
    if (patch.error !== undefined) error = patch.error;
    if (patch.lastCode !== undefined) lastCode = patch.lastCode;
    notify();
  }

  function getStatus(): SyncStatus {
    const status: SyncStatus = { phase, pending: storage.read().outbox.length };
    const lastSyncAt = storage.read().status.lastSyncAt;
    if (lastSyncAt !== undefined) status.lastSyncAt = lastSyncAt;
    if (error !== null) status.error = error;
    if (lastCode !== null) status.lastCode = lastCode;
    return status;
  }

  function clearBackoffTimer(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  }

  function resetBackoff(): void {
    attempts = 0;
    clearBackoffTimer();
  }

  function armBackoff(): void {
    clearBackoffTimer();
    attempts += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      void syncNow();
    }, delay);
  }

  function armAutoSync(): void {
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (!started) return;
    if (paused) return;
    if (!storage.read().autoSync) return;
    intervalTimer = setInterval(() => {
      void syncNow();
    }, AUTO_SYNC_INTERVAL_MS);
  }

  function scheduleFlush(): void {
    if (paused) return;
    if (!storage.read().autoSync) return;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void syncNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  function apiForServer(serverUrl: string, token: string | null): SyncApi {
    if (options.api !== undefined) return options.api;
    return createSyncApi({ baseUrl: serverUrl, token, deviceId: storage.read().device.id, fetchImpl });
  }

  function apiFor(state: SyncState): SyncApi {
    if (options.api !== undefined) return options.api;
    if (state.account === undefined) {
      throw new Error("serveur non configuré : créez un compte, connectez-vous ou appairez cet appareil");
    }
    return createSyncApi({
      baseUrl: state.account.serverUrl,
      token: state.account.token,
      deviceId: state.device.id,
      fetchImpl,
    });
  }

  async function masterKeyOf(password: string, accountSalt: string): Promise<Uint8Array> {
    const masterKey = await derive(password, accountSalt);
    if (masterKey.length !== 32) throw new Error("dérivation invalide : clé maîtresse de 32 octets attendue");
    return masterKey;
  }

  function decodeServerOp(dek: Uint8Array, op: { opId: string; deviceId: string; entityRef: string; hlc: string; schemaVersion: number; nonce: string; ciphertext: string; kind: EntityKind }): DecodedOp | null {
    const meta: OpMeta = {
      opId: op.opId,
      deviceId: op.deviceId,
      entityRef: op.entityRef,
      hlc: op.hlc,
      schemaVersion: op.schemaVersion,
    };
    try {
      const payload = openOp<OpPayload>(dek, meta, { nonce: op.nonce, ciphertext: op.ciphertext });
      return { kind: op.kind, entityRef: op.entityRef, hlc: op.hlc, schemaVersion: op.schemaVersion, payload };
    } catch {
      return null;
    }
  }

  async function pushOutbox(api: SyncApi): Promise<void> {
    for (;;) {
      const state = storage.read();
      const pushable = state.outbox.filter((op) => enabledKinds.has(op.kind));
      if (pushable.length === 0) return;
      const batch = pushable.slice(0, PUSH_BATCH);
      const result = await api.pushOps(batch);
      const current = storage.read();
      const next = ackOps(current, result.acked);
      storage.write(next);
      const remaining = next.outbox.filter((op) => enabledKinds.has(op.kind)).length;
      if (remaining === pushable.length) return;
    }
  }

  async function pullPages(api: SyncApi): Promise<void> {
    for (;;) {
      const state = storage.read();
      const dek = resolveDek(state);
      if (dek === null) throw new Error("synchronisation impossible : clé de chiffrement absente (appareil non appairé)");
      const page = await api.pullOps(state.cursor, PULL_LIMIT);
      let docs = state.docs;
      let refs = state.refs;
      let cursor = state.cursor;
      for (const op of page.ops) {
        clock.receive(op.hlc);
        if (op.seq > cursor) cursor = op.seq;
        if (!enabledKinds.has(op.kind)) continue;
        const decoded = decodeServerOp(dek, op);
        if (decoded === null) continue;
        const applied = applyOp(docs, refs, decoded);
        docs = applied.docs;
        refs = applied.refs;
      }
      const nextCursor = typeof page.nextSeq === "number" && page.nextSeq > cursor ? page.nextSeq : cursor;
      storage.write({ ...storage.read(), docs, refs, cursor: nextCursor });
      if (!page.hasMore) return;
      if (nextCursor === state.cursor) return;
    }
  }

  function handleFailure(failure: unknown): void {
    const message = messageOf(failure, "synchronisation échouée");
    const state = storage.read();
    storage.write({ ...state, status: { ...state.status, lastError: message } });
    if (!(failure instanceof SyncHttpError)) {
      setStatus({ phase: "error", error: message, lastCode: "internal_error" });
      return;
    }
    if (failure.status === 401) {
      setStatus({ phase: "error", error: message, lastCode: "unauthorized" });
      return;
    }
    if (failure.status === 426 || failure.code === "schema_too_new") {
      setStatus({ phase: "read_only", error: message, lastCode: "schema_too_new" });
      return;
    }
    if (failure.status === 0) {
      setStatus({ phase: "offline", error: message, lastCode: "offline" });
      armBackoff();
      return;
    }
    if (failure.status === 429 || failure.status >= 500) {
      setStatus({ phase: "error", error: message, lastCode: failure.code });
      armBackoff();
      return;
    }
    setStatus({ phase: "error", error: message, lastCode: failure.code });
  }

  async function sync(): Promise<void> {
    try {
      const state = storage.read();
      if (state.account === undefined) {
        setStatus({ phase: "unconfigured", error: null, lastCode: null });
        return;
      }
      clearBackoffTimer();
      setStatus({ phase: "syncing", error: null, lastCode: null });
      const api = apiFor(state);
      await pushOutbox(api);
      await pullPages(api);
      attempts = 0;
      const syncedAt = new Date(now()).toISOString();
      const latest = storage.read();
      storage.write({ ...latest, status: { lastSyncAt: syncedAt } });
      setStatus({ phase: "synced", error: null, lastCode: null });
    } catch (failure) {
      handleFailure(failure);
    }
  }

  function syncNow(): Promise<void> {
    if (paused) return Promise.resolve();
    if (inflight !== null) return inflight;
    const run = sync().finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  }

  function canEmit(): boolean {
    const state = storage.read();
    return state.account !== undefined && resolveDek(state) !== null;
  }

  function readOnly(kind: EntityKind, id: string): boolean {
    if (phase === "read_only") return true;
    return storage.read().docs[docKey(kind, id)]?.readOnly === true;
  }

  function emitLocal(kind: EntityKind, id: string, patch: Record<string, unknown>, op: "upsert" | "delete" = "upsert"): void {
    const state = storage.read();
    if (state.account === undefined) throw new Error("émission impossible : aucun compte synchronisé");
    const dek = resolveDek(state);
    if (dek === null) throw new Error("émission impossible : clé de chiffrement absente (appareil non appairé)");
    if (readOnly(kind, id)) throw new Error(`émission impossible : ${docKey(kind, id)} est en lecture seule (schéma plus récent)`);
    const { opId, state: counted } = nextOpId(state);
    const meta: OpMeta = {
      opId,
      deviceId: counted.device.id,
      entityRef: entityRef(deriveIndexKey(dek), kind, id),
      hlc: clock.tick(),
      schemaVersion: LOCAL_SCHEMA_VERSION,
    };
    const sealed = sealOp(dek, meta, { id, kind, v: LOCAL_SCHEMA_VERSION, op, patch });
    const queued: SyncOp = { ...meta, kind, nonce: sealed.nonce, ciphertext: sealed.ciphertext };
    const applied = applyOp(counted.docs, counted.refs, {
      kind,
      entityRef: meta.entityRef,
      hlc: meta.hlc,
      schemaVersion: LOCAL_SCHEMA_VERSION,
      payload: { id, kind, v: LOCAL_SCHEMA_VERSION, op, patch },
    });
    storage.write(
      enqueueOp(applied.changed ? { ...counted, docs: applied.docs, refs: applied.refs } : counted, queued),
    );
    notify();
    scheduleFlush();
  }

  function setAutoSync(value: boolean): void {
    const state = storage.read();
    storage.write({ ...state, autoSync: value });
    armAutoSync();
    notify();
  }

  function setPaused(value: boolean): void {
    if (paused === value) return;
    paused = value;
    if (value) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      clearBackoffTimer();
      notify();
      return;
    }
    armAutoSync();
    notify();
    void syncNow();
  }

  function isPaused(): boolean {
    return paused;
  }

  function setEnabledKinds(kinds: readonly EntityKind[]): void {
    const next = new Set<EntityKind>(kinds);
    let reenabled = false;
    for (const kind of next) {
      if (!enabledKinds.has(kind)) {
        reenabled = true;
        break;
      }
    }
    enabledKinds = next;
    if (reenabled) {
      const state = storage.read();
      storage.write({ ...state, cursor: 0 });
    }
    notify();
    if (started && !paused) void syncNow();
  }

  function start(): () => void {
    if (started) throw new Error("moteur déjà démarré : utilisez la fonction d'arrêt renvoyée par start()");
    started = true;
    const onOnline = () => {
      resetBackoff();
      void syncNow();
    };
    const onOffline = () => setStatus({ phase: "offline" });
    globalThis.addEventListener("online", onOnline);
    globalThis.addEventListener("offline", onOffline);
    armAutoSync();
    return () => {
      started = false;
      globalThis.removeEventListener("online", onOnline);
      globalThis.removeEventListener("offline", onOffline);
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      clearBackoffTimer();
    };
  }

  async function createAccount(input: { serverUrl: string; email: string; password: string }): Promise<void> {
    const state = storage.read();
    if (state.account !== undefined) throw new Error("compte déjà configuré : déconnectez-vous avant d'en créer un autre");
    const api = apiForServer(input.serverUrl, null);
    const accountSalt = randomSalt(16);
    const masterKey = await masterKeyOf(input.password, accountSalt);
    const authKey = encodeBase64Url(deriveAuthKey(masterKey));
    const kek = deriveKek(masterKey);
    const dek = randomDek();
    const registered = await api.register(input.email, authKey, accountSalt);
    await apiForServer(input.serverUrl, registered.token).registerDevice({
      id: state.device.id,
      name: state.device.name,
      platform: state.device.platform,
      pubKey: state.device.pubKey,
      schemaVersion: LOCAL_SCHEMA_VERSION,
    });
    const passwordEnvelope = wrapForPassword(dek, kek);
    await apiForServer(input.serverUrl, registered.token).setPasswordEnvelope(encodeEnvelopeWire(passwordEnvelope));
    storage.write({
      ...state,
      account: {
        serverUrl: input.serverUrl,
        userId: registered.userId,
        email: input.email,
        accountSalt,
        token: registered.token,
      },
      envelopes: {
        password: passwordEnvelope,
        devices: { ...state.envelopes.devices, [state.device.id]: wrapForDevice(dek, state.device.pubKey) },
      },
    });
    setStatus({ phase: "offline", error: null, lastCode: null });
  }

  async function loginAccount(input: { serverUrl: string; email: string; password: string }): Promise<void> {
    const state = storage.read();
    const api = apiForServer(input.serverUrl, null);
    const salt = await api.salt(input.email);
    const masterKey = await masterKeyOf(input.password, salt.accountSalt);
    const authKey = encodeBase64Url(deriveAuthKey(masterKey));
    const kek = deriveKek(masterKey);
    const session = await api.login(input.email, authKey);
    await apiForServer(input.serverUrl, session.token).registerDevice({
      id: state.device.id,
      name: state.device.name,
      platform: state.device.platform,
      pubKey: state.device.pubKey,
      schemaVersion: LOCAL_SCHEMA_VERSION,
    });
    const account = {
      serverUrl: input.serverUrl,
      userId: session.userId,
      email: input.email,
      accountSalt: salt.accountSalt,
      token: session.token,
    };
    const dek = session.keyEnvelope === null ? null : unwrapFromPassword(readEnvelopeWire(session.keyEnvelope), kek);
    if (dek === null) {
      storage.write({ ...state, account });
      setStatus({
        phase: "error",
        error: "appareil non appairé : aucune enveloppe de clé pour ce mot de passe, appairez cet appareil",
        lastCode: "not_paired",
      });
      return;
    }
    storage.write({
      ...state,
      account,
      envelopes: {
        password: wrapForPassword(dek, kek),
        devices: { ...state.envelopes.devices, [state.device.id]: wrapForDevice(dek, state.device.pubKey) },
      },
    });
    setStatus({ phase: "offline", error: null, lastCode: null });
    await syncNow();
  }

  async function logoutAccount(): Promise<void> {
    const state = storage.read();
    let failure: unknown = null;
    if (state.account !== undefined) {
      try {
        await apiFor(state).logout();
      } catch (caught) {
        if (!(caught instanceof SyncHttpError && caught.status === 0)) failure = caught;
      }
    }
    const current = storage.read();
    storage.write({ ...current, account: undefined, envelopes: { devices: {} } });
    setStatus({ phase: "unconfigured", error: null, lastCode: null });
    if (failure !== null) throw failure;
  }

  async function pairStart(serverUrl: string): Promise<{ code: string; expiresAt: string; pollSecret: string }> {
    const state = storage.read();
    const api = apiForServer(serverUrl, null);
    const pollSecret = randomSalt(32);
    const start = await api.startPairing({
      deviceId: state.device.id,
      name: state.device.name,
      platform: state.device.platform,
      publicKey: state.device.pubKey,
      schemaVersion: LOCAL_SCHEMA_VERSION,
      pollSecret,
    });
    pendingPairings.set(start.code, serverUrl);
    return { code: start.code, expiresAt: start.expiresAt, pollSecret };
  }

  async function pairPoll(code: string, pollSecret: string): Promise<"pending" | "completed"> {
    const state = storage.read();
    const serverUrl = pendingPairings.get(code) ?? state.account?.serverUrl;
    if (serverUrl === undefined) {
      throw new Error("appairage impossible : serveur inconnu, lancez pairStart sur ce serveur");
    }
    const api = apiForServer(serverUrl, null);
    const result = await api.pollPairing(code, pollSecret);
    if (result.status === "pending") return "pending";
    const dek = unwrapFromDevice(result.envelope, state.device.privKey);
    if (dek.length !== 32) throw new Error("appairage invalide : clé de 32 octets attendue");
    const accountSalt = result.accountSalt ?? state.account?.accountSalt;
    if (accountSalt === undefined) throw new Error("appairage incomplet : accountSalt absent de la réponse");
    const current = storage.read();
    storage.write({
      ...setDeviceEnvelope(current, result.envelope),
      account: { serverUrl, userId: result.userId, email: current.account?.email ?? "", accountSalt, token: result.token },
    });
    setStatus({ phase: "offline", error: null, lastCode: null });
    pendingPairings.delete(code);
    await syncNow();
    return "completed";
  }

  async function pairClaim(code: string): Promise<{ deviceId: string; fingerprint: string }> {
    const api = apiFor(storage.read());
    const claim = await api.claimPairing(code);
    claims.set(code, claim);
    return { deviceId: claim.deviceId, fingerprint: fingerprintOf(claim.publicKey) };
  }

  async function pairComplete(code: string): Promise<void> {
    const claim = claims.get(code);
    if (claim === undefined) throw new Error("appairage inconnu : appelez pairClaim avant pairComplete");
    const state = storage.read();
    const dek = resolveDek(state);
    if (dek === null) throw new Error("appairage impossible : clé de chiffrement absente");
    const api = apiFor(state);
    await api.completePairing(code, wrapForDevice(dek, claim.publicKey));
    claims.delete(code);
  }

  async function listDevices(): Promise<SyncDevice[]> {
    return apiFor(storage.read()).listDevices();
  }

  async function revokeDevice(id: string): Promise<void> {
    await apiFor(storage.read()).revokeDevice(id);
  }

  return {
    getState: () => storage.read(),
    getStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    syncNow,
    emitLocal,
    readOnly,
    canEmit,
    setAutoSync,
    setPaused,
    isPaused,
    setEnabledKinds,
    createAccount,
    loginAccount,
    logoutAccount,
    pairStart,
    pairClaim,
    pairComplete,
    pairPoll,
    listDevices,
    revokeDevice,
  };
}
