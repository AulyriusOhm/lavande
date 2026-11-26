import { sha256 } from "@noble/hashes/sha2.js";
import { mailApi, type ApiDecisionConfigUpdate, type ApiMailDecision } from "@/lib/api";
import {
  emitDecisionUsage,
  isBlockedFromAutoLlm,
  isExcludedFromPriority,
  isNoiseCategory,
  isPhishing,
  isPromptInjection,
  matchesCustomCategory,
  PRIORITY_TAGS,
  RECENT_MAILS_MAX,
  TAG_LABELS,
  type CustomCategory,
  type DecisionConfig,
  type DecisionThresholds,
  type MailDecision,
} from "@/lib/decision";
import {
  decisionDb,
  decisionMailKey,
  normalizeMessageId,
  type DecisionCacheStore,
} from "@/lib/decision-db";
import type { Mail, MailSource } from "@/lib/mail";
import type { SummaryGroups, SummaryRef } from "@/lib/summary";
import type { EventDraft, NewTaskDraft } from "@/lib/tasks";
import { encodeBase64Url } from "@/lib/sync/crypto";

export const MAX_RECENT_TRIAGE = 40;
const MAX_SUMMARY_ACTIONS = 12;
const MAX_SUMMARY_INFOS = 40;
const MAX_SUMMARY_NOTIFICATIONS = 40;
const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const encoder = new TextEncoder();

export type TriageMailRef = {
  id: string;
  source?: MailSource;
  messageId?: string;
  from?: string;
  email?: string;
  subject?: string;
  timestamp?: number;
  preview?: string;
  snippet?: string;
  body?: readonly string[];
  html?: string;
  hasAuthLink?: boolean;
};

export type DecisionIndex = {
  byKey: Map<string, MailDecision>;
  byMessageId: Map<string, MailDecision>;
};

export type DecisionLookup =
  | DecisionIndex
  | Map<string, MailDecision>
  | Record<string, MailDecision>;

const AUTOMATED =
  /no-?reply|noreply|ne pas r[ée]pondre|notification|newsletter|lettre d'information|liste de diffusion|alerte|automatique/i;

export function fromApiDecision(api: ApiMailDecision): MailDecision {
  return {
    accountId: api.account_id,
    folderPath: api.folder_path,
    uid: api.uid,
    ...(api.message_id ? { messageId: api.message_id } : {}),
    contentHash: api.content_hash,
    schemaVersion: api.schema_version,
    model: api.model,
    ...(api.description ? { description: api.description } : {}),
    category: api.category,
    categoryConf: api.category_conf,
    categoryProbs: api.category_probs ?? {},
    urgency: api.urgency,
    needsReply: api.needs_reply,
    hasTask: api.has_task,
    hasEvent: api.has_event,
    security: api.security,
    securityConf: api.security_conf,
    cleanupScore: api.cleanup_score,
    ...(api.assignee ? { assignee: api.assignee } : {}),
    ...(typeof api.assignee_conf === "number" ? { assigneeConf: api.assignee_conf } : {}),
    ...(api.totp_code ? { totpCode: api.totp_code } : {}),
    ...(api.totp_service ? { totpService: api.totp_service } : {}),
    ...(api.suggested_folder ? { suggestedFolder: api.suggested_folder } : {}),
    ...(typeof api.suggested_folder_conf === "number"
      ? { suggestedFolderConf: api.suggested_folder_conf }
      : {}),
    decidedAt: api.decided_at,
    source: api.source === "synced" ? "synced" : "local",
  };
}

export function toApiDecision(dec: MailDecision): ApiMailDecision {
  return {
    account_id: dec.accountId,
    folder_path: dec.folderPath,
    uid: dec.uid,
    ...(dec.messageId ? { message_id: dec.messageId } : {}),
    content_hash: dec.contentHash,
    schema_version: dec.schemaVersion,
    model: dec.model,
    ...(dec.description ? { description: dec.description } : {}),
    category: dec.category,
    category_conf: dec.categoryConf,
    category_probs: dec.categoryProbs,
    urgency: dec.urgency,
    needs_reply: dec.needsReply,
    has_task: dec.hasTask,
    has_event: dec.hasEvent,
    security: dec.security,
    security_conf: dec.securityConf,
    cleanup_score: dec.cleanupScore,
    ...(dec.assignee ? { assignee: dec.assignee } : {}),
    ...(typeof dec.assigneeConf === "number" ? { assignee_conf: dec.assigneeConf } : {}),
    ...(dec.totpCode ? { totp_code: dec.totpCode } : {}),
    ...(dec.totpService ? { totp_service: dec.totpService } : {}),
    ...(dec.suggestedFolder ? { suggested_folder: dec.suggestedFolder } : {}),
    ...(typeof dec.suggestedFolderConf === "number"
      ? { suggested_folder_conf: dec.suggestedFolderConf }
      : {}),
    decided_at: dec.decidedAt,
    source: dec.source,
  };
}

