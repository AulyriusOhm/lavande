import type { EntityKind, WrappedKey } from "./crypto";
import type { SyncOp } from "./storage";

const TIMEOUT_MS = 15_000;
const MAX_PUSH_OPS = 200;
const DEFAULT_PULL_LIMIT = 500;

export type ServerOp = {
  seq: number;
  opId: string;
  deviceId: string;
  kind: EntityKind;
  entityRef: string;
  hlc: string;
  schemaVersion: number;
  nonce: string;
  ciphertext: string;
};

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.code = code;
  }
}

export type SyncDevice = {
  id: string;
  name: string;
  platform: string;
  schemaVersion: number;
  lastSeenAt: string;
  current: boolean;
};

export type RegisterResult = { userId: string; token: string; expiresAt: string; accountSalt: string };

export type LoginResult = {
  token: string;
  expiresAt: string;
  userId: string;
  accountSalt: string;
  keyEnvelope: string | null;
};

export type AccountInfo = { userId: string; email: string; accountSalt: string; devices: SyncDevice[] };

export type SaltResult = { accountSalt: string };

export type PushResult = { acked: string[]; nextSeq: number };

export type PullResult = { ops: ServerOp[]; nextSeq: number; hasMore: boolean };

export type DeviceRegistration = {
  id: string;
  name: string;
  platform: string;
  pubKey: string;
  schemaVersion: number;
};

export type PairingStartInput = {
  deviceId: string;
  name: string;
  platform: string;
  publicKey: string;
  schemaVersion: number;
  pollSecret: string;
};

export type PairingStart = { code: string; expiresAt: string };

export type PairingClaim = {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  platform: string;
  schemaVersion: number;
  fingerprint: string;
};

export type PairingPoll =
  | { status: "pending" }
  | { status: "completed"; token: string; userId: string; accountSalt?: string; envelope: WrappedKey };

type PairingPollWire =
  | { status: "pending" }
  | { status: "completed"; token: string; userId: string; accountSalt?: string; envelope: string };

export type ServerStatus = { serverSchemaVersion: number; minClientSchema: number; headSeq: number };

export type SyncApiOptions = {
  baseUrl: string;
  token?: string | null;
  deviceId: string;
  fetchImpl?: typeof fetch;
};

export type SyncApi = {
  register(email: string, authKey: string, accountSalt: string): Promise<RegisterResult>;
  salt(email: string): Promise<SaltResult>;
  login(email: string, authKey: string): Promise<LoginResult>;
  logout(): Promise<void>;
  setPasswordEnvelope(envelope: string): Promise<void>;
  me(): Promise<AccountInfo>;
  registerDevice(device: DeviceRegistration): Promise<{ deviceId: string }>;
  listDevices(): Promise<SyncDevice[]>;
  revokeDevice(id: string): Promise<void>;
  startPairing(input: PairingStartInput): Promise<PairingStart>;
  claimPairing(code: string): Promise<PairingClaim>;
  completePairing(code: string, envelope: WrappedKey): Promise<void>;
  pollPairing(code: string, pollSecret: string): Promise<PairingPoll>;
  pushOps(ops: SyncOp[]): Promise<PushResult>;
  pullOps(since: number, limit?: number): Promise<PullResult>;
  serverStatus(): Promise<ServerStatus>;
};

type RequestInitLike = {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new Error("url du serveur manquante");
  return trimmed;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = `${baseUrl}${path}`;
  if (query === undefined) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search === "" ? url : `${url}?${search}`;
}

function parseEnvelope(value: string): WrappedKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SyncHttpError(0, "invalid_envelope", "enveloppe d'appairage illisible : JSON attendu");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new SyncHttpError(0, "invalid_envelope", "enveloppe d'appairage invalide");
  }
  const record = parsed as { v?: unknown; ephPub?: unknown; nonce?: unknown; ct?: unknown };
  if (
    record.v !== 1 ||
    typeof record.ephPub !== "string" ||
    typeof record.nonce !== "string" ||
    typeof record.ct !== "string"
  ) {
    throw new SyncHttpError(0, "invalid_envelope", "enveloppe d'appairage invalide");
  }
  return { v: 1, ephPub: record.ephPub, nonce: record.nonce, ct: record.ct };
}

