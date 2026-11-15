import { READ_ONLY_NOTICE, demoReadOnly } from "@/lib/demo-mode";

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
  | "mime"
  | "calendar"
  | "caldav";

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

export type ApiPgpDetail = {
  verified: boolean | null;
  signer: string | null;
  decrypted: boolean;
  error: string | null;
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
  pgp_detail?: ApiPgpDetail | null;
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
  /** Délimiteur de hiérarchie IMAP ; `null` quand le serveur n'en publie pas. */
  delimiter?: string | null;
};

export type ApiFolderCount = {
  path: string;
  total: number;
  unread: number;
};

export type ApiAccount = {
  id: string;
  label: string;
  email: string;
  username: string;
  imap: ApiEndpoint;
  smtp: ApiEndpoint;
  folders: number;
  /** `null` : tous les dossiers à rôle connu ; `[]` : aucun. */
  synced_folders?: string[] | null;
  /** Interrupteur PGP du compte : `false` laisse les corps chiffrés fermés. */
  pgp?: boolean;
};

export type ApiHealth = {
  status: string;
  version: string;
  public_url?: string;
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
  /** `null`/absent : dossiers à rôle connu ; `[]` : aucun ; liste : ces chemins-là. */
  synced_folders?: string[] | null;
};

export type DiscoverySource = "ispdb" | "autoconfig" | "well_known" | "guess";

export type ApiDiscoveryEndpoint = ApiEndpoint & { username: string };

export type ApiOAuthStart = {
  session: string;
  auth_url: string;
  redirect_uri: string;
};

export type ApiOAuthStatus = {
  status: "pending" | "code_received" | "done" | "failed";
  account_id?: string;
  error?: string;
};

export type OAuthStartInput = {
  provider: "google" | "microsoft" | "custom";
  email: string;
  label: string;
  id?: string;
  imap: ApiEndpoint;
  smtp: ApiEndpoint;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_endpoint?: string;
  auth_endpoint?: string;
};

export type LiveEvent = {
  type: string;
  account_id: string;
  folder_path: string;
  report?: { folder_path: string; inserted: number; flags_updated: number; removed: number };
};

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

export type DeleteInput = {
  folder_path: string;
  uid: number;
};

export type PurgeInput = {
  folder_path: string;
};

export type PurgeResult = {
  removed: number;
};

/** Corps HTML relu à la demande, images distantes comprises (déjà assaini par le service). */
export type HtmlImages = {
  html: string;
};

/** Un `VEVENT` tel que le démon le projette : jour et heures murales, sans récurrence développée. */
export type ExternalEvent = {
  uid: string | null;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  timezone: string | null;
  location: string | null;
  description: string | null;
  recurring: boolean;
  source: string | null;
};

/** Un événement que le démon vient d'écrire : ses champs et l'etag de la ressource. */
export type WrittenExternalEvent = ExternalEvent & { etag?: string | null };

/** Champs éditables d'un événement CalDAV ; `start` absent : journée entière. */
export type CaldavEventInput = {
  title: string;
  date: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  /** ETag détenu par l'appelant : un etag périmé est refusé par le serveur (412). */
  etag?: string;
};

/** `content` (fichier) ou `url` (abonnement) : jamais les deux. */
export type IcsImport = {
  content?: string;
  url?: string;
  source?: string;
};

/** Une source CalDAV rangée par le démon : les identifiants restent dans son coffre, jamais ici. */
export type CaldavSource = {
  id: string;
  name: string;
  url: string;
  calendar_href?: string;
};

/** Un calendrier du compte Google connecté : le démon le relit avec son refresh token. */
export type GoogleCalendar = {
  id: string;
  summary: string;
  description?: string | null;
  /** Calendrier principal du compte (agenda par défaut) : auto-ajouté à la connexion. */
  primary?: boolean;
};

/** Fenêtre demandée à Google, en RFC 3339 ; absente, c'est Google qui la choisit. */
export type GoogleEventsInput = {
  calendar_id: string;
  time_min?: string;
  time_max?: string;
};

/**
 * Secrets de la synchronisation E2EE : ils vivent dans le coffre du démon
 * (trousseau système ou fichier chiffré), plus dans le `localStorage` du front.
 * `null` : le coffre n'en a pas encore.
 */
export type SyncDeviceKey = { private_key: string | null };

export type SyncAccountToken = { token: string | null };

/** Les identifiants ne voyagent qu'une fois, à la création de la source. */
export type CaldavSourceInput = {
  url: string;
  username: string;
  password: string;
  name?: string;
  calendar_href?: string;
};

