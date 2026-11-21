import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComposeDraft, DraftAttachment } from "@/lib/draft";
import {
  MAX_ATTACHMENT_BYTES,
  base64Size,
  baseDraft,
  emptyDraft,
  firstRecipient,
  formatBytes,
  insertAt,
  mimeOf,
  persistedDraft,
  readBase64,
  retargetDraft,
} from "@/lib/draft";
import { buildQuotedHtml, htmlToText, splitQuotedBody, textToHtml } from "@/lib/rich-text";
import { notifyNewMail, notifyTotpCode, setUnreadBadge } from "@/lib/notify";
import { NOTICE_EVENT } from "@/lib/open-external";
import type { NoticeData } from "@/components/ui/notice";
import { ACCOUNTS, ALL_ACCOUNTS } from "@/lib/accounts";
import type { Account } from "@/lib/accounts";
import { MAILS, UNIFIED_FOLDERS, folderLabel, mailMatches, normalize } from "@/lib/mail";
import type { FolderId, Mail, MailSource } from "@/lib/mail";
import { hasCriteria, mergeCriteria, parseSearchQuery } from "@/lib/search-query";
import type { SearchCriteria, SearchFilter } from "@/lib/search-query";
import { threadOf } from "@/lib/threads";
import type { Thread } from "@/lib/threads";
import type { MailSuggestion, Task } from "@/lib/tasks";
import { dueToneFor, formatDueDate } from "@/lib/tasks";
import {
  currentPeriod,
  generateSummary,
  readSummaryCache,
  recentMails,
  summaryScope,
  summarySignature,
  suggestEvents,
  suggestTasks,
  writeSummaryCache,
} from "@/lib/summary";
import type { SummaryEvent, SummaryMailInput, SummaryRef, SummaryResult, SummaryTask } from "@/lib/summary";
import { analyseMail } from "@/lib/analyse";
import type { AnalyseResult, AnalyseTask } from "@/lib/analyse";
import { sentSamples, styleProfile, threadConversation } from "@/lib/assist";
import { EMPTY_LLM, llmReady } from "@/lib/llm";
import { TODAY_ISO } from "@/lib/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import {
  activeSignature,
  isFolderHidden,
  notificationsForAccount,
  perimeterOf,
  resolvePgp,
  usePrefs,
} from "@/lib/prefs";
import { suggestionsInWindow, usePlanning } from "@/lib/planning-store";
import { allTeamMembers, teamContextOf, teamPromptBlock } from "@/lib/team";
import { decisionMailDocId, syncedDecisionDocs } from "@/lib/ai-sync";
import { decisionDomain, decisionReady, type MailDecision } from "@/lib/decision";
import { decisionDb, decisionMailKey } from "@/lib/decision-db";
import {
  DEMO_DECISIONS_ON,
  DEMO_EXTRA_MAILS,
  DEMO_TOTP_ALERT,
  buildDemoDecisions,
} from "@/lib/demo-decisions";
import {
  filterMailsForLlm,
  fromApiDecision,
  indexDecisions,
  stableDecisionKey,
  toApiDecision,
  triageDecisionFor,
  triageRecentMails,
} from "@/lib/triage";
import { mailApi, errorText } from "@/lib/api";
import type { LiveEvent } from "@/lib/api";
import type { NewAccount } from "@/lib/api";
import { haptic } from "@/lib/haptics";
import { shellLayout } from "@/lib/native";
import {
  READ_ONLY_NOTICE,
  demoReadOnly,
  folderOptions as optionsOf,
  folderOptionsForAll,
  folderPathOf,
  folderTargets,
  loadMailbox,
  mailMode,
  messageToMail,
  PREVIEW_PENDING,
  sendInputOf,
  setAccountDecryptPolicy,
  syncNotice,
  threadMails,
  threadToMails,
} from "@/lib/mail-backend";
import type { FolderOption, FolderRecord, MailMode } from "@/lib/mail-backend";
import {
  isComposeWindow,
  loadPersistedCompose,
  openComposeBus,
  persistCompose,
} from "@/lib/compose-bus";
import type { ComposeBus, ComposeState } from "@/lib/compose-bus";

export type BackendPhase = "loading" | "ready" | "offline" | "empty";

export type TotpAlert = {
  code: string;
  service: string;
  mailId: string;
  receivedAt: number;
};

/** Analyse à la demande du mail ouvert : un seul mail à la fois, cache par mail. */
export type MailAnalyse = {
  mailId: string;
  status: "loading" | "ready" | "error";
  result: AnalyseResult | null;
  error: string | null;
};

export type BulkKind =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "delete"
  | "restore"
  | "inbox";

/** La borne du contrat bulk : au-delà, le démon refuse le lot. */
const BULK_LIMIT = 500;

function foldChunks<T>(list: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < list.length; index += BULK_LIMIT) {
    chunks.push(list.slice(index, index + BULK_LIMIT));
  }
  return chunks;
}

/** Le rôle visé par un déplacement groupé ; `undefined` = suppression définitive. */
function bulkTargetRole(kind: BulkKind, mail: Mail): FolderId | undefined {
  if (kind === "archive") return "archive";
  if (kind === "inbox") return "inbox";
  if (kind === "restore") return mail.previousFolder ?? "inbox";
  if (kind === "delete") return mail.folder === "trash" ? undefined : "trash";
  return undefined;
}

function bulkSummary(kind: BulkKind, count: number, definitive: number): string {
  const plural = count > 1 ? "s" : "";
  const messages = `${count} message${plural}`;
  if (kind === "archive") return `${messages} archivé${plural}`;
  if (kind === "inbox") return `${messages} déplacé${plural} vers la boîte de réception`;
  if (kind === "restore") return `${messages} restauré${plural}`;
  if (definitive === count) return `${messages} supprimé${plural} définitivement`;
  return `${messages} déplacé${plural} vers la corbeille`;
}

const PAGE_SIZE = 50;
const SUMMARY_TICK_MS = 5 * 60_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** La borne de la route des aperçus, par dossier et par requête. */
const PREVIEW_BATCH = 50;

function previewKeyOf(accountId: string, folderPath: string, uid: number): string {
  return `${accountId}\u0000${folderPath}\u0000${uid}`;
}

type PreviewGroup = { accountId: string; folderPath: string; uids: number[] };

/**
 * Les mails de la liste qui attendent encore leur aperçu, groupés par dossier
 * et bornés aux 50 plus récents : les UIDs déjà demandés une fois sont laissés
 * de côté, un serveur muet ne doit pas être réinterrogé à chaque rendu.
 */
function pendingPreviews(mails: Mail[], attempted: Set<string>): PreviewGroup[] {
  const groups = new Map<string, PreviewGroup>();
  const newestFirst = [...mails].sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0));
  for (const mail of newestFirst) {
    const source = mail.source;
    if (!source || mail.bodyFetched || mail.pgp === "encrypted") continue;
    if (mail.preview !== PREVIEW_PENDING) continue;
    if (attempted.has(previewKeyOf(source.accountId, source.folderPath, source.uid))) continue;
    const path = `${source.accountId}\u0000${source.folderPath}`;
    const group = groups.get(path) ?? {
      accountId: source.accountId,
      folderPath: source.folderPath,
      uids: [],
    };
    if (group.uids.length >= PREVIEW_BATCH) continue;
    group.uids.push(source.uid);
    groups.set(path, group);
  }
  return [...groups.values()];
}

const NO_FOLDER_ORDER: string[] = [];

/** Stockage du cache de résumé : absent (SSR, stockage bloqué) = pas de cache. */
function summaryStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Une tâche proposée par le résumé devient une suggestion EN ATTENTE, jamais une tâche. */
function summarySuggestion(task: SummaryTask, mail: Mail | undefined, period: string): MailSuggestion {
  const day = ISO_DAY.test(task.due) ? task.due : "";
  const suggestion: MailSuggestion = {
    id: `summary:${task.mailId ?? "sans-mail"}:${normalize(task.title)}`,
    mailId: task.mailId ?? "",
    account: mail?.account ?? "",
    ai: true,
    from: task.from || mail?.name || "Résumé",
    subject: mail?.subject ?? "",
    proposal: task.title,
    due: day ? formatDueDate(day) : "",
    dueTone: day ? dueToneFor(day) : "none",
    tone: mail?.tone ?? 0,
    description: day ? `${period} · échéance ${formatDueDate(day)}` : period,
  };
  if (task.assignee) suggestion.assignee = task.assignee;
  if (typeof mail?.timestamp === "number") suggestion.timestamp = mail.timestamp;
  return suggestion;
}

type DuplicateCandidate = { mailId: string; title: string; when: string };

const tokensOf = (value: string): string[] =>
  normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);

/**
 * Même mail, même échéance et intitulé proche (égal, contenu, ou 60 % de mots
 * communs) : une action reformulée par le modèle ne devient pas une seconde
 * suggestion.
 */
function nearDuplicate(existing: DuplicateCandidate[], candidate: DuplicateCandidate): boolean {
  if (!candidate.mailId) return false;
  const title = normalize(candidate.title);
  if (!title) return false;
  const tokens = new Set(tokensOf(candidate.title));
  return existing.some((entry) => {
    if (entry.mailId !== candidate.mailId || entry.when !== candidate.when) return false;
    const other = normalize(entry.title);
    if (!other) return false;
    if (other === title || other.includes(title) || title.includes(other)) return true;
    const others = new Set(tokensOf(entry.title));
    if (tokens.size === 0 || others.size === 0) return false;
    const shared = [...tokens].filter((token) => others.has(token)).length;
    return shared / new Set([...tokens, ...others]).size >= 0.6;
  });
}

/** Mail auquel l'utilisateur a déjà répondu : plus rien à en tirer. */
const alreadyReplied = (mail: Mail | undefined): boolean => mail?.answered === true;

const AI_RUNS_KEY = "lavande.ai.runs.v1";
const AI_RUNS_MAX = 16;
type AiRunKind = "tasks" | "events";
type AiRuns = Record<AiRunKind, Record<string, number>>;

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) out[key] = at;
  }
  return out;
}

