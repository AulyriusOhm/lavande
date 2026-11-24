import { READ_ONLY_NOTICE, demoReadOnly } from "@/lib/demo-mode";
import { searchParams } from "@/lib/search-query";
import type { SearchFilter } from "@/lib/search-query";

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
  | "oauth_revoked"
  | "store"
  | "mime"
  | "calendar"
  | "caldav"
  | "carddav"
  | "soap"
  | "zimbra";

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

/** Un contact déduit du courrier échangé, tous comptes fusionnés. */
export type ApiContact = {
  email: string;
  name: string | null;
  received: number;
  sent: number;
  last_seen: string | null;
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
  /** `null`/absent : la réception (INBOX + dossiers perso) ; `[]` : aucun. */
  ai_folders?: string[] | null;
  /** Interrupteur PGP du compte : `false` laisse les corps chiffrés fermés. */
  pgp?: boolean;
  /** Le refresh token a été refusé : le consentement OAuth est à refaire. */
  needs_reauth?: boolean;
  auth_kind?: "password" | "oauth2";
};

export type ZimbraFilterCondition = "anyof" | "allof";

export type ZimbraFilterComparison =
  | "contains"
  | "notcontains"
  | "is"
  | "notis"
  | "matches"
  | "notmatches";

export type ZimbraAddressPart = "all" | "localpart" | "domain";

export type ZimbraFilterTest =
  | { kind: "header"; header: string; comparison: ZimbraFilterComparison; value: string }
  | {
      kind: "address";
      header: string;
      part: ZimbraAddressPart;
      comparison: ZimbraFilterComparison;
      value: string;
    }
  | { kind: "size"; comparison: "over" | "under"; size: string }
  | { kind: "date"; comparison: "before" | "after"; date: string };

export type ZimbraFilterAction =
  | { kind: "keep" }
  | { kind: "discard" }
  | { kind: "stop" }
  | { kind: "file_into"; folder_path: string }
  | { kind: "tag"; tag_name: string }
  | { kind: "flag"; flag_name: string }
  | { kind: "redirect"; address: string };

/** Une règle de filtrage du serveur. `read_only` marque celles que le démon ne réécrit pas. */
export type ZimbraFilter = {
  name: string;
  active: boolean;
  condition: ZimbraFilterCondition;
  tests: ZimbraFilterTest[];
  actions: ZimbraFilterAction[];
  read_only: boolean;
};

/** Une règle telle que le formulaire l'envoie : `read_only` ne vient que du serveur. */
export type ZimbraFilterInput = Omit<ZimbraFilter, "read_only">;

export type ZimbraFilterChange =
  | { action: "add" | "modify"; rule: ZimbraFilterInput }
  | { action: "delete"; rule: { name: string } };

/** Une collection CalDAV d'un compte ou d'une source : `href` est son URL. */
export type CaldavCollection = {
  href: string;
  name: string;
  description?: string;
  color?: string;
};

/** Un créneau de disponibilité d'un invité, en millisecondes depuis l'époque. */
export type ZimbraFreeBusySlot = {
  start: number;
  end: number;
  status: "busy" | "tentative" | "free" | "out" | "unknown";
};

export type ZimbraFreeBusyUser = {
  email: string;
  slots: ZimbraFreeBusySlot[];
};

/** Une étiquette du compte Zimbra : `color` est le numéro du serveur (0 = aucune). */
export type ZimbraTag = {
  id: string;
  name: string;
  color: number;
  count?: number;
};

/** Une entrée de l'annuaire d'entreprise : un contact, une liste de diffusion ou une ressource. */
export type ZimbraGalEntry = {
  email: string;
  name: string;
  kind: "contact" | "group";
};