/** Clé stable multi-appareils (PC <-> Mobile) pour le canal E2EE `ai`. */
export function stableDecisionKey(
  decision: Pick<MailDecision, "accountId" | "folderPath" | "uid" | "messageId">,
): string {
  const normalized = normalizeMessageId(decision.messageId);
  const seed = normalized || decisionMailKey(decision.accountId, decision.folderPath, decision.uid);
  return encodeBase64Url(sha256(encoder.encode(seed))).slice(0, 22);
}

export function indexDecisions(
  decisions: Iterable<MailDecision> | Record<string, MailDecision>,
): DecisionIndex {
  const byKey = new Map<string, MailDecision>();
  const byMessageId = new Map<string, MailDecision>();
  const entries: [string | null, MailDecision][] =
    Symbol.iterator in decisions
      ? Array.from(decisions as Iterable<MailDecision>, (dec) => [null, dec])
      : Object.entries(decisions as Record<string, MailDecision>);
  const setBest = (map: Map<string, MailDecision>, key: string, dec: MailDecision) => {
    const existing = map.get(key);
    if (!existing || dec.decidedAt >= existing.decidedAt) {
      map.set(key, dec);
    }
  };
  for (const [recordKey, dec] of entries) {
    if (recordKey) {
      setBest(byKey, recordKey, dec);
    }
    if (dec.uid > 0 || !recordKey) {
      setBest(byKey, decisionMailKey(dec.accountId, dec.folderPath, dec.uid), dec);
    }
    const mid = normalizeMessageId(dec.messageId);
    if (mid) {
      setBest(byMessageId, mid, dec);
    }
  }
  return { byKey, byMessageId };
}

function isDecisionIndex(value: DecisionLookup): value is DecisionIndex {
  return (
    typeof value === "object" &&
    value !== null &&
    "byKey" in value &&
    value.byKey instanceof Map &&
    "byMessageId" in value &&
    value.byMessageId instanceof Map
  );
}

export function asDecisionIndex(lookup: DecisionLookup): DecisionIndex {
  if (isDecisionIndex(lookup)) return lookup;
  if (lookup instanceof Map) {
    const byMessageId = new Map<string, MailDecision>();
    for (const dec of lookup.values()) {
      const mid = normalizeMessageId(dec.messageId);
      if (mid) byMessageId.set(mid, dec);
    }
    return { byKey: lookup, byMessageId };
  }
  return indexDecisions(lookup);
}

export function hasAnyDecision(lookup: DecisionLookup | undefined): boolean {
  if (!lookup) return false;
  if (isDecisionIndex(lookup)) return lookup.byKey.size > 0 || lookup.byMessageId.size > 0;
  if (lookup instanceof Map) return lookup.size > 0;
  return Object.keys(lookup).length > 0;
}

/**
 * Retrouve la décision d'un mail par `accountId:folderPath:uid` (ou `mail.id`),
 * puis par `messageId` normalisé (permettant à un mobile sans clé API d'hériter
 * automatiquement des décisions calculées par le PC).
 */
export function triageDecisionFor(
  mail: Pick<TriageMailRef, "id" | "source" | "messageId">,
  decisionsByKey: Map<string, MailDecision> | Record<string, MailDecision>,
  decisionsByMessageId?: Map<string, MailDecision>,
): MailDecision | undefined {
  const byKeyMap = decisionsByKey instanceof Map ? decisionsByKey : null;
  const byKeyObj = decisionsByKey instanceof Map ? null : decisionsByKey;

  const lookupKey = (key: string): MailDecision | undefined =>
    byKeyMap ? byKeyMap.get(key) : byKeyObj?.[key];

  if (mail.source) {
    const key = decisionMailKey(mail.source.accountId, mail.source.folderPath, mail.source.uid);
    const hit = lookupKey(key);
    if (hit) return hit;
  }

  const direct = lookupKey(mail.id);
  if (direct) return direct;

  const mid = normalizeMessageId(mail.messageId);
  if (!mid) return undefined;

  if (decisionsByMessageId) {
    const hit = decisionsByMessageId.get(mid);
    if (hit) return hit;
  }

  const values = byKeyMap ? byKeyMap.values() : Object.values(byKeyObj ?? {});
  for (const dec of values) {
    if (normalizeMessageId(dec.messageId) === mid) return dec;
  }
  return undefined;
}

function findCustomCategory(
  category: string,
  customCategories?: readonly CustomCategory[],
): CustomCategory | undefined {
  if (!customCategories) return undefined;
  if (category.startsWith("custom:")) {
    const id = category.slice("custom:".length);
    return customCategories.find((cat) => cat.id === id);
  }
  return customCategories.find((cat) => cat.id === category);
}