/** Passages IA déjà payés sur ce poste : un remontage ne rappelle pas le modèle. */
function readAiRuns(): AiRuns {
  try {
    const raw = window.localStorage.getItem(AI_RUNS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { tasks: {}, events: {} };
    const stored = parsed as Record<string, unknown>;
    return { tasks: numberMap(stored.tasks), events: numberMap(stored.events) };
  } catch {
    return { tasks: {}, events: {} };
  }
}

function aiRunDone(kind: AiRunKind, runKey: string): boolean {
  return readAiRuns()[kind][runKey] !== undefined;
}

function markAiRun(kind: AiRunKind, runKey: string): void {
  try {
    const runs = readAiRuns();
    const entries = { ...runs[kind], [runKey]: Date.now() };
    const keys = Object.keys(entries);
    if (keys.length > AI_RUNS_MAX) {
      keys
        .sort((left, right) => entries[left] - entries[right])
        .slice(0, keys.length - AI_RUNS_MAX)
        .forEach((key) => delete entries[key]);
    }
    window.localStorage.setItem(AI_RUNS_KEY, JSON.stringify({ ...runs, [kind]: entries }));
  } catch {
    // stockage plein ou indisponible : la mémoire de session suffit
  }
}

/** Un rendez-vous extrait devient une suggestion d'AGENDA en attente, jamais un événement. */
function eventSuggestion(event: SummaryEvent, mail: Mail | undefined, label: string): MailSuggestion {
  const day = ISO_DAY.test(event.date) ? event.date : "";
  const hours = event.start ? (event.end ? `${event.start}–${event.end}` : event.start) : "";
  const when = [day ? formatDueDate(day) : "", hours].filter(Boolean).join(" ");
  const suggestion: MailSuggestion = {
    id: `event:${event.mailId ?? "sans-mail"}:${event.date}:${normalize(event.title)}`,
    kind: "event",
    mailId: event.mailId ?? "",
    account: mail?.account ?? "",
    ai: true,
    from: event.from || mail?.name || "Résumé",
    subject: mail?.subject ?? "",
    proposal: event.title,
    due: day ? formatDueDate(day) : "",
    dueTone: day ? dueToneFor(day) : "none",
    tone: mail?.tone ?? 0,
    description: [label, when, event.location].filter(Boolean).join(" · "),
    date: event.date,
    start: event.start,
    end: event.end,
  };
  if (event.location) suggestion.location = event.location;
  if (typeof mail?.timestamp === "number") suggestion.timestamp = mail.timestamp;
  return suggestion;
}

export type MailStoreValue = {
  mails: Mail[];
  account: string;
  accountById: (id: string) => Account | undefined;
  accounts: Account[];
  /** Comptes dont le périmètre mails est ouvert : seuls eux paraissent dans la boîte. */
  mailAccounts: Account[];
  folder: FolderId;
  folderPath: string | null;
  folderOptions: FolderOption[];
  /** Dossiers connus du démon, avec leur rôle : de quoi classer les messages d'un fil. */
  folderRecords: FolderRecord[];
  mode: MailMode;
  /** Démo vitrine : lecture seule, aucune mutation ni appel réseau. */
  readOnly: boolean;
  phase: BackendPhase;
  backendError: string | null;
  threadsLoading: boolean;
  pages: number;
  hasMore: boolean;
  syncing: boolean;
  folderStats: (id: FolderId, path?: string) => { total: number; unread: number };
  accountUnread: (accountId: string) => number;
  connectOpen: boolean;
  removeTarget: Account | null;
  tasks: Task[];
  suggestions: MailSuggestion[];
  summary: SummaryResult | null;
  summaryLoading: boolean;
  /** Mails analysés par le résumé en cours, retrouvés dans la liste vivante. */
  summaryMails: Mail[];
  refreshSummary: (force?: boolean) => Promise<void>;
  /**
   * Transforme une action du résumé en suggestion en attente (jamais une tâche).
   * « added » quand une suggestion est née, « existing » quand la dédup l'a déjà.
   */
  proposeSummaryAction: (ref: SummaryRef) => "added" | "existing";
  /** Analyse à la demande du mail ouvert, avec son cache par mail. */
  analyse: MailAnalyse | null;
  runAnalyse: (mail: Mail, force?: boolean) => Promise<void>;
  closeAnalyse: () => void;
  /** Une tâche analysée devient une suggestion en attente, jamais une tâche. */
  acceptAnalyseTask: (task: AnalyseTask) => void;
  /** Un rendez-vous analysé devient une suggestion en attente, jamais un événement. */
  acceptAnalyseEvent: (event: SummaryEvent) => void;
  /** Réponse pré-remplie : ouvre la réponse au mail avec ce corps. */
  openReplyWithBody: (mail: Mail, body: string) => void;
  events: CalendarEvent[];
  selectedDate: string;
  openMail: Mail | null;
  openThread: Thread | undefined;
  /** Message dont le corps est en cours de lecture sur le serveur. */
  bodyFetching: string | null;
  /** Lit le corps d'un message du fil resté en-têtes seuls (messages antérieurs). */
  fetchBody: (mail: Mail) => void;
  notices: NoticeData[];
  composeOpen: boolean;
  composeDraft: ComposeDraft | null;
  composeTitle: string;
  composeDetached: boolean;
  /** Envoi en cours : le bouton d'envoi reste verrouillé jusqu'à la réponse du serveur. */
  composeSending: boolean;
  composeSendError: string | null;
  /** Brouillon serveur repris, tant qu'il n'a pas été réenregistré ou envoyé. */
  draftSource: MailSource | null;
  setAccount: (value: string) => void;
  setFolder: (value: FolderId, path?: string | null) => void;
  loadMore: () => void;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setEvents: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  setSelectedDate: (value: string) => void;
  setComposeDraft: (value: ComposeDraft | null) => void;
  setComposeTitle: (value: string) => void;
  notify: (message: string, action?: { label: string; run: () => void }) => void;
  dismissNotice: () => void;
  toggleStar: (id: string) => void;
  mailAction: (kind: "delete" | "archive" | "read", mail: Mail) => void;
  bulkMailAction: (kind: BulkKind, mails: Mail[]) => void;
  moveToInbox: (mail: Mail) => void;
  moveToFolder: (mail: Mail, folderPath: string) => void;
  restoreMail: (mail: Mail) => void;
  emptyTrash: () => void;
  addSuggestion: (suggestion: MailSuggestion) => void;
  dismissSuggestion: (suggestion: MailSuggestion) => void;
  openMessage: (mail: Mail | string) => void;
  closeMessage: () => void;
  startBlankDraft: () => void;
  resumeDraft: (mail: Mail) => void;
  openComposer: () => void;
  resumeCompose: () => void;
  minimizeCompose: () => void;
  closeCompose: () => void;
  saveToDrafts: (draft: ComposeDraft) => Promise<boolean>;
  detachCompose: () => void;
  dockCompose: () => void;
  detachClosed: () => void;
  replyTo: (mail: Mail, all?: boolean, body?: string) => void;
  /** Réoriente le brouillon courant vers un autre message du fil, corps conservé. */
  setReplyTarget: (mail: Mail, all?: boolean) => void;
  forwardMail: (mail: Mail) => void;
  sendDraft: (draft: ComposeDraft) => void;
  retryBackend: () => void;
  refreshMailbox: () => Promise<void>;
  useDemo: () => void;
  syncFolder: () => void;
  /** Relève un dossier du rail, quel que soit le dossier consulté. */
  syncFolderAt: (role: FolderId, path: string | null) => void;
  /** `input` : la requête tapée (grammaire `search-query`) ou des critères déjà lus.
   * `filters` s'ajoute aux critères (scopes « Non lus », « Fichiers »). */
  searchMails: (input: string | SearchCriteria, filters?: SearchFilter) => Promise<Mail[]>;
  /** La page suivante, mêmes critères ; rend la liste complète à jour. */
  loadMoreSearch: () => Promise<Mail[]>;
  /** La dernière page reçue était pleine : il y a peut-être une suite. */
  searchHasMore: boolean;
  openConnect: () => void;
  closeConnect: () => void;
  createAccount: (input: NewAccount) => Promise<string>;
  renameAccount: (id: string, label: string) => Promise<void>;
  askRemoveAccount: (account: Account) => void;
  cancelRemoveAccount: () => void;
  confirmRemoveAccount: () => void;
  deleteFolder: (path: string, label: string, accountId?: string) => Promise<boolean>;
  /** Dossiers masqués du compte courant, avec leur libellé pour les réafficher. */
  hiddenFolderOptions: FolderOption[];
  hideFolder: (path: string) => void;
  unhideFolder: (path: string) => void;
  /** Ordre d'affichage local des dossiers du compte courant (chemins IMAP). */
  folderOrder: string[];
  setFolderOrder: (paths: string[]) => void;
  /** Décisions Système 1 indexées par clé mail (`accountId:folderPath:uid`). */
  decisions: Record<string, MailDecision>;
  /** Indique si le modèle de décision est prêt (config locale ou trousseau démon). */
  isDecisionReady: boolean;
  /** Alerte TOTP instantanée émise à la réception SSE. */
  totpAlert: TotpAlert | null;
  dismissTotpAlert: () => void;
  /** File de triage bornée (au plus 40 mails récents non en cache, ou `limit` jusqu'à 50). */
  triageMails: (mails: Mail[], force?: boolean, limit?: number) => Promise<void>;
};

/** Une page de recherche par compte : le démon plafonne à 200. */
const SEARCH_PAGE = 50;

/** Tri global des résultats, tous comptes confondus, dédoublonnés par messageId. */
function orderSearchResults(mails: Mail[]): Mail[] {
  const seen = new Set<string>();
  return mails
    .filter((mail) => {
      const key = mail.messageId ?? mail.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

const MailStoreContext = createContext<MailStoreValue | null>(null);

export function MailStoreProvider({ children }: { children: React.ReactNode }) {
  const prefs = usePrefs();
  const pgpPrefs = useMemo(
    () => ({ pgpEncrypt: prefs.pgpEncrypt, pgpSign: prefs.pgpSign, pgpAccounts: prefs.pgpAccounts }),
    [prefs.pgpEncrypt, prefs.pgpSign, prefs.pgpAccounts],
  );
  // Interrupteurs de synchronisation : le maître coupe tous les domaines.
  const mailSyncOn = prefs.sync.enabled && prefs.sync.mails;
  /** Périmètre du compte : hors mails, sa boîte n'est plus relevée du tout. */
  const mailsInPerimeter = useCallback(
    (accountId: string | undefined) =>
      !accountId || perimeterOf(prefs.perimeters, accountId).mails,
    [prefs.perimeters],
  );
  const planning = usePlanning();
  const { tasks, suggestions: storedSuggestions, setTasks, events, setEvents } = planning;
  const [mode, setMode] = useState<MailMode>(mailMode);
  const [phase, setPhase] = useState<BackendPhase>(() => (mode === "demo" ? "ready" : "loading"));
  const [backendError, setBackendError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>(() => (mode === "demo" ? ACCOUNTS : []));
  const [folderRecords, setFolderRecords] = useState<FolderRecord[]>([]);
  const [mails, setMails] = useState<Mail[]>(() =>
    mode === "demo" ? (DEMO_DECISIONS_ON ? [...DEMO_EXTRA_MAILS, ...MAILS] : MAILS) : [],
  );
  const [account, setAccountState] = useState<string>(() => (mode === "demo" ? ALL_ACCOUNTS : ""));
  const [folder, setFolderState] = useState<FolderId>(() => (mode === "demo" ? "unified" : "inbox"));
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  /** UIDs d'aperçu déjà demandés au démon : jamais deux fois le même. */
  const previewAttempts = useRef(new Set<string>());
  const [pages, setPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [folderCounts, setFolderCounts] = useState<Record<string, { total: number; unread: number }>>({});
  const [revision, setRevision] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null);
  const [selectedDate, setSelectedDate] = useState(TODAY_ISO);
  const [openMail, setOpenMail] = useState<Mail | null>(null);
  /** Fil complet du message ouvert, tous dossiers du compte : `null` tant que
   * le démon n'a pas répondu, le fil local fait alors foi. */
  const [fullThread, setFullThread] = useState<Mail[] | null>(null);
  const [bodyFetching, setBodyFetching] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Mail[]>([]);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const searchResultsRef = useRef<Mail[]>([]);
  /** Jeton de la recherche courante : une réponse antérieure ne s'affiche pas. */
  const searchSeq = useRef(0);
  const searchCriteria = useRef<SearchCriteria | null>(null);
  const searchOffset = useRef(0);
  const [notices, setNotices] = useState<NoticeData[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [persistedCompose] = useState(loadPersistedCompose);
  const [composeDraft, setComposeDraftState] = useState<ComposeDraft | null>(
    persistedCompose?.draft ?? null,
  );
  const [composeTitle, setComposeTitle] = useState(persistedCompose?.title ?? "Nouveau message");
  const [composeDetached, setComposeDetached] = useState(false);
  const [composeSending, setComposeSending] = useState(false);
  const [composeSendError, setComposeSendError] = useState<string | null>(null);
  const [draftSource, setDraftSource] = useState<MailSource | null>(
    persistedCompose?.draftSource ?? null,
  );
  const resumedDraftId = useRef<string | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const summaryRun = useRef<string | null>(null);
  const summaryRunning = useRef(false);
  const [decisions, setDecisions] = useState<Record<string, MailDecision>>(() =>
    mode === "demo" && DEMO_DECISIONS_ON ? buildDemoDecisions() : {},
  );
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const [daemonDecisionReady, setDaemonDecisionReady] = useState(false);
  const [totpAlert, setTotpAlert] = useState<TotpAlert | null>(() =>
    mode === "demo" && DEMO_DECISIONS_ON ? DEMO_TOTP_ALERT : null,
  );
  const dismissTotpAlert = useCallback(() => setTotpAlert(null), []);
  const decisionIndex = useMemo(() => indexDecisions(decisions), [decisions]);
  const decisionPrefsRef = useRef(prefs.decision);
  decisionPrefsRef.current = prefs.decision;
  const autoTriagedKeys = useRef(new Set<string>());
  const importedSyncKeys = useRef(new Set<string>());
  const [analyse, setAnalyse] = useState<MailAnalyse | null>(null);
  const analyseRun = useRef<string | null>(null);
  const analyseRunning = useRef(false);
  const taskRun = useRef<string | null>(null);
  const taskRunning = useRef(false);
  const eventRun = useRef<string | null>(null);
  const eventRunning = useRef(false);
  const composeBus = useRef<ComposeBus | null>(null);
  const composeStateRef = useRef<ComposeState>({ draft: null, title: "Nouveau message", detached: false });
  const lastPostedCompose = useRef("");
  const sendDraftRef = useRef<(draft: ComposeDraft) => void>(() => {});
  const composeSendingRef = useRef(false);
  const resumeDraftRef = useRef<(mail: Mail) => void>(() => {});
  const noticeId = useRef(0);

  const setComposeDraft = useCallback((value: ComposeDraft | null) => {
    setComposeDraftState(value);
    setComposeSendError(null);
  }, []);

  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    noticeId.current += 1;
    const entry = { id: noticeId.current, message, actionLabel: action?.label, onAction: action?.run };
    setNotices((current) => [...current, entry]);
  }, []);

  const dismissNotice = useCallback(() => setNotices((current) => current.slice(1)), []);

  /** Démo vitrine : la mutation est refusée et l'utilisateur est prévenu. */
  const readOnlyBlocked = useCallback(() => {
    if (!demoReadOnly) return false;
    notify(READ_ONLY_NOTICE);
    return true;
  }, [notify]);

  const accountById = useCallback(
    (id: string) => accounts.find((entry) => entry.id === id),
    [accounts],
  );

  const mailAccounts = useMemo(
    () => accounts.filter((entry) => perimeterOf(prefs.perimeters, entry.id).mails),
    [accounts, prefs.perimeters],
  );

  const accountRef = useRef(account);
  accountRef.current = account;

  const bootstrap = useCallback(async () => {
    setPhase("loading");
    setBackendError(null);
    try {
      const { accounts: loaded, folders: records } = await loadMailbox();
      setAccounts(loaded);
      setFolderRecords(records);
      if (loaded.length === 0) {
        setMails([]);
        setAccountState("");
        setPhase("empty");
        return;
      }
      const current = accountRef.current;
      const nextAccount =
        current !== ALL_ACCOUNTS && loaded.some((entry) => entry.id === current)
          ? current
          : loaded.length > 1
            ? ALL_ACCOUNTS
            : loaded[0].id;
      setAccountState(nextAccount);
      if (nextAccount === ALL_ACCOUNTS && current !== ALL_ACCOUNTS) setFolderState("unified");
      setPhase("ready");
    } catch (error) {
      setBackendError(errorText(error));
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    if (mode === "api") void bootstrap();
  }, [bootstrap, mode]);

  // Un lien confié au navigateur système peut échouer côté coquille : l'erreur
  // remonte en notice au lieu de disparaître dans la console de la webview.
  useEffect(() => {
    const onNotice = (event: Event) => notify(String((event as CustomEvent).detail));
    window.addEventListener(NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(NOTICE_EVENT, onNotice);
  }, [notify]);

  // Interrupteur PGP effectif de chaque compte : poussé au démon (les corps
  // chiffrés restent fermés en base) et au lecteur (défense en profondeur).
  // Une valeur déjà transmise n'est pas renvoyée.
  const pgpPolicy = useMemo(() => {
    const next: Record<string, boolean> = {};
    for (const entry of accounts) next[entry.id] = resolvePgp(pgpPrefs, entry.id).enabled;
    return next;
  }, [accounts, pgpPrefs]);
  const pushedPgp = useRef<Record<string, boolean>>({});

  useEffect(() => {
    setAccountDecryptPolicy(pgpPolicy);
    if (mode !== "api") return;
    for (const [id, enabled] of Object.entries(pgpPolicy)) {
      if (pushedPgp.current[id] === enabled) continue;
      pushedPgp.current[id] = enabled;
      mailApi.setAccountPgp(id, enabled).catch((error: unknown) => {
        delete pushedPgp.current[id];
        notify(`Interrupteur PGP non transmis · ${errorText(error)}`);
      });
    }
  }, [mode, notify, pgpPolicy]);

  // Le service pousse un événement après chaque détection IDLE : la liste se
  // rafraîchit sans clic, et sans bloquer l'interface.
  const notifyPrefs = useRef(prefs.notifications);
  notifyPrefs.current = prefs.notifications;
  const notifyAccounts = useRef(accounts);
  notifyAccounts.current = accounts;
  const notifyMailAccounts = useRef(mailAccounts);
  notifyMailAccounts.current = mailAccounts;
  const liveMails = useRef(mails);
  liveMails.current = mails;

  const mergeDecisions = useCallback((items: MailDecision[]) => {
    if (items.length === 0) return;
    setDecisions((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of items) {
        const key = decisionMailKey(item.accountId, item.folderPath, item.uid);
        const existing = next[key];
        if (!existing || item.decidedAt >= existing.decidedAt) {
          if (existing !== item) {
            next[key] = item;
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    if (isComposeWindow()) return;
    let cancelled = false;
    void decisionDb()
      .listDecisions()
      .then((cached) => {
        if (!cancelled && cached.length > 0) mergeDecisions(cached);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mergeDecisions]);

  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || isComposeWindow()) return;
    let cancelled = false;
    void mailApi
      .decisionConfig()
      .then((cfg) => {
        if (!cancelled && cfg && typeof cfg.ready === "boolean") {
          setDaemonDecisionReady(cfg.ready);
        }
      })
      .catch(() => {});
    void mailApi
      .listDecisions({ limit: 500 })
      .then((items) => {
        if (cancelled || !Array.isArray(items) || items.length === 0) return;
        const converted = items.map(fromApiDecision);
        void decisionDb().putDecisions(converted).catch(() => {});
        mergeDecisions(converted);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mergeDecisions, mode, phase]);

  const [syncRev, setSyncRev] = useState(0);
  useEffect(
    () => planning.engine.subscribe(() => setSyncRev((value) => value + 1)),
    [planning.engine],
  );
  const syncDocs = useMemo(
    () => planning.engine.getState().docs,
    [planning.engine, syncRev],
  );

  useEffect(() => {
    if (isComposeWindow()) return;
    const synced = syncedDecisionDocs(syncDocs);
    if (synced.length === 0) return;
    const unseen = synced.filter((item) => {
      const token = `${stableDecisionKey(item)}:${item.decidedAt}`;
      return !importedSyncKeys.current.has(token);
    });
    if (unseen.length === 0) return;
    for (const item of unseen) {
      importedSyncKeys.current.add(`${stableDecisionKey(item)}:${item.decidedAt}`);
    }
    void decisionDb().putDecisions(unseen).catch(() => {});
    mergeDecisions(unseen);
    if (mode === "api") {
      void mailApi.importDecisions(unseen.map(toApiDecision)).catch(() => {});
    }
  }, [mergeDecisions, mode, syncDocs]);

  const publishDecisionSync = useCallback(
    (dec: MailDecision) => {
      if (!prefs.sync.enabled || demoReadOnly || !planning.engine.canEmit()) return;
      const id = decisionMailDocId(stableDecisionKey(dec));
      if (planning.engine.readOnly("ai", id)) return;
      planning.engine.emitLocal("ai", id, {
        accountId: dec.accountId,
        folderPath: dec.folderPath,
        uid: dec.uid,
        ...(dec.messageId ? { messageId: dec.messageId } : {}),
        contentHash: dec.contentHash,
        schemaVersion: dec.schemaVersion,
        model: dec.model,
        category: dec.category,
        categoryConf: dec.categoryConf,
        categoryProbs: dec.categoryProbs,
        urgency: dec.urgency,
        needsReply: dec.needsReply,
        hasTask: dec.hasTask,
        hasEvent: dec.hasEvent,
        security: dec.security,
        securityConf: dec.securityConf,
        cleanupScore: dec.cleanupScore,
        ...(dec.assignee ? { assignee: dec.assignee } : {}),
        ...(typeof dec.assigneeConf === "number" ? { assigneeConf: dec.assigneeConf } : {}),
        ...(dec.totpCode ? { totpCode: dec.totpCode } : {}),
        ...(dec.totpService ? { totpService: dec.totpService } : {}),
        ...(dec.suggestedFolder ? { suggestedFolder: dec.suggestedFolder } : {}),
        ...(typeof dec.suggestedFolderConf === "number"
          ? { suggestedFolderConf: dec.suggestedFolderConf }
          : {}),
        decidedAt: dec.decidedAt,
      });
    },
    [planning.engine, prefs.sync.enabled],
  );

  const isDecisionReady = decisionReady(prefs.decision) || daemonDecisionReady;
  const hasDecisionLayer = isDecisionReady || Object.keys(decisions).length > 0;

  const triageMails = useCallback(
    async (targetMails: Mail[], force = false, limit?: number) => {
      if (mode !== "api" || !isDecisionReady || targetMails.length === 0) return;
      const teamMembers = allTeamMembers(prefs).map((member) => member.name);
      try {
        const triaged = await triageRecentMails({
          mails: targetMails,
          existingDecisions: decisionsRef.current,
          teamMembers,
          force,
          limit,
          db: decisionDb(),
          domain: decisionDomain(prefs.decision),
          publishSynced: publishDecisionSync,
        });
        if (triaged.length > 0) mergeDecisions(triaged);
      } catch {
        // Un échec réseau du modèle de décision ne bloque jamais la boîte mail.
      }
    },
    [isDecisionReady, mergeDecisions, mode, prefs, publishDecisionSync],
  );

  useEffect(() => {
    if (mode !== "api" || !mailSyncOn || typeof EventSource === "undefined" || isComposeWindow()) return;
    let source: EventSource | null = null;
    let closed = false;
    void mailApi.eventsUrl().then((url) => {
      if (closed) return;
      source = new EventSource(url);
      source.addEventListener("mail", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as LiveEvent;
          const inserted = payload.report?.inserted ?? 0;
          const notices = payload.new_mails ?? [];
          if (notices.length > 0 && decisionPrefsRef.current.totpPopup) {
            const totpNotice = notices.find(
              (entry) => typeof entry.totp_code === "string" && entry.totp_code.trim() !== "",
            );
            if (totpNotice?.totp_code) {
              setTotpAlert({
                code: totpNotice.totp_code,
                service: totpNotice.totp_service || totpNotice.from || "Vérification",
                mailId: totpNotice.id,
                receivedAt: Date.now(),
              });
            }
          }
          if (
            payload.folder_path.toUpperCase() === "INBOX" &&
            notifyMailAccounts.current.some((entry) => entry.id === payload.account_id) &&
            notificationsForAccount(notifyPrefs.current, payload.account_id)
          ) {
            for (const notice of notices) {
              if (notice.should_notify === false) continue;
              if (notice.totp_code && notice.totp_code.trim() !== "") {
                void notifyTotpCode?.(
                  notice.totp_service || notice.from || "Vérification",
                  notice.totp_code.trim(),
                );
                continue;
              }
              void notifyNewMail(notice.from, notice.subject);
            }
            // Repli : un démon antérieur à la notification par mail ne pousse
            // pas `new_mails`, et l'arrivée resterait muette.
            if (notices.length === 0 && inserted > 0) {
              const label = notifyAccounts.current.find(
                (entry) => entry.id === payload.account_id,
              )?.label;
              void notifyNewMail(
                label ? `Nouveau message · ${label}` : "Nouveau message",
                inserted === 1
                  ? "Vous avez reçu un nouveau message."
                  : `${inserted} nouveaux messages dans la boîte de réception.`,
              );
            }
          }
          if (inserted > 0 || notices.length > 0) {
            void mailApi
              .listDecisions({ accountId: payload.account_id, limit: 200 })
              .then((items) => {
                if (!Array.isArray(items) || items.length === 0) return;
                const converted = items.map(fromApiDecision);
                void decisionDb().putDecisions(converted).catch(() => {});
                mergeDecisions(converted);
              })
              .catch(() => {});
          }
          if (account === ALL_ACCOUNTS || !account || payload.account_id === account) {
            setRevision((value) => value + 1);
          }
        } catch {
          setRevision((value) => value + 1);
        }
      });
    });
    return () => {
      closed = true;
      source?.close();
    };
  }, [account, mailSyncOn, mergeDecisions, mode]);

  const retryBackend = useCallback(() => {
    if (mode === "api") void bootstrap();
  }, [bootstrap, mode]);

  const useDemo = useCallback(() => {
    setMode("demo");
    setAccounts(ACCOUNTS);
    setFolderRecords([]);
    setMails(MAILS);
    setAccountState(ALL_ACCOUNTS);
    setFolderState("unified");
    setFolderPath(null);
    setOpenMail(null);
    setPages(1);
    setHasMore(false);
    setPhase("ready");
    setBackendError(null);
    setConnectOpen(false);
    setRemoveTarget(null);
  }, []);

  const targets = useMemo(() => {
    if (mode !== "api") return [];
    const loaded = folderTargets(
      folderRecords,
      account === ALL_ACCOUNTS
        ? mailAccounts.map((entry) => entry.id)
        : account
          ? [account]
          : [],
      folder,
      folderPath ?? undefined,
    );
    return folder === "unified"
      ? loaded.filter((target) => !isFolderHidden(prefs.hiddenFolders, target.accountId, target.path))
      : loaded;
  }, [mode, folderRecords, account, mailAccounts, folder, folderPath, prefs.hiddenFolders]);

  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || isComposeWindow()) return;
    if (targets.length === 0) {
      setMails([]);
      setHasMore(false);
      return;
    }
    let cancelled = false;
    const previewRuns: { keys: string[]; done: boolean }[] = [];
    setThreadsLoading(true);
    const requests = targets.flatMap((target) =>
      Array.from({ length: pages }, (_, page) =>
        mailApi.threads(target.accountId, target.path, PAGE_SIZE, page * PAGE_SIZE),
      ),
    );
    Promise.allSettled(requests)
      .then((results) => {
        if (cancelled) return;
        const loaded = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (loaded.length === 0 && failed) {
          notify(errorText(failed.reason));
          return;
        }
        const loadedMails = loaded.flatMap((threads) =>
          threads.flatMap((thread) => threadToMails(thread, folderRecords)),
        );
        setMails(loadedMails);
        for (const group of pendingPreviews(loadedMails, previewAttempts.current)) {
          const keys = group.uids.map((uid) => previewKeyOf(group.accountId, group.folderPath, uid));
          for (const key of keys) previewAttempts.current.add(key);
          const run = { keys, done: false };
          previewRuns.push(run);
          void mailApi
            .previews(group.accountId, group.folderPath, group.uids)
            .then((entries) => {
              run.done = true;
              if (cancelled) {
                for (const key of run.keys) previewAttempts.current.delete(key);
                return;
              }
              if (entries.length === 0) return;
              const filled = new Map(
                entries.map((entry) => [
                  previewKeyOf(group.accountId, group.folderPath, entry.uid),
                  entry.preview,
                ]),
              );
              setMails((current) =>
                current.map((mail) => {
                  if (mail.preview !== PREVIEW_PENDING || !mail.source) return mail;
                  const preview = filled.get(
                    previewKeyOf(mail.source.accountId, mail.source.folderPath, mail.source.uid),
                  );
                  return preview === undefined ? mail : { ...mail, preview };
                }),
              );
            })
            .catch(() => {
              run.done = true;
            });
        }
        setHasMore(
          targets.some((_, index) => {
            const last = results[index * pages + pages - 1];
            return last !== undefined && last.status === "fulfilled" && last.value.length === PAGE_SIZE;
          }),
        );
        if (failed) notify(errorText(failed.reason));
      })
      .finally(() => {
        if (!cancelled) setThreadsLoading(false);
      });
    return () => {
      cancelled = true;
      for (const run of previewRuns) {
        if (run.done) continue;
        for (const key of run.keys) previewAttempts.current.delete(key);
      }
    };
  }, [mode, phase, targets, pages, folder, folderRecords, revision, notify]);

  const folderOptions = useMemo<FolderOption[]>(() => {
    const all = account === ALL_ACCOUNTS;
    const unified: FolderOption = {
      id: "unified",
      label: folderLabel("inbox"),
      path: "unified",
      delimiter: null,
    };
    if (mode !== "api") {
      const demo: FolderOption[] = [
        { id: "inbox", label: folderLabel("inbox"), path: "inbox" },
        { id: "sent", label: folderLabel("sent"), path: "sent" },
        { id: "drafts", label: folderLabel("drafts"), path: "drafts" },
        { id: "archive", label: folderLabel("archive"), path: "archive" },
        { id: "spam", label: folderLabel("spam"), path: "spam" },
        { id: "trash", label: folderLabel("trash"), path: "trash" },
      ];
      if (!all) return demo;
      return [unified, ...demo.filter((option) => option.id !== "inbox")];
    }
    const visible = folderRecords.filter(
      (record) =>
        record.role !== "other" ||
        !isFolderHidden(prefs.hiddenFolders, record.accountId, record.path),
    );
    if (!all) return optionsOf(visible, account);
    const options = folderOptionsForAll(visible, mailAccounts.map((entry) => entry.id)).filter(
      (option) => option.id !== "inbox",
    );
    return [unified, ...options];
  }, [mode, folderRecords, account, mailAccounts, prefs.hiddenFolders]);

  const folderOrder = useMemo<string[]>(() => {
    if (mode !== "api" || !account || account === ALL_ACCOUNTS) return NO_FOLDER_ORDER;
    return prefs.folderOrder[account] ?? NO_FOLDER_ORDER;
  }, [mode, account, prefs.folderOrder]);

  const hiddenFolderOptions = useMemo<FolderOption[]>(() => {
    if (mode !== "api" || !account || account === ALL_ACCOUNTS) return [];
    const hidden = prefs.hiddenFolders[account] ?? [];
    if (hidden.length === 0) return [];
    return optionsOf(folderRecords, account).filter(
      (option) => option.id === "other" && hidden.includes(option.path),
    );
  }, [mode, account, folderRecords, prefs.hiddenFolders]);

  const setAccount = useCallback(
    (value: string) => {
      setAccountState(value);
      setFolderPath(null);
      if (value === ALL_ACCOUNTS) {
        setFolderState("unified");
        return;
      }
      setFolderState((current) => {
        if (current === "unified") return "inbox";
        if (mode !== "api") return current;
        return folderPathOf(folderRecords, value, current) ? current : "inbox";
      });
    },
    [folderRecords, mode],
  );

  /**
   * Repli de sélection : un compte coupé pendant qu'il était ouvert ramène la
   * boîte sur le seul compte visible, ou sur « Tous les comptes ».
   */
  useEffect(() => {
    if (account === ALL_ACCOUNTS && mailAccounts.length === 1) {
      setAccount(mailAccounts[0].id);
      return;
    }
    if (!account || account === ALL_ACCOUNTS) return;
    if (mailAccounts.some((entry) => entry.id === account)) return;
    setAccount(ALL_ACCOUNTS);
  }, [account, mailAccounts, setAccount]);

  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || isComposeWindow()) return;
    let cancelled = false;
    Promise.allSettled(mailAccounts.map((entry) => mailApi.folderCounts(entry.id))).then((results) => {
      if (cancelled) return;
      const next: Record<string, { total: number; unread: number }> = {};
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const accountId = mailAccounts[index]?.id;
        if (!accountId) return;
        for (const count of result.value) {
          next[`${accountId}:${count.path}`] = { total: count.total, unread: count.unread };
        }
      });
      setFolderCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, phase, mailAccounts, revision]);

  useEffect(() => {
    if (mode !== "api") return;
    const visible = new Set(mailAccounts.map((entry) => entry.id));
    let unread = 0;
    for (const record of folderRecords) {
      if (record.role === "inbox" && visible.has(record.accountId)) {
        unread += folderCounts[`${record.accountId}:${record.path}`]?.unread ?? 0;
      }
    }
    setUnreadBadge(unread);
  }, [mode, folderCounts, folderRecords, mailAccounts]);

  // Première visite d'un dossier : synchro automatique en arrière-plan, pour ne
  // pas avoir à cliquer sur « Synchroniser ». Une seule fois par portée
  // (compte + dossier) ; revision recharge ensuite fils et compteurs. En boîte
  // unifiée, seule la réception est auto-synchronisée : le démarrage reste léger,
  // les autres dossiers suivent à leur première visite ou via « Synchroniser ».
  const autoSyncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (mode !== "api" || !mailSyncOn || phase !== "ready" || isComposeWindow()) return;
    const scoped =
      folder === "unified"
        ? targets.filter(
            (target) =>
              folderRecords.find(
                (record) => record.accountId === target.accountId && record.path === target.path,
              )?.role === "inbox",
          )
        : targets;
    const due = scoped.filter((target) => mailsInPerimeter(target.accountId));
    if (due.length === 0) return;
    const key = due.map((t) => `${t.accountId}:${t.path}`).sort().join("|");
    if (autoSyncedRef.current.has(key)) return;
    autoSyncedRef.current.add(key);
    let cancelled = false;
    setSyncing(true);
    Promise.all(due.map((t) => mailApi.sync(t.accountId, t.path)))
      .then(() => {
        if (!cancelled) setRevision((value) => value + 1);
      })
      .catch(() => {
        // Synchro de confort en arrière-plan : muette en cas d'échec pour ne pas
        // dupliquer la notice du chargement des fils. L'état vide propose « Synchroniser ».
      })
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mailsInPerimeter, mailSyncOn, mode, phase, targets, folder, folderRecords]);

  const demoCounts = useMemo(() => {
    const next: Record<string, { total: number; unread: number }> = {};
    if (mode !== "demo") return next;
    for (const mail of mails) {
      const key = `${mail.account}:${mail.folder}`;
      const entry = next[key] ?? { total: 0, unread: 0 };
      entry.total += 1;
      if (mail.unread) entry.unread += 1;
      next[key] = entry;
    }
    return next;
  }, [mode, mails]);

  const statsFor = useCallback(
    (id: FolderId, path: string | undefined, scopeAccounts: string[]) => {
      const counts = mode === "demo" ? demoCounts : folderCounts;
      const roles: FolderId[] = id === "unified" ? UNIFIED_FOLDERS : [id];
      let total = 0;
      let unread = 0;
      for (const accountId of scopeAccounts) {
        const paths =
          mode === "demo"
            ? roles.map(String)
            : folderRecords
                .filter(
                  (record) => record.accountId === accountId && roles.includes(record.role),
                )
                .filter((record) =>
                  id === "unified"
                    ? !isFolderHidden(prefs.hiddenFolders, record.accountId, record.path)
                    : record.role !== "other" || record.path === path,
                )
                .map((record) => record.path);
        for (const folderPath of paths) {
          const entry = counts[`${accountId}:${folderPath}`];
          if (entry) {
            total += entry.total;
            unread += entry.unread;
          }
        }
      }
      return { total, unread };
    },
    [demoCounts, folderCounts, folderRecords, mode, prefs.hiddenFolders],
  );

  const folderStats = useCallback(
    (id: FolderId, path?: string) =>
      statsFor(
        id,
        path,
        account === ALL_ACCOUNTS ? mailAccounts.map((entry) => entry.id) : account ? [account] : [],
      ),
    [account, mailAccounts, statsFor],
  );

  const accountUnread = useCallback(
    (accountId: string) =>
      statsFor(
        "inbox",
        undefined,
        accountId === ALL_ACCOUNTS ? mailAccounts.map((entry) => entry.id) : [accountId],
      ).unread,
    [mailAccounts, statsFor],
  );

  const adjustCounts = useCallback(
    (accountId: string, path: string, total: number, unread: number) => {
      if (mode !== "api") return;
      setFolderCounts((current) => {
        const key = `${accountId}:${path}`;
        const entry = current[key] ?? { total: 0, unread: 0 };
        return {
          ...current,
          [key]: {
            total: Math.max(0, entry.total + total),
            unread: Math.max(0, entry.unread + unread),
          },
        };
      });
    },
    [mode],
  );

  const scope = JSON.stringify([account, folder, folderPath]);
  const [scopeKey, setScopeKey] = useState(scope);
  if (scope !== scopeKey) {
    setScopeKey(scope);
    setPages(1);
    setHasMore(false);
  }

  const setFolder = useCallback(
    (value: FolderId, path?: string | null) => {
      if (value === "unified" && account !== ALL_ACCOUNTS) return;
      setFolderState(value);
      setFolderPath(path ?? null);
    },
    [account],
  );

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    setPages((current) => current + 1);
  }, [hasMore]);

  const flagsFor = useCallback(
    (mail: Mail, next: { unread: boolean; starred: boolean }) => {
      if (!mail.source) return Promise.resolve();
      return mailApi.setFlags(mail.source.accountId, {
        folder_path: mail.source.folderPath,
        uid: mail.source.uid,
        unread: next.unread,
        starred: next.starred,
      });
    },
    [],
  );

  const toggleStar = useCallback(
    (id: string) => {
      if (readOnlyBlocked()) return;
      const mail =
        mails.find((entry) => entry.id === id) ?? searchResults.find((entry) => entry.id === id);
      setMails((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, starred: !entry.starred } : entry)),
      );
      setSearchResults((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, starred: !entry.starred } : entry)),
      );
      setOpenMail((current) =>
        current && current.id === id ? { ...current, starred: !current.starred } : current,
      );
      if (mode !== "api" || !mail) return;
      flagsFor(mail, { unread: mail.unread, starred: !mail.starred }).catch((error: unknown) => {
        setMails((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, starred: mail.starred } : entry)),
        );
        setSearchResults((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, starred: mail.starred } : entry)),
        );
        notify(errorText(error));
      });
    },
    [flagsFor, mails, mode, notify, readOnlyBlocked, searchResults],
  );

  const moveTo = useCallback(
    (mail: Mail, role: FolderId, message?: string) => {
      if (readOnlyBlocked()) return;
      if (!mail.source) return;
      const target = folderPathOf(folderRecords, mail.source.accountId, role);
      if (!target) {
        notify(`Dossier « ${folderLabel(role)} » introuvable sur ce compte.`);
        return;
      }
      if (target === mail.source.folderPath) {
        notify(`Le message est déjà dans « ${folderLabel(role)} ».`);
        return;
      }
      const source = mail.source;
      setMails((current) => current.filter((entry) => entry.id !== mail.id));
      adjustCounts(source.accountId, source.folderPath, -1, mail.unread ? -1 : 0);
      mailApi
        .move(source.accountId, { from_path: source.folderPath, uid: source.uid, to_path: target })
        .then(() => {
          adjustCounts(source.accountId, target, 1, mail.unread ? 1 : 0);
          notify(message ?? `Message déplacé vers ${folderLabel(role)}`);
          setRevision((value) => value + 1);
        })
        .catch((error: unknown) => {
          setMails((current) =>
            current.some((entry) => entry.id === mail.id) ? current : [...current, mail],
          );
          adjustCounts(source.accountId, source.folderPath, 1, mail.unread ? 1 : 0);
          notify(errorText(error));
        });
    },
    [adjustCounts, folderRecords, notify, readOnlyBlocked],
  );

  const addSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      if (readOnlyBlocked()) return;
      planning.addSuggestion(suggestion);
      notify("Tâche ajoutée à la planification", {
        label: "Annuler",
        run: () => planning.unpromote(suggestion),
      });
    },
    [notify, planning, readOnlyBlocked],
  );

  const dismissSuggestion = useCallback(
    (suggestion: MailSuggestion) => {
      if (readOnlyBlocked()) return;
      planning.dismissSuggestion(suggestion);
      notify("Suggestion masquée");
    },
    [notify, planning, readOnlyBlocked],
  );

  const mailAction = useCallback(
    (kind: "delete" | "archive" | "read", mail: Mail) => {
      if (readOnlyBlocked()) return;
      if (kind !== "read") haptic(kind === "delete" ? "medium" : "light");
      if (kind === "read") {
        setMails((current) =>
          current.map((entry) => (entry.id === mail.id ? { ...entry, unread: !entry.unread } : entry)),
        );
        setOpenMail((current) =>
          current && current.id === mail.id ? { ...current, unread: !current.unread } : current,
        );
        if (mode === "api" && mail.source) {
          const source = mail.source;
          adjustCounts(source.accountId, source.folderPath, 0, mail.unread ? -1 : 1);
          flagsFor(mail, { unread: !mail.unread, starred: mail.starred }).catch((error: unknown) => {
            setMails((current) =>
              current.map((entry) => (entry.id === mail.id ? { ...entry, unread: mail.unread } : entry)),
            );
            adjustCounts(source.accountId, source.folderPath, 0, mail.unread ? 1 : -1);
            notify(errorText(error));
          });
        }
        return;
      }

      if (mode === "api") {
        if (kind === "delete" && mail.folder === "trash" && mail.source) {
          const source = mail.source;
          mailApi
            .deleteMessage(source.accountId, { folder_path: source.folderPath, uid: source.uid })
            .then(() => {
              setMails((current) => current.filter((entry) => entry.id !== mail.id));
              setOpenMail((current) => (current && current.id === mail.id ? null : current));
              adjustCounts(source.accountId, source.folderPath, -1, mail.unread ? -1 : 0);
              notify("Message supprimé définitivement");
            })
            .catch((error: unknown) => notify(errorText(error)));
          return;
        }

        moveTo(
          mail,
          kind === "delete" ? "trash" : "archive",
          kind === "delete" ? "Message déplacé vers la corbeille" : "Message archivé",
        );
        return;
      }

      const index = mails.findIndex((entry) => entry.id === mail.id);

      if (kind === "delete" && mail.folder === "trash") {
        setMails((current) => current.filter((entry) => entry.id !== mail.id));
        notify("Message supprimé", {
          label: "Annuler",
          run: () =>
            setMails((current) =>
              current.some((entry) => entry.id === mail.id) ? current : insertAt(current, index, mail),
            ),
        });
        return;
      }

      const target: FolderId = kind === "delete" ? "trash" : "archive";
      const previous = mail.folder;
      setMails((current) =>
        current.map((entry) =>
          entry.id === mail.id ? { ...entry, folder: target, previousFolder: previous } : entry,
        ),
      );
      notify(target === "trash" ? "Message déplacé vers la corbeille" : "Message archivé", {
        label: "Annuler",
        run: () =>
          setMails((current) =>
            current.map((entry) =>
              entry.id === mail.id ? { ...entry, folder: previous, previousFolder: mail.previousFolder } : entry,
            ),
          ),
      });
    },
    [adjustCounts, flagsFor, mails, mode, moveTo, notify, readOnlyBlocked],
  );

  const fetchBody = useCallback(
    (mail: Mail) => {
      if (mode !== "api" || !mail.source || mail.bodyFetched) return;
      if (mail.pgp === "encrypted" && !resolvePgp(pgpPrefs, mail.account).enabled) {
        return;
      }
      const source = mail.source;
      setBodyFetching(mail.id);
      mailApi
        .message(source.accountId, source.folderPath, source.uid)
        .then((message) => {
          const fetched = messageToMail(message, folderRecords);
          setMails((current) =>
            current.map((entry) =>
              entry.id === fetched.id ? { ...fetched, folder: entry.folder, unread: entry.unread } : entry,
            ),
          );
          setOpenMail((current) =>
            current && current.id === fetched.id
              ? { ...fetched, folder: current.folder, unread: current.unread }
              : current,
          );
          setFullThread((current) =>
            current?.map((entry) =>
              entry.id === fetched.id ? { ...fetched, folder: entry.folder, unread: entry.unread } : entry,
            ) ?? null,
          );
        })
        .catch((error: unknown) => notify(`Corps du message indisponible · ${errorText(error)}`))
        .finally(() => setBodyFetching((current) => (current === mail.id ? null : current)));
    },
    [folderRecords, mode, notify, pgpPrefs],
  );

  const openMessage = useCallback(
    (target: Mail | string) => {
      const mail = typeof target === "string" ? liveMails.current.find((entry) => entry.id === target) : target;
      if (!mail) {
        if (typeof target === "string") notify("Mail d'origine introuvable");
        return;
      }
      if (mail.folder === "drafts") {
        resumeDraftRef.current(mail);
        return;
      }
      setOpenMail({ ...mail, unread: false });
      if (!demoReadOnly) {
        setMails((current) =>
          current.map((item) => (item.id === mail.id ? { ...item, unread: false } : item)),
        );
      }
      if (mode !== "api" || !mail.source) return;
      if (mail.unread) {
        adjustCounts(mail.source.accountId, mail.source.folderPath, 0, -1);
        flagsFor(mail, { unread: false, starred: mail.starred }).catch((error: unknown) =>
          notify(errorText(error)),
        );
      }
      fetchBody(mail);
    },
    [adjustCounts, fetchBody, flagsFor, mode, notify],
  );

  const closeMessage = useCallback(() => setOpenMail(null), []);

  // Vitrine : la démo desktop s'ouvre sur un fil lu, pas sur un panneau vide.
  const demoOpened = useRef(false);
  useEffect(() => {
    if (!demoReadOnly || demoOpened.current || shellLayout() !== "desktop") return;
    const first = mails.find((entry) => entry.folder === "inbox");
    if (!first) return;
    demoOpened.current = true;
    openMessage(first);
  }, [mails, openMessage]);

  const moveToInbox = useCallback(
    (mail: Mail) => {
      if (readOnlyBlocked()) return;
      if (mode === "api") {
        moveTo(mail, "inbox", "Message déplacé vers la boîte de réception");
        return;
      }
      const previous = mail.folder;
      setMails((current) =>
        current.map((entry) =>
          entry.id === mail.id ? { ...entry, folder: "inbox", previousFolder: undefined } : entry,
        ),
      );
      notify("Message déplacé vers la boîte de réception", {
        label: "Annuler",
        run: () =>
          setMails((current) =>
            current.map((entry) => (entry.id === mail.id ? { ...entry, folder: previous } : entry)),
          ),
      });
    },
    [mode, moveTo, notify, readOnlyBlocked],
  );

  const moveToFolder = useCallback(
    (mail: Mail, targetPath: string) => {
      if (readOnlyBlocked()) return;
      const targetLabel =
        folderRecords.find(
          (record) => record.accountId === (mail.source?.accountId ?? mail.account) && record.path === targetPath,
        )?.name ??
        (targetPath.split(/[/.]/).filter(Boolean).pop() || targetPath);
      if (mode !== "api") {
        setMails((current) =>
          current.map((entry) =>
            entry.id === mail.id
              ? { ...entry, folder: "other", folderName: targetLabel, previousFolder: entry.folder }
              : entry,
          ),
        );
        notify(`Message rangé dans ${targetLabel}`);
        return;
      }
      if (!mail.source) return;
      if (targetPath === mail.source.folderPath) {
        notify(`Le message est déjà dans « ${targetLabel} ».`);
        return;
      }
      const source = mail.source;
      setMails((current) => current.filter((entry) => entry.id !== mail.id));
      setOpenMail((current) => (current && current.id === mail.id ? null : current));
      adjustCounts(source.accountId, source.folderPath, -1, mail.unread ? -1 : 0);
      mailApi
        .move(source.accountId, { from_path: source.folderPath, uid: source.uid, to_path: targetPath })
        .then(() => {
          adjustCounts(source.accountId, targetPath, 1, mail.unread ? 1 : 0);
          notify(`Message rangé dans ${targetLabel}`);
          setRevision((value) => value + 1);
        })
        .catch((error: unknown) => {
          setMails((current) =>
            current.some((entry) => entry.id === mail.id) ? current : [...current, mail],
          );
          adjustCounts(source.accountId, source.folderPath, 1, mail.unread ? 1 : 0);
          notify(errorText(error));
        });
    },
    [adjustCounts, folderRecords, mode, notify, readOnlyBlocked],
  );

  const restoreMail = useCallback(
    (mail: Mail) => {
      if (readOnlyBlocked()) return;
      if (mode === "api") {
        moveTo(mail, "inbox", "Message restauré dans la boîte de réception");
        return;
      }
      const from = mail.folder;
      const target: FolderId = mail.previousFolder ?? "inbox";
      setMails((current) =>
        current.map((entry) =>
          entry.id === mail.id ? { ...entry, folder: target, previousFolder: undefined } : entry,
        ),
      );
      notify(`Message restauré · ${folderLabel(target)}`, {
        label: "Annuler",
        run: () =>
          setMails((current) =>
            current.map((entry) =>
              entry.id === mail.id
                ? { ...entry, folder: from, previousFolder: mail.previousFolder }
                : entry,
            ),
          ),
      });
    },
    [mode, moveTo, notify, readOnlyBlocked],
  );

  const bulkMailAction = useCallback(
    (kind: BulkKind, selection: Mail[]) => {
      if (readOnlyBlocked()) return;
      if (selection.length === 0) return;

      if (kind === "read" || kind === "unread" || kind === "star" || kind === "unstar") {
        const field = kind === "read" || kind === "unread" ? "unread" : "starred";
        const value = kind === "unread" || kind === "star";
        const touched = selection.filter(
          (mail) => mail[field] !== value && (mode !== "api" || mail.source !== undefined),
        );
        if (touched.length === 0) return;
        const touchedIds = new Set(touched.map((mail) => mail.id));
        const flag = (entry: Mail) =>
          touchedIds.has(entry.id) ? { ...entry, [field]: value } : entry;
        setMails((current) => current.map(flag));
        setOpenMail((current) => (current ? flag(current) : current));
        if (mode !== "api") return;

        const kept = field === "unread" ? "starred" : "unread";
        type FlagItem = { mail: Mail; source: MailSource };
        type FlagGroup = {
          accountId: string;
          folderPath: string;
          kept: boolean;
          mails: FlagItem[];
        };
        const groups = new Map<string, FlagGroup>();
        for (const mail of touched) {
          const source = mail.source;
          if (!source) continue;
          const preserved = mail[kept];
          const key = `${source.accountId}\u0000${source.folderPath}\u0000${preserved}`;
          const group = groups.get(key) ?? {
            accountId: source.accountId,
            folderPath: source.folderPath,
            kept: preserved,
            mails: [],
          };
          group.mails.push({ mail, source });
          groups.set(key, group);
        }

        const unreadDelta = field === "unread" ? (value ? 1 : -1) : 0;
        const counts = new Map<string, { accountId: string; folderPath: string; count: number }>();
        for (const group of groups.values()) {
          for (const { source } of group.mails) {
            const key = `${source.accountId}\u0000${source.folderPath}`;
            const entry = counts.get(key) ?? {
              accountId: source.accountId,
              folderPath: source.folderPath,
              count: 0,
            };
            entry.count += 1;
            counts.set(key, entry);
          }
        }
        const adjust = (sign: number) => {
          if (!unreadDelta) return;
          for (const entry of counts.values()) {
            adjustCounts(entry.accountId, entry.folderPath, 0, sign * unreadDelta * entry.count);
          }
        };
        adjust(1);

        const originals = new Map(touched.map((mail) => [mail.id, mail]));
        const restore = (entry: Mail) => {
          const original = originals.get(entry.id);
          return original
            ? { ...entry, unread: original.unread, starred: original.starred }
            : entry;
        };
        const requests = [...groups.values()].flatMap((group) =>
          foldChunks(group.mails).map((part) =>
            mailApi.bulkFlags(group.accountId, {
              folder_path: group.folderPath,
              uids: part.map(({ source }) => source.uid),
              unread: field === "unread" ? value : group.kept,
              starred: field === "starred" ? value : group.kept,
            }),
          ),
        );
        Promise.all(requests).catch((error: unknown) => {
          setMails((current) => current.map(restore));
          setOpenMail((current) => (current ? restore(current) : current));
          adjust(-1);
          notify(errorText(error));
        });
        return;
      }

      const removed =
        kind === "delete" ? selection.filter((mail) => mail.folder === "trash") : [];
      const removedIds = new Set(removed.map((mail) => mail.id));

      if (mode !== "api") {
        const roles = new Map(selection.map((mail) => [mail.id, bulkTargetRole(kind, mail)]));
        const originals = new Map(selection.map((mail) => [mail.id, mail]));
        setMails((current) =>
          current
            .filter((entry) => !removedIds.has(entry.id))
            .map((entry) => {
              const role = roles.get(entry.id);
              if (!role) return entry;
              return {
                ...entry,
                folder: role,
                previousFolder:
                  kind === "restore" || kind === "inbox" ? undefined : entry.folder,
              };
            }),
        );
        notify(bulkSummary(kind, selection.length, removed.length), {
          label: "Annuler",
          run: () =>
            setMails((current) => [
              ...current.map((entry) => {
                const original = originals.get(entry.id);
                return original
                  ? { ...entry, folder: original.folder, previousFolder: original.previousFolder }
                  : entry;
              }),
              ...removed.filter((mail) => !current.some((entry) => entry.id === mail.id)),
            ]),
        });
        return;
      }

      const plan = selection.flatMap((mail) => {
        const source = mail.source;
        if (!source) return [];
        const role = bulkTargetRole(kind, mail);
        const target =
          role === undefined ? undefined : folderPathOf(folderRecords, source.accountId, role);
        if (role !== undefined && target === undefined) return [];
        if (target === source.folderPath) return [];
        return [{ mail, source, target }];
      });
      if (plan.length === 0) return;

      const planIds = new Set(plan.map(({ mail }) => mail.id));
      setMails((current) => current.filter((entry) => !planIds.has(entry.id)));
      setOpenMail((current) => (current && planIds.has(current.id) ? null : current));

      const deltas = new Map<
        string,
        { accountId: string; path: string; total: number; unread: number }
      >();
      const bump = (accountId: string, path: string, total: number, unread: number) => {
        const key = `${accountId}\u0000${path}`;
        const entry = deltas.get(key) ?? { accountId, path, total: 0, unread: 0 };
        entry.total += total;
        entry.unread += unread;
        deltas.set(key, entry);
      };
      const moves = new Map<
        string,
        { accountId: string; from: string; to: string; uids: number[] }
      >();
      const deletes = new Map<string, { accountId: string; path: string; uids: number[] }>();
      for (const { mail, source, target } of plan) {
        bump(source.accountId, source.folderPath, -1, mail.unread ? -1 : 0);
        if (target === undefined) {
          const key = `${source.accountId}\u0000${source.folderPath}`;
          const group = deletes.get(key) ?? {
            accountId: source.accountId,
            path: source.folderPath,
            uids: [],
          };
          group.uids.push(source.uid);
          deletes.set(key, group);
          continue;
        }
        bump(source.accountId, target, 1, mail.unread ? 1 : 0);
        const key = `${source.accountId}\u0000${source.folderPath}\u0000${target}`;
        const group = moves.get(key) ?? {
          accountId: source.accountId,
          from: source.folderPath,
          to: target,
          uids: [],
        };
        group.uids.push(source.uid);
        moves.set(key, group);
      }
      const applyCounts = (sign: number) => {
        for (const entry of deltas.values()) {
          adjustCounts(entry.accountId, entry.path, sign * entry.total, sign * entry.unread);
        }
      };
      applyCounts(1);

      const requests = [
        ...[...moves.values()].flatMap((group) =>
          foldChunks(group.uids).map((uids) =>
            mailApi.bulkMove(group.accountId, { from_path: group.from, uids, to_path: group.to }),
          ),
        ),
        ...[...deletes.values()].flatMap((group) =>
          foldChunks(group.uids).map((uids) =>
            mailApi.bulkDelete(group.accountId, { folder_path: group.path, uids }),
          ),
        ),
      ];
      Promise.all(requests)
        .then(() => {
          setRevision((value) => value + 1);
          notify(bulkSummary(kind, plan.length, plan.filter(({ target }) => !target).length));
        })
        .catch((error: unknown) => {
          setMails((current) => [
            ...current,
            ...plan
              .filter(({ mail }) => !current.some((entry) => entry.id === mail.id))
              .map(({ mail }) => mail),
          ]);
          applyCounts(-1);
          notify(errorText(error));
        });
    },
    [adjustCounts, folderRecords, mode, notify, readOnlyBlocked],
  );

  const emptyTrash = useCallback(() => {
    if (readOnlyBlocked()) return;
    const inTrash = (entry: Mail) =>
      entry.folder === "trash" && (account === ALL_ACCOUNTS || entry.account === account);

    if (mode === "api") {
      const purges = folderTargets(
        folderRecords,
        account === ALL_ACCOUNTS ? mailAccounts.map((entry) => entry.id) : [account],
        "trash",
      );
      if (purges.length === 0) {
        notify("Ce compte n'a pas de dossier corbeille.");
        return;
      }
      Promise.all(purges.map((purge) => mailApi.purgeFolder(purge.accountId, { folder_path: purge.path })))
        .then((results) => {
          const removed = results.reduce((sum, result) => sum + result.removed, 0);
          setMails((current) => current.filter((entry) => !inTrash(entry)));
          setOpenMail((current) => (current && inTrash(current) ? null : current));
          setFolderCounts((current) => {
            const next = { ...current };
            for (const purge of purges) next[`${purge.accountId}:${purge.path}`] = { total: 0, unread: 0 };
            return next;
          });
          setRevision((value) => value + 1);
          notify(
            removed > 0
              ? `Corbeille vidée · ${removed} message${removed > 1 ? "s" : ""}`
              : "La corbeille est déjà vide.",
          );
        })
        .catch((error: unknown) => notify(`Corbeille impossible · ${errorText(error)}`));
      return;
    }

    const removed = mails.filter(inTrash);
    setMails((current) => current.filter((entry) => !inTrash(entry)));
    setOpenMail((current) => (current && inTrash(current) ? null : current));
    notify("Corbeille vidée", {
      label: "Annuler",
      run: () =>
        setMails((current) => [
          ...current,
          ...removed.filter((entry) => !current.some((item) => item.id === entry.id)),
        ]),
    });
  }, [account, folderRecords, mailAccounts, mails, mode, notify, readOnlyBlocked]);

  /** Reprise remplacée ou abandonnée : plus rien à supprimer côté serveur. */
  const resetDraftSource = useCallback(() => {
    resumedDraftId.current = null;
    setDraftSource(null);
  }, []);

  /**
   * La reprise a été enregistrée ou envoyée : l'ancien brouillon serveur est
   * supprimé pour ne pas laisser de doublon. Rien n'est supprimé avant, pour
   * qu'un abandon ou une fermeture laisse l'original intact.
   */
  const forgetDraftSource = useCallback(
    (source: MailSource | null) => {
      const demoId = resumedDraftId.current;
      resumedDraftId.current = null;
      setDraftSource(null);
      if (demoId) setMails((current) => current.filter((entry) => entry.id !== demoId));
      if (!source) return;
      mailApi
        .deleteMessage(source.accountId, { folder_path: source.folderPath, uid: source.uid })
        .catch((error: unknown) => notify(`Ancien brouillon conservé · ${errorText(error)}`));
    },
    [notify],
  );

  const minimizeCompose = useCallback(() => setComposeOpen(false), []);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft(null);
    resetDraftSource();
  }, [resetDraftSource]);

  /**
   * Reprise d'un brouillon : le lecteur n'a rien à y faire, le corps revient
   * dans l'éditeur avec sa signature déjà écrite (`includeSignature: false`).
   */
  const resumeDraft = useCallback(
    (mail: Mail) => {
      if (readOnlyBlocked()) return;
      const open = (draft: ComposeDraft, source: MailSource | null) => {
        resumedDraftId.current = source ? null : mail.id;
        setDraftSource(source);
        setComposeDraft(draft);
        setComposeTitle("Brouillon");
        setComposeOpen(true);
        if (composeDetached) composeBus.current?.post({ kind: "focus" });
        notify("Brouillon repris");
      };

      const start = () => {
        const source = mode === "api" ? mail.source : undefined;
        if (!source) {
          const pgp = resolvePgp(pgpPrefs, mail.account);
          const attachments = (mail.attachments ?? []).flatMap((file) =>
            file.data
              ? [
                  {
                    filename: file.name,
                    mime: file.mime || mimeOf(file.name),
                    data_base64: file.data,
                    size: base64Size(file.data),
                  },
                ]
              : [],
          );
          open(
            {
              ...baseDraft(mail.account, pgp.encrypt, pgp.sign, mail.threadId),
              to: mail.to ?? "",
              subject: mail.subject === "(sans objet)" ? "" : mail.subject,
              body: mail.body.join("\n"),
              includeSignature: false,
              attachments: attachments.length ? attachments : undefined,
            },
            null,
          );
          return;
        }

        void (async () => {
          try {
            const message = await mailApi.message(source.accountId, source.folderPath, source.uid);
            const pgp = resolvePgp(pgpPrefs, source.accountId);
            const full = message.body_html ?? textToHtml(message.body_text ?? "");
            const { body, quoted } = splitQuotedBody(full);
            const attachments: DraftAttachment[] = [];
            for (const [index, file] of message.attachments.entries()) {
              if (file.inline) continue;
              if (file.size > MAX_ATTACHMENT_BYTES) {
                notify(
                  `« ${file.filename} » non reprise · ${formatBytes(MAX_ATTACHMENT_BYTES)} maximum par fichier.`,
                );
                continue;
              }
              try {
                const blob = await mailApi.attachment(
                  source.accountId,
                  source.folderPath,
                  source.uid,
                  index,
                );
                attachments.push({
                  filename: file.filename,
                  mime: file.mime || mimeOf(file.filename),
                  data_base64: await readBase64(blob),
                  size: file.size,
                });
              } catch (error) {
                notify(`« ${file.filename} » non reprise · ${errorText(error)}`);
              }
            }
            open(
              {
                ...baseDraft(source.accountId, pgp.encrypt, pgp.sign, message.thread_id),
                to: message.to.map((address) => address.email).join(", "),
                cc: message.cc.map((address) => address.email).join(", "),
                subject: message.subject === "(sans objet)" ? "" : message.subject,
                body,
                ...(quoted ? { quoted } : {}),
                includeSignature: false,
                attachments: attachments.length ? attachments : undefined,
                inReplyTo: message.in_reply_to ?? undefined,
                references: message.references,
              },
              source,
            );
          } catch (error) {
            notify(`Brouillon non repris · ${errorText(error)}`);
          }
        })();
      };

      if (composeDraft && !emptyDraft(composeDraft)) {
        notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: start });
        return;
      }
      start();
    },
    [composeDetached, composeDraft, mode, notify, pgpPrefs, readOnlyBlocked],
  );
  resumeDraftRef.current = resumeDraft;

  const saveToDrafts = useCallback(
    async (draft: ComposeDraft): Promise<boolean> => {
      if (readOnlyBlocked()) return false;
      const source = draftSource;
      if (mode !== "api") {
        forgetDraftSource(null);
        notify("Brouillon enregistré (démo)");
        return true;
      }
      try {
        await mailApi.saveDraft(draft.account, sendInputOf(draft));
        if (source) forgetDraftSource(source);
        notify("Brouillon enregistré");
        setRevision((value) => value + 1);
        return true;
      } catch (error) {
        notify(`Brouillon non enregistré · ${errorText(error)}`);
        return false;
      }
    },
    [draftSource, forgetDraftSource, mode, notify, readOnlyBlocked],
  );

  const detachCompose = useCallback(() => {
    setComposeDetached(true);
    setComposeOpen(false);
  }, []);

  const dockCompose = useCallback(() => {
    setComposeDetached(false);
    setComposeOpen(true);
  }, []);

  const detachClosed = useCallback(() => setComposeDetached(false), []);

  useEffect(() => {
    if (isComposeWindow()) return;
    const bus = openComposeBus((message) => {
      switch (message.kind) {
        case "hello":
          composeBus.current?.post({ kind: "state", state: composeStateRef.current });
          break;
        case "edit":
          if (!composeStateRef.current.draft) break;
          setComposeDraft(message.draft);
          if (message.title) setComposeTitle(message.title);
          break;
        case "send":
          if (composeStateRef.current.draft) sendDraftRef.current(message.draft);
          break;
        case "closed":
          setComposeDetached(false);
          break;
        case "dock":
          setComposeDetached(false);
          setComposeOpen(true);
          break;
      }
    });
    composeBus.current = bus;
    return () => {
      bus?.close();
      composeBus.current = null;
    };
  }, []);

  useEffect(() => {
    if (isComposeWindow()) return;
    const state: ComposeState = {
      draft: composeDraft,
      title: composeTitle,
      detached: composeDetached,
      draftSource,
    };
    composeStateRef.current = state;
    persistCompose(
      composeDraft ? persistedDraft(composeDraft) : null,
      composeTitle,
      composeDraft ? draftSource : null,
    );
    const json = JSON.stringify(state);
    if (json !== lastPostedCompose.current) {
      lastPostedCompose.current = json;
      composeBus.current?.post({ kind: "state", state });
    }
  }, [composeDraft, composeTitle, composeDetached, draftSource]);

  const blankDraft = useCallback(() => {
    const sender = account === ALL_ACCOUNTS || !account ? accounts[0]?.id ?? "" : account;
    const pgp = resolvePgp(pgpPrefs, sender);
    return baseDraft(sender, pgp.encrypt, pgp.sign);
  }, [account, accounts, pgpPrefs]);

  const startBlankDraft = useCallback(() => {
    if (readOnlyBlocked()) return;
    setComposeDraft(blankDraft());
    setComposeTitle("Nouveau message");
    setComposeOpen(true);
    resetDraftSource();
  }, [blankDraft, readOnlyBlocked, resetDraftSource]);

  const openComposer = useCallback(() => {
    if (readOnlyBlocked()) return;
    if (composeDetached) {
      composeBus.current?.post({ kind: "focus" });
      if (!composeDraft || emptyDraft(composeDraft)) startBlankDraft();
      return;
    }
    if (composeOpen) return;
    if (composeDraft && !emptyDraft(composeDraft)) {
      notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: startBlankDraft });
      return;
    }
    startBlankDraft();
  }, [composeDetached, composeDraft, composeOpen, notify, readOnlyBlocked, startBlankDraft]);

  const resumeCompose = useCallback(() => {
    if (readOnlyBlocked()) return;
    setComposeOpen(true);
  }, [readOnlyBlocked]);

  const replyTo = useCallback(
    (mail: Mail, all = false, body?: string) => {
      if (readOnlyBlocked()) return;
      const start = () => {
        resetDraftSource();
        const pgp = resolvePgp(pgpPrefs, mail.account);
        setComposeDraft({
          ...retargetDraft(
            baseDraft(mail.account, pgp.encrypt, pgp.sign),
            mail,
            all,
            accountById(mail.account)?.email,
          ),
          body: body ? textToHtml(body) : "",
        });
        setComposeTitle(all ? "Répondre à tous" : "Répondre");
        setComposeOpen(true);
        if (composeDetached) composeBus.current?.post({ kind: "focus" });
      };
      if (composeDraft && !emptyDraft(composeDraft)) {
        notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: start });
        return;
      }
      start();
    },
    [accountById, composeDetached, composeDraft, notify, pgpPrefs, readOnlyBlocked, resetDraftSource],
  );

  /**
   * « Répondre à ce message » depuis le brouillon : seule la cible change, le
   * corps, les pièces jointes et le compte déjà choisis restent en place.
   */
  const setReplyTarget = useCallback(
    (mail: Mail, all = false) => {
      if (readOnlyBlocked()) return;
      const current = composeDraft;
      if (!current) {
        replyTo(mail, all);
        return;
      }
      const account = current.account || mail.account;
      setComposeDraft(retargetDraft(current, mail, all, accountById(account)?.email));
      setComposeTitle(all ? "Répondre à tous" : "Répondre");
      setComposeOpen(true);
      if (composeDetached) composeBus.current?.post({ kind: "focus" });
    },
    [accountById, composeDetached, composeDraft, readOnlyBlocked, replyTo],
  );

  /**
   * Réponse pré-remplie par l'analyse : même garde de brouillon que Répondre,
   * puis le corps suggéré remplace le corps vide — la relève vers la fenêtre
   * détachée passe par l'état partagé, comme tout brouillon.
   */
  const openReplyWithBody = useCallback(
    (mail: Mail, body: string) => replyTo(mail, false, body),
    [replyTo],
  );

  const forwardMail = useCallback(
    (mail: Mail) => {
      if (readOnlyBlocked()) return;
      const start = () => {
        resetDraftSource();
        const pgp = resolvePgp(pgpPrefs, mail.account);
        setComposeDraft({
          ...baseDraft(mail.account, pgp.encrypt, pgp.sign),
          subject: /^tr\s*:/i.test(mail.subject.trim()) ? mail.subject : `Tr: ${mail.subject}`,
          body: "",
          quoted: buildQuotedHtml(
            "Message transféré",
            textToHtml(
              `De : ${mail.name} <${mail.email}>\nDate : ${mail.date ?? mail.time}\nObjet : ${
                mail.subject
              }\n\n${mail.body.join("\n")}`,
            ),
          ),
        });
        setComposeTitle("Transférer");
        setComposeOpen(true);
        if (composeDetached) composeBus.current?.post({ kind: "focus" });
      };
      if (composeDraft && !emptyDraft(composeDraft)) {
        notify("Abandonner le brouillon actuel ?", { label: "Abandonner", run: start });
        return;
      }
      start();
    },
    [composeDetached, composeDraft, notify, pgpPrefs, readOnlyBlocked],
  );

  const sendDraft = useCallback(
    (draft: ComposeDraft) => {
      if (readOnlyBlocked() || composeSendingRef.current) return;
      const source = draftSource;
      if (mode === "api") {
        composeSendingRef.current = true;
        setComposeSending(true);
        setComposeSendError(null);
        mailApi
          .send(draft.account, sendInputOf(draft, activeSignature(prefs.signatures, draft.account)))
          .then(() => {
            composeSendingRef.current = false;
            setComposeSending(false);
            setComposeOpen(false);
            setComposeDraft(null);
            if (source) forgetDraftSource(source);
            haptic("success");
            notify("Message envoyé");
            setRevision((value) => value + 1);
            composeBus.current?.post({ kind: "sent" });
          })
          .catch((error: unknown) => {
            const message = `Envoi impossible · ${errorText(error)}`;
            composeSendingRef.current = false;
            setComposeSending(false);
            setComposeSendError(message);
            haptic("error");
            notify(message);
            composeBus.current?.post({ kind: "send-failed", message });
          });
        return;
      }

      const sender = accounts.find((entry) => entry.id === draft.account) ?? accounts[0];
      if (!sender) return;
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const body = htmlToText(draft.body).split("\n").filter((line) => line.trim() !== "");
      const preview = body.find((line) => line.trim() !== "---" && !line.startsWith(">")) ?? "";
      const mail: Mail = {
        id: `sent-${now.getTime()}`,
        account: sender.id,
        folder: "sent",
        threadId: draft.threadId,
        name: sender.label,
        email: sender.email,
        subject: draft.subject.trim() || "(sans objet)",
        to: firstRecipient([draft.to, draft.cc, draft.cci].filter(Boolean).join(",")) || undefined,
        preview,
        body,
        time,
        date: `${new Intl.DateTimeFormat("fr-FR", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }).format(now)} · ${time}`,
        unread: false,
        starred: false,
        pgp: draft.pgpEncrypt ? "encrypted" : draft.pgpSign ? "signed" : "none",
        attachments: draft.attachments?.map((file) => ({
          name: file.filename,
          size: formatBytes(file.size),
          mime: file.mime,
        })),
        tone: sender.tone,
      };
      setMails((current) => [mail, ...current]);
      setComposeOpen(false);
      setComposeDraft(null);
      forgetDraftSource(null);
      haptic("success");
      notify("Message envoyé");
      composeBus.current?.post({ kind: "sent" });
    },
    [
      accounts,
      draftSource,
      forgetDraftSource,
      mode,
      notify,
      prefs.signatures,
      readOnlyBlocked,
      setComposeDraft,
    ],
  );
  sendDraftRef.current = sendDraft;

  const runSync = useCallback(
    (due: { accountId: string; path: string }[]) => {
      setSyncing(true);
      Promise.all(due.map((target) => mailApi.sync(target.accountId, target.path)))
        .then((results) => {
          const reports = results.flatMap((result) => result.reports);
          if (account === ALL_ACCOUNTS) {
            const totals = reports.reduce(
              (sum, report) => ({
                inserted: sum.inserted + report.inserted,
                flags_updated: sum.flags_updated + report.flags_updated,
                removed: sum.removed + report.removed,
              }),
              { inserted: 0, flags_updated: 0, removed: 0 },
            );
            notify(syncNotice([totals]));
          } else {
            notify(syncNotice(reports));
          }
          setRevision((value) => value + 1);
        })
        .catch((error: unknown) => notify(`Synchro impossible · ${errorText(error)}`))
        .finally(() => setSyncing(false));
    },
    [account, notify],
  );

  const syncFolder = useCallback(() => {
    if (readOnlyBlocked()) return;
    if (mode !== "api") {
      notify("Mode démo : la synchronisation est simulée.");
      return;
    }
    if (targets.length === 0) {
      notify(
        accounts.length > 0 && mailAccounts.length === 0
          ? "Mails hors périmètre de ce compte · synchronisation ignorée"
          : "Choisis un dossier à synchroniser.",
      );
      return;
    }
    const due = targets.filter((target) => mailsInPerimeter(target.accountId));
    if (due.length === 0) {
      notify("Mails hors périmètre de ce compte · synchronisation ignorée");
      return;
    }
    runSync(due);
  }, [
    accounts,
    mailAccounts,
    mailsInPerimeter,
    mode,
    notify,
    readOnlyBlocked,
    runSync,
    targets,
  ]);

  const syncFolderAt = useCallback(
    (role: FolderId, path: string | null) => {
      if (readOnlyBlocked()) return;
      if (mode !== "api") {
        notify("Mode démo : la synchronisation est simulée.");
        return;
      }
      const scoped = folderTargets(
        folderRecords,
        account === ALL_ACCOUNTS ? mailAccounts.map((entry) => entry.id) : account ? [account] : [],
        role,
        path ?? undefined,
      );
      const due = scoped.filter((target) => mailsInPerimeter(target.accountId));
      if (due.length === 0) {
        notify("Mails hors périmètre de ce compte · synchronisation ignorée");
        return;
      }
      runSync(due);
    },
    [
      account,
      folderRecords,
      mailAccounts,
      mailsInPerimeter,
      mode,
      notify,
      readOnlyBlocked,
      runSync,
    ],
  );

  const openConnect = useCallback(() => {
    if (readOnlyBlocked()) return;
    setConnectOpen(true);
  }, [readOnlyBlocked]);
  const closeConnect = useCallback(() => setConnectOpen(false), []);

  const applySearchResults = useCallback((next: Mail[]) => {
    searchResultsRef.current = next;
    setSearchResults(next);
  }, []);

  const searchPage = useCallback(
    async (criteria: SearchCriteria, offset: number): Promise<{ mails: Mail[]; full: boolean }> => {
      const { text, ...filters } = criteria;
      const results = await Promise.allSettled(
        mailAccounts.map((entry) =>
          mailApi.search(entry.id, text ?? "", SEARCH_PAGE, { ...filters, offset }),
        ),
      );
      const mails: Mail[] = [];
      let full = false;

      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const entry = mailAccounts[index];
          notify(`Recherche incomplète : le compte ${entry.label || entry.id} n'a pas répondu`);
          return;
        }
        if (result.value.length >= SEARCH_PAGE) full = true;
        mails.push(...result.value.map((message) => messageToMail(message, folderRecords)));
      });

      return { mails, full };
    },
    [folderRecords, mailAccounts, notify],
  );

  const searchMails = useCallback(
    async (input: string | SearchCriteria, filters: SearchFilter = {}): Promise<Mail[]> => {
      const criteria = mergeCriteria(
        typeof input === "string" ? parseSearchQuery(input) : input,
        filters,
      );
      searchSeq.current += 1;
      const seq = searchSeq.current;
      searchOffset.current = 0;
      searchCriteria.current = hasCriteria(criteria) ? criteria : null;

      if (!searchCriteria.current) {
        applySearchResults([]);
        setSearchHasMore(false);
        return [];
      }

      if (mode !== "api") {
        const visible = new Set(mailAccounts.map((entry) => entry.id));
        const found = MAILS.filter(
          (mail) => visible.has(mail.account) && mailMatches(mail, criteria),
        );
        setSearchHasMore(false);
        applySearchResults(orderSearchResults(found));
        return searchResultsRef.current;
      }

      const page = await searchPage(criteria, 0);
      if (seq !== searchSeq.current) return [];
      searchOffset.current = SEARCH_PAGE;
      setSearchHasMore(page.full);
      applySearchResults(orderSearchResults(page.mails));
      return searchResultsRef.current;
    },
    [applySearchResults, mailAccounts, mode, searchPage],
  );

  const loadMoreSearch = useCallback(async (): Promise<Mail[]> => {
    const criteria = searchCriteria.current;
    if (!criteria || mode !== "api") return searchResultsRef.current;
    const seq = searchSeq.current;
    const page = await searchPage(criteria, searchOffset.current);
    if (seq !== searchSeq.current) return searchResultsRef.current;
    searchOffset.current += SEARCH_PAGE;
    setSearchHasMore(page.full);
    applySearchResults(orderSearchResults([...searchResultsRef.current, ...page.mails]));
    return searchResultsRef.current;
  }, [applySearchResults, mode, searchPage]);

  const createAccount = useCallback(
    async (input: NewAccount) => {
      if (readOnlyBlocked()) return "";
      const summary = await mailApi.createAccount(input);
      try {
        const { accounts: loaded, folders: records } = await loadMailbox();
        setAccounts(loaded);
        setFolderRecords(records);
      } catch (error) {
        notify(`Compte connecté · rechargement impossible · ${errorText(error)}`);
        setAccountState(summary.id);
        setConnectOpen(false);
        setPhase("ready");
        return summary.id;
      }
      setAccountState(summary.id);
      setFolderState("inbox");
      setFolderPath(null);
      setConnectOpen(false);
      setPhase("ready");
      setBackendError(null);
      if (!mailSyncOn || !mailsInPerimeter(summary.id)) {
        notify("Compte connecté · synchronisation des mails coupée");
        return summary.id;
      }
      try {
        const result = await mailApi.sync(summary.id);
        const inserted = result.reports.reduce((total, report) => total + report.inserted, 0);
        notify(
          inserted > 0
            ? `Compte connecté · ${inserted} message${inserted > 1 ? "s" : ""} synchronisé${inserted > 1 ? "s" : ""}`
            : "Compte connecté",
        );
      } catch (error) {
        notify(`Compte connecté, mais synchro impossible · ${errorText(error)}`);
      }
      setRevision((value) => value + 1);
      return summary.id;
    },
    [mailSyncOn, mailsInPerimeter, notify, readOnlyBlocked],
  );

  const renameAccount = useCallback(
    async (id: string, label: string) => {
      if (readOnlyBlocked()) return;
      const clean = label.trim();
      if (!clean) return;
      try {
        await mailApi.renameAccount(id, clean);
        setAccounts((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, label: clean } : entry)),
        );
        notify(`Compte renommé · ${clean}`);
      } catch (error) {
        notify(errorText(error));
      }
    },
    [notify, readOnlyBlocked],
  );

  const askRemoveAccount = useCallback(
    (target: Account) => {
      if (readOnlyBlocked()) return;
      setRemoveTarget(target);
    },
    [readOnlyBlocked],
  );
  const cancelRemoveAccount = useCallback(() => setRemoveTarget(null), []);

  const confirmRemoveAccount = useCallback(() => {
    if (readOnlyBlocked()) return;
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target) return;
    mailApi
      .deleteAccount(target.id)
      .then(async () => {
        notify(`Compte « ${target.label} » retiré`);
        setOpenMail(null);
        setComposeDraft(null);
        setComposeOpen(false);
        const remaining = accounts.filter((entry) => entry.id !== target.id);
        const nextAccount =
          account && account !== ALL_ACCOUNTS && account !== target.id
            ? account
            : remaining.length > 1
              ? ALL_ACCOUNTS
              : (remaining[0]?.id ?? "");
        setFolderState(nextAccount === ALL_ACCOUNTS ? "unified" : "inbox");
        setFolderPath(null);
        await bootstrap();
      })
      .catch((error: unknown) => {
        setRemoveTarget(target);
        notify(errorText(error));
      });
  }, [account, accounts, bootstrap, mode, notify, readOnlyBlocked, removeTarget]);

  /**
   * Supprime un dossier personnalisé : le serveur d'abord, le cache local
   * ensuite. Un refus du serveur laisse le dossier et ses messages en place.
   */
  const deleteFolder = useCallback(
    async (path: string, label: string, accountId?: string) => {
      if (readOnlyBlocked()) return false;
      if (mode !== "api") return false;
      const ids = accountId
        ? [accountId]
        : account === ALL_ACCOUNTS
          ? mailAccounts.map((entry) => entry.id)
          : account
            ? [account]
            : [];
      const scope = folderTargets(folderRecords, ids, "other", path);
      if (scope.length === 0) {
        notify(`Dossier « ${label} » introuvable sur ce compte.`);
        return false;
      }
      let failure: string | null = null;
      for (const target of scope) {
        try {
          await mailApi.deleteFolder(target.accountId, target.path);
        } catch (error) {
          failure = errorText(error);
          break;
        }
      }
      try {
        const { folders: records } = await loadMailbox();
        setFolderRecords(records);
        if (folder === "other" && folderPath === path) setFolder("inbox", null);
      } catch (error) {
        failure = failure ?? errorText(error);
      }
      setRevision((value) => value + 1);
      notify(
        failure === null
          ? `Dossier « ${label} » supprimé`
          : `Dossier « ${label} » non supprimé · ${failure}`,
      );
      return failure === null;
    },
    [account, folder, folderPath, folderRecords, mailAccounts, mode, notify, readOnlyBlocked, setFolder],
  );

  /**
   * Masque un dossier de la liste du compte courant : rien ne quitte le serveur,
   * seul le réglage local change. Un dossier ouvert repart sur la réception.
   */
  const hideFolder = useCallback(
    (path: string) => {
      if (readOnlyBlocked()) return;
      if (mode !== "api" || !account || account === ALL_ACCOUNTS) return;
      prefs.setFolderHidden(account, path, true);
      if (folder === "other" && folderPath === path) setFolder("inbox", null);
    },
    [prefs, account, folder, folderPath, mode, readOnlyBlocked, setFolder],
  );

  const unhideFolder = useCallback(
    (path: string) => {
      if (readOnlyBlocked()) return;
      if (mode !== "api" || !account || account === ALL_ACCOUNTS) return;
      prefs.setFolderHidden(account, path, false);
    },
    [prefs, account, mode, readOnlyBlocked],
  );

  /** Ordre d'affichage des dossiers : local à l'appareil, rien ne part au serveur. */
  const setFolderOrder = useCallback(
    (paths: string[]) => {
      if (readOnlyBlocked()) return;
      if (mode !== "api" || !account || account === ALL_ACCOUNTS) return;
      prefs.setFolderOrder(account, paths);
    },
    [prefs, account, mode, readOnlyBlocked],
  );

  const inboxMails = useMemo(() => mails.filter((mail) => mail.folder === "inbox"), [mails]);

  const inboxIndex = useMemo(
    () => new Map(inboxMails.map((mail) => [mail.id, mail])),
    [inboxMails],
  );

  /** Mails réellement analysés par le résumé affiché : base de l'aperçu des pièces jointes. */
  const summaryMails = useMemo(() => {
    if (!summary || summary.mailIds.length === 0) return [];
    const byId = new Map(mails.map((mail) => [mail.id, mail]));
    return summary.mailIds.flatMap((id) => {
      const mail = byId.get(id);
      return mail ? [mail] : [];
    });
  }, [mails, summary]);

  /** Comptes coupés des suggestions : leurs mails ne sont ni analysés ni proposés. */
  const excludedAccounts = useMemo(
    () => new Set(prefs.aiTasks.excludedAccounts),
    [prefs.aiTasks.excludedAccounts],
  );

  const aiMails = useMemo(
    () =>
      excludedAccounts.size === 0
        ? inboxMails
        : inboxMails.filter((mail) => !excludedAccounts.has(mail.account)),
    [excludedAccounts, inboxMails],
  );

  /** Suggestions affichées : celles de la fenêtre, hors comptes exclus et mails déjà traités. */
  const suggestions = useMemo(() => {
    const visible = suggestionsInWindow(storedSuggestions, prefs.aiTasks.windowHours);
    const kept =
      excludedAccounts.size === 0
        ? visible
        : visible.filter((suggestion) => !excludedAccounts.has(suggestion.account));
    return kept.filter((suggestion) => !alreadyReplied(inboxIndex.get(suggestion.mailId)));
  }, [excludedAccounts, inboxIndex, storedSuggestions, prefs.aiTasks.windowHours]);

  /** Entrée minimale du moteur : expéditeur, objet, aperçu et horodatage, rien d'autre. */
  const summaryInputs = useCallback(
    (list: Mail[]): SummaryMailInput[] =>
      list.flatMap((mail) =>
        typeof mail.timestamp === "number"
          ? [
              {
                id: mail.id,
                from: mail.name,
                subject: mail.subject,
                snippet: mail.preview,
                timestamp: mail.timestamp,
                ...(mail.messageId ? { messageId: mail.messageId } : {}),
                ...(mail.source ? { source: mail.source } : {}),
              },
            ]
          : [],
      ),
    [],
  );

  /**
   * Transforme des tâches extraites en SUGGESTIONS en attente de validation.
   * Dédup par mail + intitulé, puis par proximité d'intitulé à échéance égale :
   * une même action ne devient jamais deux suggestions.
   */
  const proposeTasks = useCallback(
    (proposed: SummaryTask[], byId: Map<string, Mail>, label: string): number => {
      const known = new Set([
        ...planning.suggestions.map((entry) => `${entry.mailId}:${normalize(entry.proposal)}`),
        ...planning.tasks.map((entry) => `${entry.mailId ?? ""}:${normalize(entry.title)}`),
      ]);
      const existing: DuplicateCandidate[] = [
        ...planning.suggestions.map((entry) => ({
          mailId: entry.mailId,
          title: entry.proposal,
          when: entry.due,
        })),
        ...planning.tasks.map((entry) => ({
          mailId: entry.mailId ?? "",
          title: entry.title,
          when: entry.due,
        })),
      ];
      let added = 0;
      for (const task of proposed) {
        const mail = task.mailId ? byId.get(task.mailId) : undefined;
        if (alreadyReplied(mail)) continue;
        const suggestion = summarySuggestion(task, mail, label);
        const key = `${suggestion.mailId}:${normalize(suggestion.proposal)}`;
        if (known.has(key)) continue;
        const candidate = { mailId: suggestion.mailId, title: suggestion.proposal, when: suggestion.due };
        if (nearDuplicate(existing, candidate)) continue;
        known.add(key);
        existing.push(candidate);
        if (planning.proposeSuggestion(suggestion)) added += 1;
      }
      return added;
    },
    [planning],
  );

  /** Une action du briefing : une suggestion à valider, passée par le même circuit de dédup. */
  const proposeSummaryAction = useCallback(
    (ref: SummaryRef): "added" | "existing" => {
      const mail = inboxIndex.get(ref.mailId);
      const added = proposeTasks(
        [
          {
            title: ref.reason.trim() || mail?.subject || "Action à traiter",
            due: ref.due && ref.due !== "aucune" ? ref.due : "aucune",
            from: mail?.name ?? "",
            mailId: ref.mailId,
          },
        ],
        inboxIndex,
        summary?.period.label ?? "Résumé",
      );
      return added > 0 ? "added" : "existing";
    },
    [inboxIndex, proposeTasks, summary?.period.label],
  );

  /** Contexte d'équipe fiable envoyé au modèle : la boîte visée, ou l'union des boîtes. */
  const teamContextFor = useCallback(
    (scope: string = ALL_ACCOUNTS): string => {
      const accounts = scope === ALL_ACCOUNTS ? Object.keys(prefs.teamContext) : [scope];
      return accounts
        .map((id) => teamPromptBlock(teamContextOf(prefs, id)))
        .filter(Boolean)
        .join("\n\n");
    },
    [prefs.teamContext],
  );


  /**
   * Recalcule le résumé de la plage courante pour la boîte sélectionnée. Le
   * modèle n'est sollicité qu'une fois par portée, plage et jeu de mails : le
   * résultat est conservé sur le poste, et seul « Régénérer » force un nouveau
   * passage. En démo, jamais de réseau.
   */
  const refreshSummary = useCallback(
    async (force = false) => {
      if (!prefs.summary.enabled) {
        setSummary(null);
        return;
      }
      if (summaryRunning.current) return;
      const now = new Date();
      const period = currentPeriod(prefs.summary, now);
      const scope = summaryScope(account && account !== ALL_ACCOUNTS ? account : null);
      const scoped =
        scope === ALL_ACCOUNTS ? inboxMails : inboxMails.filter((mail) => mail.account === scope);
      const inputs = summaryInputs(scoped);
      const decisionCount = Object.keys(decisions).length;
      const baseSig = summarySignature(inputs);
      const signature = hasDecisionLayer ? `${baseSig}:d${decisionCount}` : `${baseSig}:no-dec`;
      const runKey = `${scope}:${period.id}:${signature}`;
      if (!force && summaryRun.current === runKey) return;
      if (!force && (hasDecisionLayer || mode === "demo")) {
        const cached = readSummaryCache(
          summaryStorage(),
          scope,
          period.id,
          mode === "demo" ? baseSig : signature,
        );
        if (cached) {
          summaryRun.current = runKey;
          setSummary(cached);
          return;
        }
      }
      summaryRunning.current = true;
      setSummaryLoading(true);
      try {
        const result = await generateSummary(
          mode === "demo" ? { ...prefs.summary, llmConsent: false } : prefs.summary,
          prefs.llm,
          inputs,
          now,
          undefined,
          teamContextFor(scope),
          {
            hybrid: true,
            decisionReady: mode === "demo" ? false : hasDecisionLayer,
            decisions: decisionIndex,
            thresholds: prefs.decision.thresholds,
            customCategories: prefs.decision.customCategories,
          },
        );
        setSummary(result);
        if (result.mailCount > 0) summaryRun.current = runKey;
        if (result.source === "llm" && hasDecisionLayer) {
          writeSummaryCache(summaryStorage(), scope, result.period.id, signature, result);
        }
        proposeTasks(
          result.tasks.filter((task) => {
            const mail = task.mailId ? inboxIndex.get(task.mailId) : undefined;
            return !mail || !excludedAccounts.has(mail.account);
          }),
          inboxIndex,
          result.period.label,
        );
      } catch (error) {
        notify(`Résumé indisponible · ${errorText(error)}`);
      } finally {
        summaryRunning.current = false;
        setSummaryLoading(false);
      }
    },
    [
      account,
      decisionIndex,
      decisions,
      excludedAccounts,
      hasDecisionLayer,
      inboxIndex,
      inboxMails,
      mode,
      notify,
      prefs.decision.customCategories,
      prefs.decision.thresholds,
      prefs.llm,
      prefs.summary,
      proposeTasks,
      summaryInputs,
      teamContextFor,
    ],
  );

  /**
   * Propose des tâches extraites des mails de la fenêtre configurée. Le LLM n'est
   * sollicité qu'une fois par contenu de fenêtre (signature window+mails, gardée
   * en mémoire puis sur le poste) et uniquement sur les mails qualifiés par le
   * modèle de décision (`hasTask >= llmEscalate`, hors bruit et prompt injection).
   */
  const refreshTaskSuggestions = useCallback(async () => {
    const config = prefs.aiTasks;
    if (!config.enabled || !prefs.planningEnabled) {
      taskRun.current = null;
      return;
    }
    if (mode !== "api" || !hasDecisionLayer || !llmReady(prefs.llm) || taskRunning.current) return;
    const recent = recentMails(summaryInputs(aiMails), config.windowHours);
    if (recent.length === 0) return;
    const { kept } = filterMailsForLlm(
      recent,
      decisionIndex,
      prefs.decision.thresholds,
      "tasks",
    );
    const signature = `${config.windowHours}:${recent.map((mail) => mail.id).join(",")}:d${Object.keys(decisions).length}:k${kept.map((mail) => mail.id).join(",")}`;
    if (taskRun.current === signature) return;
    if (kept.length > 0 && aiRunDone("tasks", signature)) {
      taskRun.current = signature;
      return;
    }
    taskRunning.current = true;
    try {
      const proposed = await suggestTasks(
        { windowHours: config.windowHours },
        prefs.llm,
        recent,
        new Date(),
        undefined,
        teamContextFor(),
        {
          hybrid: true,
          decisionReady: hasDecisionLayer,
          decisions: decisionIndex,
          thresholds: prefs.decision.thresholds,
        },
      );
      if (proposed === null) return;
      taskRun.current = signature;
      if (kept.length > 0) markAiRun("tasks", signature);
      if (proposed.length === 0) return;
      proposeTasks(proposed, inboxIndex, "Suggestion IA");
    } finally {
      taskRunning.current = false;
    }
  }, [
    aiMails,
    decisionIndex,
    decisions,
    hasDecisionLayer,
    inboxIndex,
    mode,
    prefs.aiTasks,
    prefs.decision.thresholds,
    prefs.llm,
    prefs.planningEnabled,
    proposeTasks,
    summaryInputs,
    teamContextFor,
  ]);

  const refreshSummaryRef = useRef(refreshSummary);
  useEffect(() => {
    refreshSummaryRef.current = refreshSummary;
  }, [refreshSummary]);

  const refreshTaskSuggestionsRef = useRef(refreshTaskSuggestions);
  useEffect(() => {
    refreshTaskSuggestionsRef.current = refreshTaskSuggestions;
  }, [refreshTaskSuggestions]);

  /**
   * Dédup par mail + intitulé + jour, puis par proximité d'intitulé au même
   * jour : un même rendez-vous ne devient jamais deux suggestions, ni ne double
   * un événement déjà présent à l'agenda.
   */
  const proposeEvents = useCallback(
    (proposed: SummaryEvent[], byId: Map<string, Mail>, label: string) => {
      const key = (mailId: string, title: string, date: string) => `${mailId}:${normalize(title)}:${date}`;
      const known = new Set([
        ...planning.suggestions.map((entry) => key(entry.mailId, entry.proposal, entry.date ?? "")),
        ...planning.events.map((entry) => key(entry.mailId ?? "", entry.title, entry.date)),
      ]);
      const existing: DuplicateCandidate[] = [
        ...planning.suggestions.map((entry) => ({
          mailId: entry.mailId,
          title: entry.proposal,
          when: entry.date ?? "",
        })),
        ...planning.events.map((entry) => ({
          mailId: entry.mailId ?? "",
          title: entry.title,
          when: entry.date,
        })),
      ];
      for (const event of proposed) {
        const mail = event.mailId ? byId.get(event.mailId) : undefined;
        if (alreadyReplied(mail)) continue;
        const dedup = key(event.mailId ?? "", event.title, event.date);
        if (known.has(dedup)) continue;
        const candidate = { mailId: event.mailId ?? "", title: event.title, when: event.date };
        if (nearDuplicate(existing, candidate)) continue;
        known.add(dedup);
        existing.push(candidate);
        planning.proposeSuggestion(eventSuggestion(event, mail, label));
      }
    },
    [planning],
  );

  /**
   * Propose des rendez-vous extraits des mails de la fenêtre. Même signature de
   * cache que les tâches (fenêtre + mails) : un seul appel par contenu, jamais
   * en démo, et aucune création automatique d'événement.
   */
  const refreshEventSuggestions = useCallback(async () => {
    const config = prefs.aiTasks;
    if (!config.enabled || !config.events || !prefs.calendarEnabled) {
      eventRun.current = null;
      return;
    }
    if (mode !== "api" || !hasDecisionLayer || !llmReady(prefs.llm) || eventRunning.current) return;
    const recent = recentMails(summaryInputs(aiMails), config.windowHours);
    if (recent.length === 0) return;
    const { kept } = filterMailsForLlm(
      recent,
      decisionIndex,
      prefs.decision.thresholds,
      "events",
    );
    const signature = `${config.windowHours}:${recent.map((mail) => mail.id).join(",")}:d${Object.keys(decisions).length}:k${kept.map((mail) => mail.id).join(",")}`;
    if (eventRun.current === signature) return;
    if (kept.length > 0 && aiRunDone("events", signature)) {
      eventRun.current = signature;
      return;
    }
    eventRunning.current = true;
    try {
      const proposed = await suggestEvents(
        { windowHours: config.windowHours },
        prefs.llm,
        recent,
        new Date(),
        undefined,
        teamContextFor(),
        {
          hybrid: true,
          decisionReady: hasDecisionLayer,
          decisions: decisionIndex,
          thresholds: prefs.decision.thresholds,
        },
      );
      if (proposed === null) return;
      eventRun.current = signature;
      if (kept.length > 0) markAiRun("events", signature);
      if (proposed.length === 0) return;
      proposeEvents(proposed, inboxIndex, "Rendez-vous IA");
    } finally {
      eventRunning.current = false;
    }
  }, [
    aiMails,
    decisionIndex,
    decisions,
    hasDecisionLayer,
    inboxIndex,
    mode,
    prefs.aiTasks,
    prefs.calendarEnabled,
    prefs.decision.thresholds,
    prefs.llm,
    proposeEvents,
    summaryInputs,
    teamContextFor,
  ]);

  /**
   * Analyse du mail ouvert, à la demande : rien ne tourne tant que
   * l'utilisateur ne clique pas, et le cache de l'analyse évite un second
   * passage sur un contenu inchangé. En démo, jamais de réseau.
   */
  const runAnalyse = useCallback(
    async (mail: Mail, force = false) => {
      if (analyseRunning.current) return;
      analyseRunning.current = true;
      const mailId = mail.id;
      analyseRun.current = mailId;
      setAnalyse({ mailId, status: "loading", result: null, error: null });
      const storage = summaryStorage();
      const llm = mode === "demo" ? EMPTY_LLM : prefs.llm;
      const decision = triageDecisionFor(mail, decisionIndex.byKey, decisionIndex.byMessageId);
      try {
        let body = mail.body.join("\n");
        const source = mail.source;
        if (!body.trim() && mode === "api" && source) {
          const message = await mailApi.message(source.accountId, source.folderPath, source.uid);
          body = messageToMail(message, folderRecords).body.join("\n");
        }
        const samples = mode === "demo" ? [] : await sentSamples(mail.account);
        const style = await styleProfile(llm, mail.account, samples, storage);
        const result = await analyseMail(
          llm,
          {
            mailId,
            from: mail.name,
            subject: mail.subject,
            body,
            conversation: threadConversation(undefined, mails, mail.threadId),
          },
          events,
          {
            team: teamContextFor(mail.account),
            style,
            force,
            storage,
            decision,
            thresholds: prefs.decision.thresholds,
          },
        );
        if (analyseRun.current !== mailId) return;
        if (result.source === "local" && llmReady(llm)) {
          setAnalyse({
            mailId,
            status: "error",
            result: null,
            error: "Le modèle n'a rien renvoyé d'exploitable.",
          });
          return;
        }
        setAnalyse({ mailId, status: "ready", result, error: null });
      } catch (error) {
        if (analyseRun.current !== mailId) return;
        setAnalyse({ mailId, status: "error", result: null, error: errorText(error) });
      } finally {
        analyseRunning.current = false;
      }
    },
    [decisionIndex, events, folderRecords, mails, mode, prefs.decision.thresholds, prefs.llm, teamContextFor],
  );

  /** Une tâche analysée suit le circuit de suggestions : validation humaine obligatoire. */
  const acceptAnalyseTask = useCallback(
    (task: AnalyseTask) => {
      proposeTasks([task], inboxIndex, "Analyse IA");
    },
    [inboxIndex, proposeTasks],
  );

  const acceptAnalyseEvent = useCallback(
    (event: SummaryEvent) => {
      proposeEvents([event], inboxIndex, "Analyse IA");
      notify("Rendez-vous proposé dans l'agenda");
    },
    [inboxIndex, notify, proposeEvents],
  );

  const closeAnalyse = useCallback(() => setAnalyse(null), []);

  const refreshEventSuggestionsRef = useRef(refreshEventSuggestions);
  useEffect(() => {
    refreshEventSuggestionsRef.current = refreshEventSuggestions;
  }, [refreshEventSuggestions]);

  useEffect(() => {
    if (mode !== "api" || phase !== "ready" || !isDecisionReady || isComposeWindow()) return;
    const pending = inboxMails
      .filter((mail) => {
        if (!mail.source) return false;
        const key = decisionMailKey(mail.source.accountId, mail.source.folderPath, mail.source.uid);
        if (autoTriagedKeys.current.has(key)) return false;
        return !triageDecisionFor(mail, decisionIndex.byKey, decisionIndex.byMessageId);
      })
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, 40);
    if (pending.length === 0) return;
    for (const mail of pending) {
      if (mail.source) {
        autoTriagedKeys.current.add(
          decisionMailKey(mail.source.accountId, mail.source.folderPath, mail.source.uid),
        );
      }
    }
    void triageMails(pending);
  }, [decisionIndex, inboxMails, isDecisionReady, mode, phase, triageMails]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    summaryRun.current = null;
    void refreshSummaryRef.current();
    const timer = window.setInterval(() => void refreshSummaryRef.current(), SUMMARY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [account, mode, phase, prefs.summary]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshSummaryRef.current();
  }, [decisions, hasDecisionLayer, inboxMails.length, phase]);

  useEffect(() => {
    taskRun.current = null;
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshTaskSuggestionsRef.current();
    const timer = window.setInterval(() => void refreshTaskSuggestionsRef.current(), SUMMARY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [mode, phase, prefs.aiTasks]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshTaskSuggestionsRef.current();
  }, [decisions, hasDecisionLayer, inboxMails.length, phase]);

  useEffect(() => {
    eventRun.current = null;
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshEventSuggestionsRef.current();
    const timer = window.setInterval(() => void refreshEventSuggestionsRef.current(), SUMMARY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [mode, phase, prefs.aiTasks, prefs.calendarEnabled]);

  useEffect(() => {
    if (phase !== "ready" || isComposeWindow()) return;
    void refreshEventSuggestionsRef.current();
  }, [decisions, hasDecisionLayer, inboxMails.length, phase]);

  const openMailId = openMail?.id ?? null;
  const openMailThreadId = openMail?.threadId ?? null;
  const openMailAccount = openMail?.source?.accountId ?? null;
  useEffect(() => {
    setFullThread(null);
    if (mode !== "api" || !openMailId || !openMailThreadId || !openMailAccount) return;
    let cancelled = false;
    threadMails(openMailAccount, openMailThreadId, folderRecords)
      .then((mails) => {
        if (cancelled) return;
        const local = new Map(liveMails.current.map((entry) => [entry.id, entry]));
        setFullThread(mails.map((entry) => local.get(entry.id) ?? entry));
      })
      .catch(() => {
        if (!cancelled) setFullThread(null);
      });
    return () => {
      cancelled = true;
    };
  }, [folderRecords, mode, openMailAccount, openMailId, openMailThreadId, revision]);

  const resolvedOpenMail = useMemo(
    () => (openMail ? (mails.find((entry) => entry.id === openMail.id) ?? openMail) : null),
    [mails, openMail],
  );
  const openThread = useMemo(() => {
    if (!resolvedOpenMail) return undefined;
    const enriched = fullThread ? threadOf(fullThread, resolvedOpenMail) : undefined;
    const thread = enriched ?? threadOf(mails, resolvedOpenMail);
    if (!thread) return undefined;
    /* Le fil rafraîchi arrive dans l'ordre chronologique : le message ouvert
       reste celui qu'on affiche, la réponse envoyée passe dans les antérieurs. */
    const opened = thread.messages.find((message) => message.id === resolvedOpenMail.id);
    return opened && opened.id !== thread.primary.id ? { ...thread, primary: opened } : thread;
  }, [fullThread, mails, resolvedOpenMail]);

  const value = useMemo<MailStoreValue>(
    () => ({
      mails,
      account,
      accountById,
      accounts,
      mailAccounts,
      folder,
      folderPath,
      folderOptions,
      folderRecords,
      mode,
      readOnly: demoReadOnly,
      phase,
      backendError,
      threadsLoading,
      pages,
      hasMore,
      syncing,
      folderStats,
      accountUnread,
      connectOpen,
      removeTarget,
      tasks,
      suggestions,
      summary,
      summaryLoading,
      summaryMails,
      refreshSummary,
      proposeSummaryAction,
      analyse,
      runAnalyse,
      closeAnalyse,
      acceptAnalyseTask,
      acceptAnalyseEvent,
      events,
      selectedDate,
      openMail: resolvedOpenMail,
      openThread,
      bodyFetching,
      fetchBody,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      composeDetached,
      composeSending,
      composeSendError,
      draftSource,
      setAccount,
      setFolder,
      loadMore,
      setTasks,
      setEvents,
      setSelectedDate,
      setComposeDraft,
      setComposeTitle,
      notify,
      dismissNotice,
      toggleStar,
      mailAction,
      bulkMailAction,
      moveToInbox,
      moveToFolder,
      restoreMail,
      emptyTrash,
      addSuggestion,
      dismissSuggestion,
      openMessage,
      closeMessage,
      startBlankDraft,
      resumeDraft,
      openComposer,
      resumeCompose,
      minimizeCompose,
      closeCompose,
      detachCompose,
      dockCompose,
      detachClosed,
      replyTo,
      setReplyTarget,
      forwardMail,
      openReplyWithBody,
      sendDraft,
      saveToDrafts,
      retryBackend,
      refreshMailbox: bootstrap,
      useDemo,
      syncFolder,
      syncFolderAt,
      searchMails,
      loadMoreSearch,
      searchHasMore,
      openConnect,
      closeConnect,
      createAccount,
      renameAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
      deleteFolder,
      hiddenFolderOptions,
      hideFolder,
      unhideFolder,
      folderOrder,
      setFolderOrder,
      decisions,
      isDecisionReady,
      totpAlert,
      dismissTotpAlert,
      triageMails,
    }),
    [
      mails,
      account,
      accountById,
      accounts,
      mailAccounts,
      folder,
      folderPath,
      folderOptions,
      folderRecords,
      mode,
      phase,
      backendError,
      threadsLoading,
      pages,
      hasMore,
      syncing,
      folderStats,
      accountUnread,
      connectOpen,
      removeTarget,
      tasks,
      suggestions,
      summary,
      summaryLoading,
      summaryMails,
      refreshSummary,
      proposeSummaryAction,
      analyse,
      runAnalyse,
      closeAnalyse,
      acceptAnalyseTask,
      acceptAnalyseEvent,
      events,
      selectedDate,
      resolvedOpenMail,
      openThread,
      bodyFetching,
      fetchBody,
      notices,
      composeOpen,
      composeDraft,
      composeTitle,
      composeDetached,
      composeSending,
      composeSendError,
      draftSource,
      setAccount,
      setFolder,
      loadMore,
      notify,
      dismissNotice,
      toggleStar,
      mailAction,
      bulkMailAction,
      moveToInbox,
      moveToFolder,
      restoreMail,
      emptyTrash,
      addSuggestion,
      dismissSuggestion,
      openMessage,
      closeMessage,
      startBlankDraft,
      resumeDraft,
      openComposer,
      resumeCompose,
      minimizeCompose,
      closeCompose,
      detachCompose,
      dockCompose,
      detachClosed,
      replyTo,
      setReplyTarget,
      forwardMail,
      openReplyWithBody,
      sendDraft,
      saveToDrafts,
      retryBackend,
      useDemo,
      syncFolder,
      syncFolderAt,
      searchMails,
      loadMoreSearch,
      searchHasMore,
      openConnect,
      closeConnect,
      createAccount,
      renameAccount,
      askRemoveAccount,
      cancelRemoveAccount,
      confirmRemoveAccount,
      deleteFolder,
      hiddenFolderOptions,
      hideFolder,
      unhideFolder,
      folderOrder,
      setFolderOrder,
      decisions,
      isDecisionReady,
      totpAlert,
      dismissTotpAlert,
      triageMails,
      bootstrap,
    ],
  );

  return <MailStoreContext.Provider value={value}>{children}</MailStoreContext.Provider>;
}

export function useMailStore() {
  const context = useContext(MailStoreContext);
  if (!context) throw new Error("useMailStore must be used inside <MailStoreProvider>");
  return context;
}