export function createSyncApi(options: SyncApiOptions): SyncApi {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = typeof options.token === "string" && options.token !== "" ? options.token : null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch indisponible : fournissez fetchImpl");


  async function request<T>(method: string, path: string, init: RequestInitLike = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (token !== null) headers.authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(buildUrl(baseUrl, path, init.query), {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SyncHttpError(0, "offline", errorMessage(error, "réseau indisponible"));
    } finally {
      clearTimeout(timer);
    }

    let raw = "";
    try {
      raw = await response.text();
    } catch {
      raw = "";
    }

    if (!response.ok) {
      const parsed = parseJson(raw);
      const code = isRecord(parsed) && typeof parsed.code === "string" && parsed.code !== "" ? parsed.code : "http_error";
      const message = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
      throw new SyncHttpError(response.status, code, message);
    }

    if (raw === "") return undefined as T;
    const parsed = parseJson(raw);
    if (parsed === undefined) {
      throw new SyncHttpError(response.status, "invalid_response", "réponse du serveur illisible : JSON attendu");
    }
    return parsed as T;
  }

  return {
    register(email, authKey, accountSalt) {
      return request<RegisterResult>("POST", "/api/v1/auth/register", { body: { email, authKey, accountSalt } });
    },
    salt(email) {
      return request<SaltResult>("GET", "/api/v1/auth/salt", { query: { email } });
    },
    login(email, authKey) {
      return request<LoginResult>("POST", "/api/v1/auth/login", { body: { email, authKey } });
    },
    async logout() {
      await request<undefined>("POST", "/api/v1/auth/logout");
    },
    async setPasswordEnvelope(envelope) {
      await request<undefined>("POST", "/api/v1/auth/envelope", { body: { envelope } });
    },
    me() {
      return request<AccountInfo>("GET", "/api/v1/me");
    },
    registerDevice(device) {
      return request<{ deviceId: string }>("POST", "/api/v1/devices", {
        body: {
          id: device.id,
          name: device.name,
          platform: device.platform,
          pubKey: device.pubKey,
          schemaVersion: device.schemaVersion,
        },
      });
    },
    listDevices() {
      return request<SyncDevice[] | { devices: SyncDevice[] }>("GET", "/api/v1/devices").then((payload) =>
        Array.isArray(payload) ? payload : payload.devices,
      );
    },
    async revokeDevice(id) {
      await request<undefined>("DELETE", `/api/v1/devices/${encodeURIComponent(id)}`);
    },
    startPairing(input) {
      return request<PairingStart>("POST", "/api/v1/pairing/start", {
        body: {
          deviceId: input.deviceId,
          name: input.name,
          platform: input.platform,
          publicKey: input.publicKey,
          schemaVersion: input.schemaVersion,
          pollSecret: input.pollSecret,
        },
      });
    },
    claimPairing(code) {
      return request<PairingClaim>("POST", "/api/v1/pairing/claim", { body: { code } });
    },
    async completePairing(code, envelope) {
      await request<undefined>("POST", "/api/v1/pairing/complete", {
        body: { code, envelope: JSON.stringify(envelope) },
      });
    },
    async pollPairing(code, pollSecret) {
      const result = await request<PairingPollWire>("POST", `/api/v1/pairing/${encodeURIComponent(code)}/poll`, {
        body: { pollSecret },
      });
      if (result.status === "pending") return { status: "pending" };
      return {
        status: "completed",
        token: result.token,
        userId: result.userId,
        accountSalt: result.accountSalt,
        envelope: parseEnvelope(result.envelope),
      };
    },
    async pushOps(ops) {
      if (ops.length > MAX_PUSH_OPS) {
        throw new Error(`pushOps : ${ops.length} opérations envoyées, maximum ${MAX_PUSH_OPS}`);
      }
      return request<PushResult>("POST", "/api/v1/ops", { body: { ops } });
    },
    pullOps(since, limit = DEFAULT_PULL_LIMIT) {
      return request<PullResult>("GET", "/api/v1/ops", { query: { since, limit } });
    },
    serverStatus() {
      return request<ServerStatus>("GET", "/api/v1/status");
    },
  };
}