const ONE_DAY_MS = 24 * 3_600_000;
const UNSUBSCRIBE_LINK = /unsubscribe|desinscri|désinscri|opt[-_]?out/i;
const AUTH_LINK_HINT =
  /verify|verif|confirm|activat|token|magic|login|auth|signin|signup|register|account|valider|connexion/i;
const ASSET_EXT = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)(?:\?|$)/i;

export function normalizeTrustedSender(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim().toLowerCase();
}

export function normalizeTrustedDomain(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

export function senderDomain(email: string | null | undefined): string {
  if (!email) return "";
  const normalized = normalizeTrustedSender(email);
  const at = normalized.lastIndexOf("@");
  if (at === -1 || at === normalized.length - 1) return "";
  return normalized.slice(at + 1).trim();
}

export function isTrustedSender(
  email: string | null | undefined,
  trustedSenders: readonly string[] | undefined,
  trustedDomains: readonly string[] | undefined,
): boolean {
  if (!email) return false;
  const normalized = normalizeTrustedSender(email);
  if (!normalized) return false;
  if (trustedSenders?.some((entry) => normalizeTrustedSender(entry) === normalized)) {
    return true;
  }
  const domain = senderDomain(normalized);
  if (!domain) return false;
  return Boolean(trustedDomains?.some((entry) => normalizeTrustedDomain(entry) === domain));
}

export function applyTrustRules(
  decision: MailDecision,
  senderEmail: string | null | undefined,
  config: Pick<DecisionConfig, "trustedSenders" | "trustedDomains">,
): MailDecision {
  if (!isTrustedSender(senderEmail, config.trustedSenders, config.trustedDomains)) {
    return decision;
  }
  const nextCategory =
    decision.category === "spam" || decision.category === "promo" ? "important" : decision.category;
  if (decision.security === "safe" && decision.securityConf === 1 && nextCategory === decision.category) {
    return decision;
  }
  return {
    ...decision,
    security: "safe",
    securityConf: 1,
    category: nextCategory,
  };
}

export type AuthLinkSource =
  | string
  | readonly string[]
  | { body?: readonly string[]; html?: string; preview?: string; snippet?: string }
  | null
  | undefined;

function authSourceText(input: AuthLinkSource): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.join("\n");
  const obj = input as { body?: readonly string[]; html?: string; preview?: string; snippet?: string };
  return [...(obj.body ?? []), obj.html ?? "", obj.preview ?? "", obj.snippet ?? ""].join("\n");
}

/**
 * Extrait un lien HTTPS de vérification / connexion depuis le contenu d'un mail,
 * en excluant tout lien de désinscription (`unsubscribe`).
 */
export function extractAuthLink(input: AuthLinkSource): string | null {
  const text = authSourceText(input);
  if (!text) return null;
  const matches = text.match(/https:\/\/[^\s"'<>()]+/gi) ?? [];
  const candidates: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/&amp;/gi, "&").replace(/[.,;:!?)\]>'"]+$/, "");
    if (!cleaned.toLowerCase().startsWith("https://")) continue;
    if (UNSUBSCRIBE_LINK.test(cleaned)) continue;
    if (!candidates.includes(cleaned)) candidates.push(cleaned);
  }
  if (candidates.length === 0) return null;
  return (
    candidates.find((url) => !ASSET_EXT.test(url) && AUTH_LINK_HINT.test(url)) ??
    candidates.find((url) => !ASSET_EXT.test(url)) ??
    candidates[0]
  );
}

function decisionTimestampMs(mail: Pick<TriageMailRef, "timestamp">, dec: MailDecision): number {
  if (typeof mail.timestamp === "number" && Number.isFinite(mail.timestamp)) return mail.timestamp;
  return dec.decidedAt > 1e12 ? dec.decidedAt : dec.decidedAt * 1000;
}

function isRecentAuth(
  mail: Pick<TriageMailRef, "timestamp" | "body" | "html" | "preview" | "snippet" | "hasAuthLink">,
  dec: MailDecision,
  nowMs: number,
): boolean {
  if (dec.category !== "auth_totp") return false;
  if (nowMs - decisionTimestampMs(mail, dec) >= ONE_DAY_MS) return false;
  return Boolean(dec.totpCode?.trim() || mail.hasAuthLink || extractAuthLink(mail));
}

export type SummaryDecisionMeta = {
  phishing: boolean;
  injection: boolean;
  suspect: boolean;
  urgent: boolean;
  totpCode: string | null;
  totpService: string | null;
  authLink: string | null;
  needsReply: boolean;
  hasEvent: boolean;
  customCategory: CustomCategory | undefined;
  folderSuggestion: { path: string; label: string } | null;
  noiseTag: "Pub" | "Spam" | "Code expiré" | null;
};