export type SendInput = {
  to: ApiAddress[];
  cc: ApiAddress[];
  bcc: ApiAddress[];
  subject: string;
  text: string;
  html?: string;
  pgp_encrypt?: boolean;
  pgp_sign?: boolean;
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

const inShell = typeof window !== "undefined" && ("isTauri" in window || "__TAURI_INTERNALS__" in window);

/** Dans la coquille Tauri (desktop/mobile) le démon est embarqué sur la boucle locale. */
const BASE = inShell ? "http://127.0.0.1:8790/api" : `${import.meta.env.BASE_URL}api`;
const SHORT_TIMEOUT = 15_000;
const LONG_TIMEOUT = 180_000;

/**
 * Jeton du démon. Dans la coquille, la commande Rust le lit dans le répertoire
 * de données ; sur le web, le proxy (Vite ou nginx) l'injecte et le front n'a
 * rien à porter.
 */
let tokenPromise: Promise<string> | null = null;
function daemonToken(): Promise<string> {
  if (!inShell) return Promise.resolve("");
  tokenPromise ??= import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<string>("mail_daemon_token"))
    .catch((error: unknown) => {
      tokenPromise = null;
      throw error;
    });
  return tokenPromise;
}

const KINDS: readonly ApiErrorKind[] = [
  "config",
  "auth",
  "imap",
  "smtp",
  "tls",
  "oauth",
  "store",
  "mime",
  "calendar",
  "caldav",
];

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