/** Réponse d'absence : le serveur la garde, le démon l'écrit avec son mot de passe. */
export type ZimbraVacation = {
  enabled: boolean;
  message: string;
  from?: string | null;
  until?: string | null;
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

/** Device flow GitHub Copilot : le démon garde les jetons, le front ne voit que le code. */
export type ApiCopilotStart = {
  session: string;
  verification_uri: string;
  user_code: string;
  interval: number;
  expires_in: number;
};

export type ApiCopilotStatus = {
  status: "pending" | "done" | "failed" | "expired";
  interval: number;
  error?: string;
  login?: string | null;
};

export type ApiCopilotSession = { connected: boolean; login: string | null };

export type ApiCopilotModel = { id: string; name: string };

export type AiChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiChatInput = { model: string; messages: AiChatMessage[]; temperature?: number };

export type AiChatReply = {
  choices?: { message?: { content?: string } }[];
  usage?: unknown;
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

export type LiveMail = {
  id: string;
  account: string;
  label: string;
  subject: string;
  from: string;
  date: number | null;
  unread: boolean;
  message_id?: string | null;
  decision_category?: string;
  decision_urgency?: number;
  category?: string;
  urgency?: number;
  should_notify?: boolean;
  totp_code?: string;
  totp_service?: string;
};

export type LiveEvent = {
  type: string;
  account_id: string;
  folder_path: string;
  report?: { folder_path: string; inserted: number; flags_updated: number; removed: number };
  new_mails?: LiveMail[];
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

export type FlagsBulkInput = {
  folder_path: string;
  uids: number[];
  unread: boolean;
  starred: boolean;
};

export type MoveBulkInput = {
  from_path: string;
  uids: number[];
  to_path: string;
};

export type DeleteBulkInput = {
  folder_path: string;
  uids: number[];
};

export type ApiDecisionThresholds = {
  llm_escalate: number;
  category: number;
  security: number;
  folder: number;
};

export type ApiCustomCategory = {
  id: string;
  name: string;
  description: string;
  color: string;
  exclude_from_priority: boolean;
  allow_notifications: boolean;
  cleanup_eligible: boolean;
};

export type ApiDecisionConfig = {
  enabled: boolean;
  provider: "neuralwatt" | "baseten" | "jev" | "custom";
  protocol: "systemone" | "jev";
  endpoint: string;
  model: string;
  auth_header: "bearer" | "api_key" | "none";
  thresholds: ApiDecisionThresholds;
  custom_categories: ApiCustomCategory[];
  default_inbox_filter: string;
  notif_mode: "all" | "smart" | "urgent_only";
  pre_send_guard: boolean;
  totp_popup: boolean;
  spam_enabled: boolean;
  trusted_senders: string[];
  trusted_domains: string[];
  /** Mails les plus récents passés au modèle de décision (10 à 200). */
  recent_mail_count: number;
};

export type ApiDecisionPublicConfig = ApiDecisionConfig & {
  has_api_key: boolean;
  ready: boolean;
};

export type ApiDecisionConfigUpdate = ApiDecisionConfig & {
  api_key?: string;
  clear_api_key?: boolean;
};

export type ApiDecisionProbeInput = {
  provider?: ApiDecisionConfig["provider"];
  protocol?: ApiDecisionConfig["protocol"];
  endpoint?: string;
  model?: string;
  auth_header?: ApiDecisionConfig["auth_header"];
  api_key?: string;
};

export type ApiDecisionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
};

export type ApiDecisionEnergy = {
  energy_joules: number;
  energy_kwh: number;
  avg_power_watts: number;
  duration_seconds: number;
};

export type ApiDecisionProbeReply = {
  ok: boolean;
  model: string;
  latency_ms: number;
  answer: number;
  usage: ApiDecisionUsage;
  energy?: ApiDecisionEnergy;
};

export type ApiDecisionDecideInput = {
  state: unknown;
  questions: Record<string, unknown>;
  timeout_ms?: number;
};

export type ApiDecisionOutput = {
  model: string;
  answers: Record<
    string,
    {
      type: string;
      choice?: string;
      noul?: number;
      score?: number;
      probabilities?: Record<string, number>;
      confidence?: number;
    }
  >;
  usage: ApiDecisionUsage;
  energy?: ApiDecisionEnergy;
  latency_ms: number;
};

export type ApiMailDecision = {
  account_id: string;
  folder_path: string;
  uid: number;
  message_id?: string | null;
  content_hash: string;
  schema_version: number;
  model: string;
  category: string;
  category_conf: number;
  category_probs: Record<string, number>;
  urgency: number;
  needs_reply: number;
  has_task: number;
  has_event: number;
  security: string;
  security_conf: number;
  cleanup_score: number;
  assignee?: string | null;
  assignee_conf?: number | null;
  totp_code?: string | null;
  totp_service?: string | null;
  suggested_folder?: string | null;
  suggested_folder_conf?: number | null;
  decided_at: number;
  source: "local" | "synced" | string;
};

export type ApiTriageBatchInput = {
  targets: { account_id: string; folder_path: string; uid: number }[];
  team_members?: string[];
  force?: boolean;
};

export type ApiTriageBatchReply = {
  results: {
    decision: ApiMailDecision;
    cached: boolean;
    usage?: ApiDecisionUsage;
    energy?: ApiDecisionEnergy;
    latency_ms?: number;
  }[];
  errors: string[];
};

/** Ce qu'une synchronisation du carnet CardDAV a rapporté. */
export type CarddavSyncReport = {
  /** Adresses retenues du carnet. */
  count: number;
  /** Cartes illisibles, ignorées. */
  skipped: number;
};

/** Corps HTML relu à la demande, images distantes comprises (déjà assaini par le service). */
export type HtmlImages = {
  html: string;
};

/**
 * Un `VEVENT` tel que le démon le projette : jour et heures murales, une entrée
 * par occurrence. `recurrence_id` distingue les occurrences d'une même série.
 */
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
  /** Instant UTC du créneau de l'occurrence (`AAAAMMJJTHHMMSSZ`) ; absent hors série. */
  recurrence_id?: string | null;
  /** Adresse de l'organisateur, `mailto:` retiré. */
  organizer?: string | null;
  /** Adresses des invités, `mailto:` retiré. */
  attendees?: string[] | null;
  source: string | null;
};

/** Qui convie un événement reçu (`ORGANIZER` du VEVENT iTIP). */
export type InvitationParty = {
  name: string | null;
  email: string;
};

/** Un invité d'une invitation, avec la réponse qu'il a donnée. */
export type InvitationGuest = {
  email: string;
  name: string | null;
  /** `NEEDS-ACTION`, `ACCEPTED`, `TENTATIVE`, `DECLINED`… */
  partstat: string;
  role: string | null;
};

/** La pièce `text/calendar` d'un message, telle que le démon la projette. */
export type Invitation = {
  /** `REQUEST`, `CANCEL`, `REPLY`… : `REQUEST` quand le producteur l'a omis. */
  method: string | null;
  uid: string | null;
  summary: string;
  date: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  timezone: string | null;
  organizer: InvitationParty | null;
  attendees: InvitationGuest[];
  sequence: number | null;
};

/** Les trois réponses qu'un lecteur peut donner, en `PARTSTAT`. */
export type RsvpStatus = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/** Comment la réponse est partie : serveur CalDAV, ou mail à l'organisateur. */
export type RsvpOutcome = {
  via: "caldav" | "mail";
  invitation: Invitation;
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
  /** Invités : le démon écrit `ORGANIZER`/`ATTENDEE`, le serveur envoie les invitations. */
  attendees?: string[];
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
  /** Compte mail dont la source emprunte les identifiants (agenda Zimbra). */
  account_id?: string;
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
/** Le démon borne un appel Copilot à 60 s : la marge laisse la réponse arriver. */
const AI_TIMEOUT = 90_000;

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
  "oauth_revoked",
  "store",
  "mime",
  "calendar",
  "caldav",
  "carddav",
  "soap",
  "zimbra",
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

  /** Dossiers analysés par l'IA : `null` = réception (INBOX + dossiers perso), `[]` = aucun. */
  setAiFolders: (id: string, folders: string[] | null) =>
    request<ApiAccount>(`${accountPath(id)}/ai-folders`, {
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

  /** Carnet déduit du courrier échangé : `q` filtre le nom ou l'adresse, vide pour tout. */
  contacts: (query = "", limit = 20) =>
    request<ApiContact[]>(`/contacts?q=${encodeURIComponent(query)}&limit=${limit}`),

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

  /**
   * Les aperçus manquants d'une liste : le démon relit les messages concernés
   * sur le serveur et ne rend que ceux qu'il a pu remplir.
   */
  previews: (id: string, folderPath: string, uids: number[]) =>
    request<{ uid: number; preview: string }[]>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/previews`,
      { method: "POST", body: { uids }, timeout: LONG_TIMEOUT },
    ),

  /** Le fil complet, tous dossiers du compte confondus : corps compris en base seulement. */
  thread: (id: string, threadId: string) =>
    request<ApiThread>(`${accountPath(id)}/threads/${encodeURIComponent(threadId)}`),

  search: (id: string, query: string, limit = 50, filter: SearchFilter & { offset?: number } = {}) =>
    request<ApiMessage[]>(`${accountPath(id)}/search?${searchParams(query, limit, filter)}`),

  message: (id: string, folderPath: string, uid: number) =>
    request<ApiMessage>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}?fetch_body=true`,
      { timeout: LONG_TIMEOUT },
    ),

  /** Lit le carnet CardDAV du compte (annuaire Zimbra) dans la liste des contacts. */
  syncCarddav: (id: string) =>
    request<CarddavSyncReport>(`${accountPath(id)}/carddav/sync`, {
      method: "POST",
      body: {},
      timeout: LONG_TIMEOUT,
    }),

  /** L'invitation iTIP du message (`null` quand il n'en porte pas). */
  invitation: (id: string, folderPath: string, uid: number) =>
    request<Invitation | null>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}/invitation`,
      { timeout: LONG_TIMEOUT },
    ),

  /** Répond à une invitation : CalDAV d'abord, mail à l'organisateur en repli. */
  rsvp: (id: string, folderPath: string, uid: number, status: RsvpStatus) =>
    request<RsvpOutcome>(
      `${accountPath(id)}/folders/${encodeURIComponent(folderPath)}/messages/${uid}/invitation/rsvp`,
      { method: "POST", body: { status }, timeout: LONG_TIMEOUT },
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

  bulkFlags: (id: string, input: FlagsBulkInput) =>
    request<void>(`${accountPath(id)}/flags-bulk`, { method: "POST", body: input }),

  bulkMove: (id: string, input: MoveBulkInput) =>
    request<void>(`${accountPath(id)}/move-bulk`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  bulkDelete: (id: string, input: DeleteBulkInput) =>
    request<void>(`${accountPath(id)}/delete-bulk`, {
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

  /** Agenda d'un compte mail connecté (Zimbra) : le démon lit son CalDAV avec le mot de passe du compte. */
  addCaldavSourceFromAccount: (accountId: string, calendarHref?: string) =>
    request<CaldavSource>("/calendars/caldav/sources/from-account", {
      method: "POST",
      body: calendarHref ? { account_id: accountId, calendar_href: calendarHref } : { account_id: accountId },
      timeout: LONG_TIMEOUT,
    }),

  /** Collections d'un serveur CalDAV : les identifiants passent dans le corps. */
  caldavCollections: (input: { url: string; username: string; password: string }) =>
    request<CaldavCollection[]>("/calendars/caldav/collections", {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  /** Collections du serveur CalDAV d'un compte : le mot de passe reste au coffre. */
  accountCaldavCollections: (id: string) =>
    request<CaldavCollection[]>(`/accounts/${encodeURIComponent(id)}/caldav/collections`, {
      timeout: LONG_TIMEOUT,
    }),

  /** Collections du serveur d'une source déjà rangée, relues avec ses identifiants. */
  sourceCaldavCollections: (id: string) =>
    request<CaldavCollection[]>(`/calendars/caldav/sources/${encodeURIComponent(id)}/collections`, {
      timeout: LONG_TIMEOUT,
    }),

  /** Change la collection d'une source ; `null` relit tous les calendriers découverts. */
  updateCaldavSource: (id: string, input: { calendar_href: string | null }) =>
    request<CaldavSource>(`/calendars/caldav/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
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

  /** Nouveau consentement pour un compte déjà connecté : le refresh token est remplacé. */
  oauthReconnect: (accountId: string) =>
    request<ApiOAuthStart>("/oauth/reconnect", { method: "POST", body: { account_id: accountId } }),

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

  copilotStart: (clientId?: string) =>
    request<ApiCopilotStart>("/ai/copilot/start", {
      method: "POST",
      body: clientId?.trim() ? { client_id: clientId.trim() } : {},
    }),

  copilotStatus: (session: string) =>
    request<ApiCopilotStatus>(`/ai/copilot/status?session=${encodeURIComponent(session)}`),

  /** Jamais de jeton : seulement le drapeau et le login GitHub. */
  copilotSession: () => request<ApiCopilotSession>("/ai/copilot/session"),

  /** Modèles que l'abonnement Copilot du compte connecté peut réellement servir. */
  copilotModels: () => request<ApiCopilotModel[]>("/ai/copilot/models"),

  copilotLogout: () => request<{ ok: boolean }>("/ai/copilot/logout", { method: "POST" }),

  /** Réponse au format OpenAI, obtenue par le proxy du démon. */
  aiChat: (input: AiChatInput, signal?: AbortSignal) =>
    request<AiChatReply>("/ai/chat", { method: "POST", body: input, timeout: AI_TIMEOUT, signal }),

  /** Configuration du modèle de décision (Système 1) côté démon : la clé reste au trousseau. */
  decisionConfig: () => request<ApiDecisionPublicConfig>("/ai/decision/config"),

  saveDecisionConfig: (input: ApiDecisionConfigUpdate) =>
    request<ApiDecisionPublicConfig>("/ai/decision/config", { method: "PUT", body: input }),

  decisionProbe: (input: ApiDecisionProbeInput = {}) =>
    request<ApiDecisionProbeReply>("/ai/decision/probe", {
      method: "POST",
      body: input,
      timeout: AI_TIMEOUT,
    }),

  decisionDecide: (input: ApiDecisionDecideInput, signal?: AbortSignal) =>
    request<ApiDecisionOutput>("/ai/decision/decide", {
      method: "POST",
      body: input,
      timeout: AI_TIMEOUT,
      signal,
    }),

  listDecisions: (params?: { accountId?: string; folderPath?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.accountId) query.set("account_id", params.accountId);
    if (params?.folderPath) query.set("folder_path", params.folderPath);
    if (params?.limit) query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<ApiMailDecision[]>(`/ai/decisions${suffix}`);
  },

  clearDecisions: (accountId?: string) =>
    request<{ removed: number }>(
      accountId ? `/ai/decisions?account_id=${encodeURIComponent(accountId)}` : "/ai/decisions",
      { method: "DELETE" },
    ),

  triageDecisions: (input: ApiTriageBatchInput) =>
    request<ApiTriageBatchReply>("/ai/decisions/triage", {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  importDecisions: (decisions: ApiMailDecision[]) =>
    request<{ imported: number; skipped: number }>("/ai/decisions/import", {
      method: "POST",
      body: { decisions },
    }),

  oauthComplete: (session: string) =>
    request<ApiOAuthStatus>("/oauth/complete", {
      method: "POST",
      body: { session },
      timeout: LONG_TIMEOUT,
    }),

  /** Filtres du serveur Zimbra du compte : le serveur en est la seule source. */
  zimbraFilters: (id: string) =>
    request<ZimbraFilter[]>(`${accountPath(id)}/zimbra/filters`, { timeout: LONG_TIMEOUT }),

  /** Le démon relit la liste, l'amende, puis renvoie la liste entière au serveur. */
  zimbraModifyFilter: (id: string, change: ZimbraFilterChange) =>
    request<void>(`${accountPath(id)}/zimbra/filters`, {
      method: "POST",
      body: change,
      timeout: LONG_TIMEOUT,
    }),

  zimbraVacation: (id: string) =>
    request<ZimbraVacation>(`${accountPath(id)}/zimbra/vacation`, { timeout: LONG_TIMEOUT }),

  zimbraSetVacation: (id: string, vacation: ZimbraVacation) =>
    request<void>(`${accountPath(id)}/zimbra/vacation`, {
      method: "PUT",
      body: vacation,
      timeout: LONG_TIMEOUT,
    }),

  /** Étiquettes du compte, telles que le serveur les garde. */
  zimbraTags: (id: string) =>
    request<ZimbraTag[]>(`${accountPath(id)}/zimbra/tags`, { timeout: LONG_TIMEOUT }),

  zimbraCreateTag: (id: string, input: { name: string; color: number }) =>
    request<ZimbraTag>(`${accountPath(id)}/zimbra/tags`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  zimbraModifyTag: (id: string, tagId: string, input: { name?: string; color?: number }) =>
    request<void>(`${accountPath(id)}/zimbra/tags/${encodeURIComponent(tagId)}`, {
      method: "PATCH",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  zimbraDeleteTag: (id: string, tagId: string) =>
    request<void>(`${accountPath(id)}/zimbra/tags/${encodeURIComponent(tagId)}`, {
      method: "DELETE",
      timeout: LONG_TIMEOUT,
    }),

  /** Étiquettes d'un message : le démon le retrouve par son `Message-ID`. */
  zimbraMessageTags: (id: string, folder: string, uid: number) =>
    request<ZimbraTag[]>(
      `${accountPath(id)}/zimbra/message-tags?folder=${encodeURIComponent(folder)}&uid=${uid}`,
      { timeout: LONG_TIMEOUT },
    ),

  /** Pose ou retire une étiquette, et rend les étiquettes du message après coup. */
  zimbraTagMessage: (id: string, input: { folder: string; uid: number; tag_id: string; add: boolean }) =>
    request<ZimbraTag[]>(`${accountPath(id)}/zimbra/message-tags`, {
      method: "POST",
      body: input,
      timeout: LONG_TIMEOUT,
    }),

  /** Annuaire de l'entreprise (GAL) : contacts, listes de diffusion, ressources. */
  zimbraGal: (id: string, query: string, limit = 8) =>
    request<ZimbraGalEntry[]>(
      `${accountPath(id)}/zimbra/gal?q=${encodeURIComponent(query)}&limit=${limit}`,
      { timeout: LONG_TIMEOUT },
    ),

  /** Disponibilités des invités : le serveur Zimbra du compte répond pour ses agendas. */
  zimbraFreeBusy: (id: string, input: { emails: string[]; from: number; to: number }) =>
    request<ZimbraFreeBusyUser[]>(`${accountPath(id)}/zimbra/freebusy`, {
      method: "POST",
      body: input,
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

/**
 * Suit le consentement jusqu'à son issue : le code reçu est échangé, puis la
 * session est réinterrogée. Rend `failed` au bout de cinq minutes sans retour.
 */
export async function waitForOAuthSession(session: string): Promise<ApiOAuthStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await mailApi.oauthStatus(session);
    if (status.status === "code_received") {
      await mailApi.oauthComplete(session).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (status.status !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { status: "failed", error: "délai de consentement dépassé" };
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "network" || error.kind === "timeout") return error.message;
    return `${error.kind} · ${error.message}`;
  }
  return error instanceof Error ? error.message : "erreur inconnue";
}