/**
 * Extrait les métadonnées d'action rapide (sécurité, TOTP, urgence,
 * catégorie personnalisée et dossier suggéré) pour l'affichage du Résumé.
 */
export function summaryDecisionMeta(
  mail: Pick<TriageMailRef, "id" | "source" | "body" | "html" | "preview" | "snippet"> & {
    folderName?: string;
  },
  dec: MailDecision | undefined,
  thresholds: DecisionThresholds,
  customCategories?: readonly CustomCategory[],
): SummaryDecisionMeta {
  if (!dec) {
    return {
      phishing: false,
      injection: false,
      suspect: false,
      urgent: false,
      totpCode: null,
      totpService: null,
      authLink: null,
      needsReply: false,
      hasEvent: false,
      customCategory: undefined,
      folderSuggestion: null,
      noiseTag: null,
    };
  }
  const phishing = isPhishing(dec, thresholds);
  const injection = isPromptInjection(dec, thresholds);
  const suspect = phishing || injection;
  const totpCode = dec.category === "auth_totp" && dec.totpCode?.trim() ? dec.totpCode.trim() : null;
  const totpService = dec.totpService?.trim() || null;
  const authLink =
    !suspect && dec.category === "auth_totp" && !totpCode ? extractAuthLink(mail) : null;

  let folderSuggestion: { path: string; label: string } | null = null;
  if (!suspect && dec.suggestedFolder && (dec.suggestedFolderConf ?? 0) >= thresholds.folder) {
    const path = dec.suggestedFolder;
    const label = path.split(/[/.]/).filter(Boolean).pop() || path;
    const currentPath = mail.source?.folderPath;
    const alreadyThere =
      (currentPath && currentPath === path) ||
      (mail.folderName && (mail.folderName === path || mail.folderName === label));
    if (!alreadyThere) {
      folderSuggestion = { path, label };
    }
  }

  const noiseTag: SummaryDecisionMeta["noiseTag"] =
    dec.category === "promo"
      ? "Pub"
      : dec.category === "spam"
        ? "Spam"
        : dec.category === "auth_totp"
          ? "Code expiré"
          : null;

  return {
    phishing,
    injection,
    suspect,
    urgent: !suspect && dec.urgency >= 2.0,
    totpCode,
    totpService,
    authLink,
    needsReply: !suspect && !totpCode && !authLink && dec.needsReply >= thresholds.category,
    hasEvent: !suspect && !totpCode && !authLink && dec.hasEvent >= thresholds.llmEscalate,
    customCategory: findCustomCategory(dec.category, customCategories),
    folderSuggestion,
    noiseTag,
  };
}

/**
 * Filtre strictement les mails avant tout envoi automatique au LLM Système 2 :
 * - Exclut les catégories bruyantes (`NOISE_CATEGORIES`) et prompt_injection (>= security).
 * - Garde pour `"tasks"` uniquement `hasTask >= thresholds.llmEscalate`.
 * - Garde pour `"events"` uniquement `hasEvent >= thresholds.llmEscalate`.
 * - Garde pour `"summary"` important, info, catégories custom non exclues,
 *   ou `needsReply >= thresholds.category` / `urgency >= 1.5`, triés par urgence décroissante.
 */
export function filterMailsForLlm<T extends TriageMailRef>(
  mails: readonly T[],
  decisions: DecisionLookup,
  thresholds: DecisionThresholds,
  kind: "tasks" | "events" | "summary",
  options?: {
    customCategories?: readonly CustomCategory[];
    trustedSenders?: readonly string[];
    trustedDomains?: readonly string[];
  },
): { kept: T[]; skippedCount: number } {
  const index = asDecisionIndex(decisions);
  const trustConfig = {
    trustedSenders: [...(options?.trustedSenders ?? [])],
    trustedDomains: [...(options?.trustedDomains ?? [])],
  };
  const qualified: { mail: T; urgency: number; order: number }[] = [];
  let skippedCount = 0;

  mails.forEach((mail, order) => {
    const rawDec = triageDecisionFor(mail, index.byKey, index.byMessageId);
    const dec = rawDec ? applyTrustRules(rawDec, mail.email, trustConfig) : undefined;
    if (!dec || isBlockedFromAutoLlm(dec, thresholds)) {
      skippedCount += 1;
      return;
    }

    if (kind === "tasks") {
      if (dec.hasTask >= thresholds.llmEscalate) {
        qualified.push({ mail, urgency: dec.urgency, order });
      } else {
        skippedCount += 1;
      }
      return;
    }

    if (kind === "events") {
      if (dec.hasEvent >= thresholds.llmEscalate) {
        qualified.push({ mail, urgency: dec.urgency, order });
      } else {
        skippedCount += 1;
      }
      return;
    }

    const custom = findCustomCategory(dec.category, options?.customCategories);
    const highSignal =
      dec.needsReply >= thresholds.category ||
      dec.urgency >= 1.5 ||
      dec.hasTask >= thresholds.llmEscalate ||
      dec.hasEvent >= thresholds.llmEscalate;

    if (custom?.excludeFromPriority && !highSignal) {
      skippedCount += 1;
      return;
    }

    if (
      dec.category === "important" ||
      dec.category === "info" ||
      dec.category.startsWith("custom:") ||
      highSignal
    ) {
      qualified.push({ mail, urgency: dec.urgency, order });
    } else {
      skippedCount += 1;
    }
  });

  if (kind === "summary") {
    qualified.sort((a, b) => b.urgency - a.urgency || a.order - b.order);
  }

  return { kept: qualified.map((entry) => entry.mail), skippedCount };
}