async function daemonFetch(
  path: string,
  options: RequestOptions,
  init: (headers: Record<string, string>) => RequestInit,
): Promise<Response> {
  if (demoReadOnly) throw new ApiError(READ_ONLY_NOTICE, "config", 0);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeout ?? SHORT_TIMEOUT);
  const relay = () => controller.abort();
  options.signal?.addEventListener("abort", relay);

  try {
    const token = await daemonToken();
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    const response = await fetch(`${BASE}${path}`, { ...init(headers), signal: controller.signal });
    if (!response.ok) throw await envelope(response);
    return response;
  } catch (error) {
    throw transport(error);
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", relay);
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await daemonFetch(path, options, (headers) => ({
    method: options.method ?? "GET",
    headers: options.body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}

/** Même jeton et même enveloppe d'erreur, mais le corps reste binaire. */
async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await daemonFetch(path, options, (headers) => ({ headers }));
  return await response.blob();
}

const accountPath = (id: string) => `/accounts/${encodeURIComponent(id)}`;

export const mailApi = {
  health: () => request<ApiHealth>("/health"),

  accounts: () => request<ApiAccount[]>("/accounts"),

  discover: (email: string) =>
    request<ApiDiscovery>(`/discover?email=${encodeURIComponent(email)}`, { timeout: 20_000 }),

  createAccount: (input: NewAccount) =>
    request<ApiAccount>("/accounts", { method: "POST", body: input }),

  /** Connexion testée, dossiers listés : rien n'est créé côté démon. */
  previewFolders: (input: NewAccount) =>
    request<ApiFolder[]>("/accounts/preview", { method: "POST", body: input, timeout: LONG_TIMEOUT }),


  renameAccount: (id: string, label: string) =>
    request<ApiAccount | void>(accountPath(id), { method: "PATCH", body: { label } }),

  /** `null` : tous les dossiers à rôle connu ; `[]` : aucun. */
  setSyncFolders: (id: string, folders: string[] | null) =>
    request<ApiAccount>(`${accountPath(id)}/sync-folders`, {
      method: "PATCH",
      body: { folders },
    }),

  /**
   * Interrupteur PGP du compte. Fermé, le démon ne déchiffre plus rien pour lui
   * et efface de la base ce qui avait été déchiffré de messages chiffrés.
   */
  setAccountPgp: (id: string, enabled: boolean) =>
    request<ApiAccount>(`${accountPath(id)}/pgp`, { method: "PATCH", body: { enabled } }),

  deleteAccount: (id: string) => request<void>(accountPath(id), { method: "DELETE" }),

  folders: (id: string) => request<ApiFolder[]>(`${accountPath(id)}/folders`),

  /** Purge le cache local d'un dossier ; le prochain sync le relit sur le serveur. */
  desyncFolder: (id: string, folderPath: string) =>
    request<void>(`${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/local`, {
      method: "DELETE",
    }),

  /** Supprime un dossier personnalisé : le serveur d'abord, le cache local ensuite. */
  deleteFolder: (id: string, folderPath: string) =>
    request<void>(`${accountPath(id)}/folders/${encodeURIComponent(folderPath)}`, {
      method: "DELETE",
    }),

  folderCounts: (id: string) => request<ApiFolderCount[]>(`${accountPath(id)}/folder-counts`),

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

  search: (id: string, query: string, limit = 50) =>
    request<ApiMessage[]>(
      `${accountPath(id)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  message: (id: string, folderPath: string, uid: number) =>
    request<ApiMessage>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}?fetch_body=true`,
      { timeout: LONG_TIMEOUT },
    ),

  /** Les octets d'une pièce jointe : le démon les relit sur le serveur IMAP. */
  attachment: (id: string, folderPath: string, uid: number, index: number) =>
    requestBlob(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}/attachments/${index}`,
      { timeout: LONG_TIMEOUT },
    ),

  /**
   * Le corps HTML relu sur le serveur, images distantes comprises : masquées par
   * défaut, elles ne s'affichent que sur ce choix explicite. Le service renvoie
   * un markup ré-assaini (même liste blanche, plus `img` en http(s)).
   */
  htmlImages: (id: string, folderPath: string, uid: number) =>
    request<HtmlImages>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}/html-images`,
      { timeout: LONG_TIMEOUT },
    ),

  setFlags: (id: string, input: FlagsInput) =>
    request<void>(`${accountPath(id)}/flags`, { method: "POST", body: input }),

  move: (id: string, input: MoveInput) =>
    request<void>(`${accountPath(id)}/move`, { method: "POST", body: input }),

  deleteMessage: (id: string, input: DeleteInput) =>
    request<void>(`${accountPath(id)}/delete`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  purgeFolder: (id: string, input: PurgeInput) =>
    request<PurgeResult>(`${accountPath(id)}/purge`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  /** Lecture seule : le démon analyse le fichier ou télécharge l'URL, rien n'est enregistré chez lui. */
  importIcs: (input: IcsImport) =>
    request<ExternalEvent[]>("/calendars/ics", {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  caldavSources: () => request<CaldavSource[]>("/calendars/caldav/sources"),

  /** Le démon teste la connexion avant de ranger la source ; le mot de passe ne revient jamais. */
  addCaldavSource: (input: CaldavSourceInput) =>
    request<CaldavSource>("/calendars/caldav/sources", {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  removeCaldavSource: (id: string) =>
    request<void>(`/calendars/caldav/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Lecture seule : le démon relit la source avec ses propres identifiants. */
  caldavSourceEvents: (id: string) =>
    request<ExternalEvent[]>(`/calendars/caldav/sources/${encodeURIComponent(id)}/events`, {
      method: "POST",
      timeout: LONG_TIMEOUT,
    }),

  /** Écriture : le démon signe la requête avec les identifiants de son coffre. */
  caldavCreateEvent: (sourceId: string, input: CaldavEventInput) =>
    request<WrittenExternalEvent>(
      `/calendars/caldav/sources/${encodeURIComponent(sourceId)}/events/create`,
      { method: "POST", body: input, timeout: LONG_TIMEOUT },
    ),

  caldavUpdateEvent: (sourceId: string, uid: string, input: CaldavEventInput) =>
    request<WrittenExternalEvent>(
      `/calendars/caldav/sources/${encodeURIComponent(sourceId)}/events/${encodeURIComponent(uid)}`,
      { method: "PUT", body: input, timeout: LONG_TIMEOUT },
    ),

  /** `etag` connu rend la suppression conditionnelle : un serveur qui a bougé répond 412. */
  caldavDeleteEvent: (sourceId: string, uid: string, etag?: string) =>
    request<void>(
      `/calendars/caldav/sources/${encodeURIComponent(sourceId)}/events/${encodeURIComponent(uid)}${
        etag ? `?etag=${encodeURIComponent(etag)}` : ""
      }`,
      { method: "DELETE", timeout: LONG_TIMEOUT },
    ),

  /** Le compte doit être connecté en OAuth2 Google : aucun identifiant ne passe ici. */
  googleCalendars: (accountId: string) =>
    request<GoogleCalendar[]>(`/calendars/google/${encodeURIComponent(accountId)}/calendars`, {
      timeout: LONG_TIMEOUT,
    }),

  /** Lecture seule : le refresh token du compte reste au démon. */
  googleEvents: (accountId: string, input: GoogleEventsInput) =>
    request<ExternalEvent[]>(`/calendars/google/${encodeURIComponent(accountId)}/events`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  oauthStart: (input: OAuthStartInput) =>
    request<ApiOAuthStart>("/oauth/start", { method: "POST", body: input }),

  syncDeviceKey: () => request<SyncDeviceKey>("/sync/secrets/device"),

  setSyncDeviceKey: (privateKey: string) =>
    request<void>("/sync/secrets/device", { method: "PUT", body: { private_key: privateKey } }),

  syncAccountToken: (accountId: string) =>
    request<SyncAccountToken>(`/sync/secrets/accounts/${encodeURIComponent(accountId)}`),

  setSyncAccountToken: (accountId: string, token: string) =>
    request<void>(`/sync/secrets/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: { token },
    }),

  deleteSyncAccountToken: (accountId: string) =>
    request<void>(`/sync/secrets/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),

  oauthStatus: (session: string) =>
    request<ApiOAuthStatus>(`/oauth/status?session=${encodeURIComponent(session)}`),

  oauthComplete: (session: string) =>
    request<ApiOAuthStatus>("/oauth/complete", {
      method: "POST",
      body: { session },
      timeout: LONG_TIMEOUT,
    }),

  /** `EventSource` ne porte pas d'en-tête : dans la coquille, le jeton passe en query. */
  eventsUrl: async () => {
    const token = await daemonToken();
    return token ? `${BASE}/events?token=${encodeURIComponent(token)}` : `${BASE}/events`;
  },

  send: (id: string, input: SendInput) =>
    request<void>(`${accountPath(id)}/send`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),
  saveDraft: (id: string, input: SendInput) =>
    request<void>(`${accountPath(id)}/drafts`, {
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
