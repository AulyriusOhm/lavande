/**
 * Client HTTP du démon mail local (`lavande-maild`).
 *
 * Le contrat est celui exposé par `crates/mail-api` : les corps sont les
 * structures de `crates/mail-core/src/model.rs`, sérialisées telles quelles.
 */

export type Encryption = "tls" | "start_tls" | "plain";

export type ApiFolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "trash"
  | "spam"
  | "other";

export type ApiPgpState = "none" | "signed" | "encrypted";

export type ApiErrorKind =
  | "config"
  | "auth"
  | "imap"
  | "smtp"
  | "tls"
  | "oauth"
  | "store"
  | "mime";

export type ApiEndpoint = {
  host: string;
  port: number;
  encryption: Encryption;
};

export type ApiAddress = {
  name: string | null;
  email: string;
};

export type ApiFlags = {
  unread: boolean;
  starred: boolean;
  answered: boolean;
};

export type ApiAttachment = {
  filename: string;
  mime: string;
  size: number;
  inline: boolean;
};

export type ApiMessage = {
  account_id: string;
  folder_path: string;
  uid: number;
  uidvalidity: number;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from: ApiAddress;
  to: ApiAddress[];
  cc: ApiAddress[];
  subject: string;
  date: string | null;
  flags: ApiFlags;
  size: number;
  pgp: ApiPgpState;
  preview: string;
  body_text: string | null;
  body_html: string | null;
  attachments: ApiAttachment[];
};

export type ApiThread = {
  id: string;
  account_id: string;
  messages: ApiMessage[];
  primary: ApiMessage;
  count: number;
  unread: number;
  starred: boolean;
  encrypted: number;
  attachments: number;
  participants: string[];
  subject: string;
  preview: string;
};

export type ApiFolder = {
  account_id: string;
  path: string;
  name: string;
  role: ApiFolderRole;
  uidvalidity: number;
  uidnext: number;
  last_sync_at: string | null;
};

export type ApiAccount = {
  id: string;
  label: string;
  email: string;
  username: string;
  imap: ApiEndpoint;
  smtp: ApiEndpoint;
  folders: number;
};

export type ApiHealth = {
  status: string;
  version: string;
};

export type FolderReport = {
  folder_path: string;
  inserted: number;
  flags_updated: number;
  removed: number;
  uidvalidity_changed: boolean;
  uidnext: number;
};

export type SyncResult = {
  reports: FolderReport[];
};

export type NewAccount = {
  id: string;
  label: string;
  email: string;
  username: string;
  imap: ApiEndpoint;
  smtp: ApiEndpoint;
  auth: { kind: "password"; password: string };
};

export type DiscoverySource = "ispdb" | "autoconfig" | "well_known" | "guess";

export type ApiDiscoveryEndpoint = ApiEndpoint & { username: string };

export type ApiDiscovery = {
  found: boolean;
  source: DiscoverySource | null;
  url?: string;
  provider?: string;
  display_name?: string;
  incoming?: ApiDiscoveryEndpoint;
  outgoing?: ApiDiscoveryEndpoint;
  auth?: ("password" | "oauth2")[];
  reason?: string;
};

export type FlagsInput = {
  folder_path: string;
  uid: number;
  unread: boolean;
  starred: boolean;
};

export type MoveInput = {
  from_path: string;
  uid: number;
  to_path: string;
};

export type SendInput = {
  to: ApiAddress[];
  cc: ApiAddress[];
  bcc: ApiAddress[];
  subject: string;
  text: string;
  html?: string;
  in_reply_to?: string;
  references?: string[];
  attachments?: { filename: string; mime: string; data_base64: string }[];
};

/** `kind` reprend les familles du serveur ; `network` et `timeout` viennent du client. */
export type FailureKind = ApiErrorKind | "network" | "timeout";

export class ApiError extends Error {
  readonly kind: FailureKind;
  readonly status: number;

  constructor(message: string, kind: FailureKind, status: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

const BASE = `${import.meta.env.BASE_URL}api`;
const SHORT_TIMEOUT = 15_000;
const LONG_TIMEOUT = 180_000;

const KINDS: readonly ApiErrorKind[] = [
  "config",
  "auth",
  "imap",
  "smtp",
  "tls",
  "oauth",
  "store",
  "mime",
];

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
};

function isErrorKind(value: unknown): value is ApiErrorKind {
  return typeof value === "string" && KINDS.some((kind) => kind === value);
}

async function envelope(response: Response): Promise<ApiError> {
  let message = `le service a répondu ${response.status}`;
  let kind: ApiErrorKind = "config";
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object") {
      const { error, kind: raw } = payload as { error?: unknown; kind?: unknown };
      if (typeof error === "string" && error.trim()) message = error;
      if (isErrorKind(raw)) kind = raw;
    }
  } catch {
    message = `${message} (${response.statusText || "sans corps"})`;
  }
  return new ApiError(message, kind, response.status);
}

function transport(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError("délai dépassé : le service mail local ne répond pas", "timeout", 0);
  }
  return new ApiError(error instanceof Error ? error.message : "échec réseau", "network", 0);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeout ?? SHORT_TIMEOUT);
  const relay = () => controller.abort();
  options.signal?.addEventListener("abort", relay);

  try {
    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) throw await envelope(response);
    if (response.status === 204) return undefined as unknown as T;
    return (await response.json()) as T;
  } catch (error) {
    throw transport(error);
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", relay);
  }
}

const accountPath = (id: string) => `/accounts/${encodeURIComponent(id)}`;

export const mailApi = {
  health: () => request<ApiHealth>("/health"),

  accounts: () => request<ApiAccount[]>("/accounts"),

  discover: (email: string) =>
    request<ApiDiscovery>(`/discover?email=${encodeURIComponent(email)}`, { timeout: 20_000 }),

  createAccount: (input: NewAccount) =>
    request<ApiAccount>("/accounts", { method: "POST", body: input }),

  deleteAccount: (id: string) => request<void>(accountPath(id), { method: "DELETE" }),

  folders: (id: string) => request<ApiFolder[]>(`${accountPath(id)}/folders`),

  sync: (id: string, folderPath?: string) =>
    request<SyncResult>(`${accountPath(id)}/sync`, {
      method: "POST",
      body: folderPath === undefined ? {} : { folder_path: folderPath },
      timeout: LONG_TIMEOUT,
    }),

  threads: (id: string, folderPath: string, limit = 100, offset = 0) =>
    request<ApiThread[]>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/threads?limit=${limit}&offset=${offset}`,
    ),

  message: (id: string, folderPath: string, uid: number) =>
    request<ApiMessage>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}?fetch_body=true`,
      { timeout: LONG_TIMEOUT },
    ),

  setFlags: (id: string, input: FlagsInput) =>
    request<void>(`${accountPath(id)}/flags`, { method: "POST", body: input }),

  move: (id: string, input: MoveInput) =>
    request<void>(`${accountPath(id)}/move`, { method: "POST", body: input }),

  send: (id: string, input: SendInput) =>
    request<void>(`${accountPath(id)}/send`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "network" || error.kind === "timeout") return error.message;
    return `${error.kind} · ${error.message}`;
  }
  return error instanceof Error ? error.message : "erreur inconnue";
}