/**
 * Génère une raison courte et lisible en français à partir des signaux Système 1.
 */
export function reasonFromDecision(dec: MailDecision, thresholds: DecisionThresholds): string {
  if (isPhishing(dec, thresholds)) return "Hameçonnage détecté · Ne cliquez sur aucun lien";
  if (isPromptInjection(dec, thresholds)) return "Alerte sécurité · injection détectée";
  if (dec.category === "auth_totp") {
    if (dec.totpCode) {
      return dec.totpService
        ? `Code ${dec.totpService} : ${dec.totpCode}`
        : `Code de vérification : ${dec.totpCode}`;
    }
    return "Code de vérification";
  }
  if (dec.category === "promo") return "Publicité / offre";
  if (dec.category === "spam") return "Courrier indésirable";

  const signals: string[] = [];
  if (dec.urgency >= 2.0) signals.push("Urgent");
  if (dec.needsReply >= thresholds.category) signals.push("Réponse attendue");
  if (dec.hasTask >= thresholds.llmEscalate) signals.push("Tâche détectée");
  if (dec.hasEvent >= thresholds.llmEscalate) signals.push("Rendez-vous proposé");
  const assignee = dec.assignee?.trim();
  if (assignee && assignee.toLowerCase() !== "moi" && assignee.toLowerCase() !== "aucun") {
    signals.push(`Assigné à ${assignee}`);
  }
  if (signals.length > 0) return signals.slice(0, 3).join(" · ");
  if (dec.category === "important") return "Message prioritaire";
  return TAG_LABELS[dec.category] ?? "";
}

const CATEGORY_TAGS: Record<string, string> = {
  important: "Message prioritaire",
  info: "Information",
  promo: "Publicité / offre",
  spam: "Courrier indésirable",
  auth_totp: "Code de vérification",
  ...TAG_LABELS,
};

/** Libellé FR d'un tag de puce fine : taxonomie, sinon catégorie historique, sinon id. */
export function inboxTagLabel(tag: string): string {
  return CATEGORY_TAGS[tag] ?? tag;
}

/**
 * Ligne de description affichée dans la liste : l'alerte sécurité passe
 * toujours avant, une phrase du modèle remplace les signaux quand elle existe.
 */
export function listDescription(
  dec: MailDecision,
  thresholds: DecisionThresholds,
  style: "signaux" | "phrase",
  customCategories?: readonly CustomCategory[],
): string {
  if (isPhishing(dec, thresholds) || isPromptInjection(dec, thresholds)) {
    return reasonFromDecision(dec, thresholds);
  }
  if (style === "phrase") {
    const phrase = dec.description?.trim();
    if (phrase) return phrase;
  }
  const signals = reasonFromDecision(dec, thresholds);
  if (signals) return signals;
  return (
    findCustomCategory(dec.category, customCategories)?.name ??
    CATEGORY_TAGS[dec.category] ??
    "Information"
  );
}

/**
 * Construit instantanément les 3 groupes `{ actions, infos, notifications }`
 * à partir des décisions Système 1, sans aucun appel LLM.
 */
export function summaryGroupsFromDecisions<T extends TriageMailRef>(
  mails: readonly T[],
  decisions: DecisionLookup,
  thresholds: DecisionThresholds,
  options?: {
    customCategories?: readonly CustomCategory[];
    now?: number;
    trustedSenders?: readonly string[];
    trustedDomains?: readonly string[];
  },
): SummaryGroups {
  const index = asDecisionIndex(decisions);
  const nowMs = options?.now ?? Date.now();
  const trustConfig = {
    trustedSenders: [...(options?.trustedSenders ?? [])],
    trustedDomains: [...(options?.trustedDomains ?? [])],
  };
  const ordered = mails
    .map((mail, order) => {
      const raw = triageDecisionFor(mail, index.byKey, index.byMessageId);
      return {
        mail,
        dec: raw ? applyTrustRules(raw, mail.email, trustConfig) : undefined,
        order,
      };
    })
    .sort((a, b) => (b.dec?.urgency ?? -1) - (a.dec?.urgency ?? -1) || a.order - b.order);

  const authActions: SummaryRef[] = [];
  const suspectActions: SummaryRef[] = [];
  const normalActions: SummaryRef[] = [];
  const groups: SummaryGroups = { actions: [], infos: [], notifications: [] };
  const seen = new Set<string>();

  for (const { mail, dec } of ordered) {
    if (!mail.id || seen.has(mail.id)) continue;
    seen.add(mail.id);

    if (!dec) {
      const ref: SummaryRef = { mailId: mail.id, reason: "" };
      if (AUTOMATED.test(`${mail.from ?? ""} ${mail.subject ?? ""}`)) {
        if (groups.notifications.length < MAX_SUMMARY_NOTIFICATIONS) groups.notifications.push(ref);
      } else if (groups.infos.length < MAX_SUMMARY_INFOS) {
        groups.infos.push(ref);
      }
      continue;
    }

    const reason = reasonFromDecision(dec, thresholds);
    const ref: SummaryRef = { mailId: mail.id, reason };

    if (isRecentAuth(mail, dec, nowMs)) {
      authActions.push(ref);
      continue;
    }

    if (isPhishing(dec, thresholds) || isPromptInjection(dec, thresholds)) {
      suspectActions.push(ref);
      continue;
    }

    if (isNoiseCategory(dec.category)) {
      if (groups.notifications.length < MAX_SUMMARY_NOTIFICATIONS) groups.notifications.push(ref);
      continue;
    }

    const custom = findCustomCategory(dec.category, options?.customCategories);
    const isAction =
      dec.category === "important" ||
      PRIORITY_TAGS.has(dec.category) ||
      dec.needsReply >= thresholds.category ||
      dec.hasTask >= thresholds.llmEscalate ||
      dec.hasEvent >= thresholds.llmEscalate ||
      dec.urgency >= 1.5;

    if (custom?.excludeFromPriority && !isAction) {
      if (groups.infos.length < MAX_SUMMARY_INFOS) groups.infos.push(ref);
      continue;
    }

    if (isAction) {
      normalActions.push(ref);
    } else if (groups.infos.length < MAX_SUMMARY_INFOS) {
      groups.infos.push(ref);
    }
  }

  groups.actions = [...authActions, ...suspectActions, ...normalActions].slice(0, MAX_SUMMARY_ACTIONS);
  return groups;
}

/** Tons de `categoryColorStyle` utilisables par les groupes de puces. */
export type InboxGroupColor = "accent" | "emerald" | "amber" | "rose" | "sky" | "violet";

export type InboxGroupId =
  | "codes"
  | "achats"
  | "compte"
  | "activite"
  | "lecture"
  | "promos";

export type InboxGroup = {
  id: InboxGroupId;
  label: string;
  /** Teinte du groupe ; `null` = neutre (pas de pastille). */
  color: InboxGroupColor | null;
  tags: readonly string[];
};

/**
 * Taxonomie de la première rangée de puces : chaque groupe fédère ses tags.
 * RDV et le résiduel « notification » n'ont qu'un tag : ce sont des filtres
 * directs (`tag:calendar_invite`, `tag:notification`), sans rangée fine.
 */
export const INBOX_GROUPS: readonly InboxGroup[] = [
  { id: "codes", label: "Codes & Auth", color: "sky", tags: ["auth_totp", "login_alert"] },
  {
    id: "achats",
    label: "Achats",
    color: "amber",
    tags: ["order_confirmation", "delivery_tracking", "invoice_receipt"],
  },
  {
    id: "compte",
    label: "Compte & admin",
    color: "emerald",
    tags: ["account_notice", "messaging_notice", "finance_activity"],
  },
  {
    id: "activite",
    label: "Activité",
    color: "violet",
    tags: ["dev_activity", "social_digest", "system_alert"],
  },
  { id: "lecture", label: "Lecture", color: "accent", tags: ["newsletter_digest", "survey_request"] },
  { id: "promos", label: "Pub & Promos", color: null, tags: ["promo", "spam"] },
];

/** Vues proposées dans les réglages ; ids persistés dans `defaultInboxFilter`. */
export const INBOX_VIEWS: readonly { id: string; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "priority", label: "Prioritaire" },
  { id: "needs_reply", label: "À répondre" },
  ...INBOX_GROUPS.map((group) => ({ id: `group:${group.id}`, label: group.label })),
  { id: "tag:calendar_invite", label: "RDV" },
  { id: "tag:notification", label: "Notifications" },
];

export function inboxGroup(id: string): InboxGroup | undefined {
  return INBOX_GROUPS.find((group) => group.id === id);
}

/** Groupe qui porte une catégorie décidée ; `undefined` hors taxonomie groupée. */
export function inboxGroupForCategory(category: string): InboxGroup | undefined {
  return INBOX_GROUPS.find((group) => group.tags.includes(category));
}

/** Groupe concerné par un filtre `group:<id>` ou `tag:<catégorie>` (rangée fine). */
export function inboxGroupForFilter(filter: string): InboxGroup | undefined {
  if (filter.startsWith("group:")) return inboxGroup(filter.slice("group:".length));
  if (filter.startsWith("tag:")) return inboxGroupForCategory(filter.slice("tag:".length));
  return undefined;
}

export type InboxSmartCounts = {
  priority: number;
  needsReply: number;
  /** Nombre de conversations par catégorie décidée (important, info et résiduel inclus). */
  tags: Record<string, number>;
  /** Somme des tags membres de chaque groupe de puces. */
  groups: Record<InboxGroupId, number>;
  custom: Record<string, number>;
};

/**
 * Compteurs des puces de la boîte de réception, calculés une seule fois pour PC
 * (`inbox.tsx`) et mobile (`inbox-screen.tsx`) : priorité (hors bruit par nature),
 * réponse attendue, volume par catégorie, par groupe et par catégorie custom.
 * Passer une liste vide donne les compteurs à zéro (vue intelligente inactive).
 */
export function inboxSmartCounts<T>(
  threads: readonly T[],
  decisionFor: (thread: T) => MailDecision | undefined,
  options: {
    customCategories: readonly CustomCategory[];
    thresholds: Pick<DecisionThresholds, "category">;
    answered?: (thread: T) => boolean;
  },
): InboxSmartCounts {
  const custom: Record<string, number> = {};
  for (const cat of options.customCategories) custom[cat.id] = 0;
  const tags: Record<string, number> = {};
  let priority = 0;
  let needsReply = 0;

  for (const thread of threads) {
    const dec = decisionFor(thread);
    if (!isExcludedFromPriority(dec, options.customCategories)) priority += 1;
    if (!dec) continue;
    if (dec.needsReply >= options.thresholds.category && !options.answered?.(thread)) {
      needsReply += 1;
    }
    tags[dec.category] = (tags[dec.category] ?? 0) + 1;
    for (const cat of options.customCategories) {
      if (matchesCustomCategory(dec.category, cat.id)) custom[cat.id] += 1;
    }
  }

  const groups = {} as Record<InboxGroupId, number>;
  for (const group of INBOX_GROUPS) {
    groups[group.id] = group.tags.reduce((sum, tag) => sum + (tags[tag] ?? 0), 0);
  }

  return { priority, needsReply, tags, groups, custom };
}

export type InboxChipEntry = {
  id: string;
  label: string;
  count: number;
  color: InboxGroupColor | null;
};

/** Puces de la première rangée, dans l'ordre validé (PC et mobile identiques). */
export function inboxChipEntries(counts: InboxSmartCounts): InboxChipEntry[] {
  return [
    { id: "priority", label: "Prioritaire", count: counts.priority, color: null },
    { id: "needs_reply", label: "À répondre", count: counts.needsReply, color: null },
    ...INBOX_GROUPS.map((group) => ({
      id: `group:${group.id}`,
      label: group.label,
      count: counts.groups[group.id],
      color: group.color,
    })),
    { id: "tag:calendar_invite", label: "RDV", count: counts.tags.calendar_invite ?? 0, color: "rose" },
    {
      id: "tag:notification",
      label: "Notifications",
      count: counts.tags.notification ?? 0,
      color: null,
    },
  ];
}

/** Tags adressables par un filtre `tag:<catégorie>` (taxonomie + catégories historiques). */
export const INBOX_FILTER_TAGS: ReadonlySet<string> = new Set([
  ...Object.keys(TAG_LABELS),
  "important",
  "info",
  "auth_totp",
  "promo",
  "spam",
]);

export function taskDraftFromMail(
  mail: Pick<Mail, "id" | "name" | "subject" | "preview" | "body">,
  ref?: Pick<SummaryRef, "reason" | "due">,
  decision?: Pick<MailDecision, "assignee">,
): NewTaskDraft {
  const title = mail.subject.trim() || ref?.reason.trim() || "Action à traiter";
  const reason = ref?.reason.trim() ?? "";
  const excerpt = mail.preview.trim() || mail.body[0]?.trim() || "";
  const description =
    reason && excerpt && reason !== excerpt ? `${reason}\n\n${excerpt}` : reason || excerpt;
  const dueDate = ref?.due && ISO_DAY.test(ref.due) ? ref.due : undefined;
  const rawAssignee = decision?.assignee?.trim();
  const assignee =
    rawAssignee && rawAssignee.toLowerCase() !== "moi" && rawAssignee.toLowerCase() !== "aucun"
      ? rawAssignee
      : undefined;
  return {
    title,
    ...(description ? { description } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(assignee ? { assignee } : {}),
    mailId: mail.id,
    mailFrom: mail.name,
    mailSubject: mail.subject,
  };
}

export function eventDraftFromMail(
  mail: Pick<Mail, "id" | "name" | "subject">,
  ref?: Pick<SummaryRef, "reason" | "due">,
): EventDraft {
  const title = mail.subject.trim() || ref?.reason.trim() || "Rendez-vous";
  const date = ref?.due && ISO_DAY.test(ref.due) ? ref.due : undefined;
  return {
    title,
    ...(date ? { date } : {}),
    mailId: mail.id,
    mailFrom: mail.name,
    mailSubject: mail.subject,
  };
}

export type TriageRecentOptions = {
  mails: readonly Mail[];
  existingDecisions?: DecisionLookup;
  teamMembers?: string[];
  force?: boolean;
  limit?: number;
  db?: DecisionCacheStore;
  domain?: string;
  publishSynced?: (decision: MailDecision) => void;
  /** Reçoit une fois les clés des mails réellement envoyés au modèle. */
  onPendingKeys?: (keys: string[]) => void;
};

export function toApiDecisionConfig(
  config: DecisionConfig,
  options?: { apiKey?: string; clearApiKey?: boolean },
): ApiDecisionConfigUpdate {
  return {
    enabled: config.enabled,
    provider: config.provider,
    protocol: config.protocol,
    endpoint: config.endpoint,
    model: config.model,
    auth_header: config.authHeader,
    thresholds: {
      llm_escalate: config.thresholds.llmEscalate,
      category: config.thresholds.category,
      security: config.thresholds.security,
      folder: config.thresholds.folder,
    },
    custom_categories: config.customCategories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      color: cat.color,
      exclude_from_priority: cat.excludeFromPriority,
      allow_notifications: cat.allowNotifications,
      cleanup_eligible: cat.cleanupEligible,
    })),
    default_inbox_filter: config.defaultInboxFilter,
    notif_mode: config.notifMode,
    pre_send_guard: config.preSendGuard,
    totp_popup: config.totpPopup,
    spam_enabled: config.spamEnabled,
    trusted_senders: config.trustedSenders ?? [],
    trusted_domains: config.trustedDomains ?? [],
    recent_mail_count: config.recentMailCount,
    ...(options?.apiKey ? { api_key: options.apiKey } : {}),
    ...(options?.clearApiKey ? { clear_api_key: true } : {}),
  };
}

/**
 * File de triage bornée côté front : en mode API, trie au plus `limit` mails
 * récents (le réglage « mails récents analysés », 10 à 200) non encore en
 * cache, met à jour IndexedDB, émet les stats de décision et publie chaque
 * décision sur le canal E2EE `ai` si actif. Sans limite explicite, le défaut
 * `MAX_RECENT_TRIAGE` s'applique.
 */
export async function triageRecentMails(options: TriageRecentOptions): Promise<MailDecision[]> {
  const cap =
    typeof options.limit === "number"
      ? Math.min(Math.max(1, options.limit), RECENT_MAILS_MAX)
      : MAX_RECENT_TRIAGE;
  const existing = asDecisionIndex(options.existingDecisions ?? new Map());
  const store = options.db ?? decisionDb();

  const sorted = [...options.mails]
    .filter((mail): mail is Mail & { source: MailSource } => Boolean(mail.source))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  const targets: { account_id: string; folder_path: string; uid: number }[] = [];
  for (const mail of sorted) {
    if (targets.length >= cap) break;
    if (!options.force) {
      const hit = triageDecisionFor(mail, existing.byKey, existing.byMessageId);
      if (hit) continue;
      const key = decisionMailKey(mail.source.accountId, mail.source.folderPath, mail.source.uid);
      const cached = await store.getDecision(key);
      if (cached) continue;
    }
    targets.push({
      account_id: mail.source.accountId,
      folder_path: mail.source.folderPath,
      uid: mail.source.uid,
    });
  }

  if (targets.length === 0) return [];

  options.onPendingKeys?.(
    targets.map((target) => decisionMailKey(target.account_id, target.folder_path, target.uid)),
  );

  const reply = await mailApi.triageDecisions({
    targets,
    team_members: options.teamMembers,
    force: options.force,
  });

  const decisions: MailDecision[] = [];
  for (const entry of reply.results) {
    const decision = fromApiDecision(entry.decision);
    decisions.push(decision);
    if (!entry.cached && (entry.usage || typeof entry.latency_ms === "number")) {
      emitDecisionUsage({
        model: decision.model,
        domain: options.domain ?? "",
        usage: {
          prompt: entry.usage?.prompt_tokens ?? 0,
          completion: entry.usage?.completion_tokens ?? 0,
        },
        latencyMs: entry.latency_ms ?? 0,
        energyJoules: entry.energy?.energy_joules,
      });
    }
    options.publishSynced?.(decision);
  }

  if (decisions.length > 0) {
    await store.putDecisions(decisions);
  }

  return decisions;
}
