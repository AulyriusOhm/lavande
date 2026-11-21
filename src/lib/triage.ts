import { sha256 } from "@noble/hashes/sha2.js";
import { mailApi, type ApiDecisionConfigUpdate, type ApiMailDecision } from "@/lib/api";
import {
  emitDecisionUsage,
  isBlockedFromAutoLlm,
  isNoiseCategory,
  isPromptInjection,
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
import { encodeBase64Url } from "@/lib/sync/crypto";

export const MAX_RECENT_TRIAGE = 40;
const MAX_SUMMARY_ACTIONS = 12;
const MAX_SUMMARY_INFOS = 40;
const MAX_SUMMARY_NOTIFICATIONS = 40;
const encoder = new TextEncoder();

export type TriageMailRef = {
  id: string;
  source?: MailSource;
  messageId?: string;
  from?: string;
  subject?: string;
  timestamp?: number;
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
  const entries =
    Symbol.iterator in decisions
      ? (decisions as Iterable<MailDecision>)
      : Object.values(decisions as Record<string, MailDecision>);
  for (const dec of entries) {
    const key = decisionMailKey(dec.accountId, dec.folderPath, dec.uid);
    const existing = byKey.get(key);
    if (!existing || dec.decidedAt >= existing.decidedAt) {
      byKey.set(key, dec);
    }
    const mid = normalizeMessageId(dec.messageId);
    if (mid) {
      const existingMid = byMessageId.get(mid);
      if (!existingMid || dec.decidedAt >= existingMid.decidedAt) {
        byMessageId.set(mid, dec);
      }
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
  if (!customCategories || !category.startsWith("custom:")) return undefined;
  const id = category.slice("custom:".length);
  return customCategories.find((cat) => cat.id === id);
}

/**
 * Filtre strictement les mails avant tout envoi automatique au LLM Système 2 :
 * - Exclut promo, spam, auth_totp, notification et prompt_injection (>= security).
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
  options?: { customCategories?: readonly CustomCategory[] },
): { kept: T[]; skippedCount: number } {
  const index = asDecisionIndex(decisions);
  const qualified: { mail: T; urgency: number; order: number }[] = [];
  let skippedCount = 0;

  mails.forEach((mail, order) => {
    const dec = triageDecisionFor(mail, index.byKey, index.byMessageId);
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

function decisionReason(dec: MailDecision, thresholds: DecisionThresholds): string {
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
  if (dec.category === "notification") return "Notification";
  if (dec.needsReply >= thresholds.category) return "Réponse attendue";
  if (dec.hasTask >= thresholds.llmEscalate) return "Action détectée";
  if (dec.hasEvent >= thresholds.llmEscalate) return "Rendez-vous détecté";
  if (dec.urgency >= 2.0) return "Urgent";
  if (dec.category === "important") return "Message prioritaire";
  return "";
}

/**
 * Construit instantanément les 3 groupes `{ actions, infos, notifications }`
 * à partir des décisions Système 1, sans aucun appel LLM.
 */
export function summaryGroupsFromDecisions<T extends TriageMailRef>(
  mails: readonly T[],
  decisions: DecisionLookup,
  thresholds: DecisionThresholds,
  options?: { customCategories?: readonly CustomCategory[] },
): SummaryGroups {
  const index = asDecisionIndex(decisions);
  const ordered = mails
    .map((mail, order) => ({
      mail,
      dec: triageDecisionFor(mail, index.byKey, index.byMessageId),
      order,
    }))
    .sort((a, b) => (b.dec?.urgency ?? -1) - (a.dec?.urgency ?? -1) || a.order - b.order);

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

    const reason = decisionReason(dec, thresholds);
    const ref: SummaryRef = { mailId: mail.id, reason };

    if (isPromptInjection(dec, thresholds) || isNoiseCategory(dec.category)) {
      if (groups.notifications.length < MAX_SUMMARY_NOTIFICATIONS) groups.notifications.push(ref);
      continue;
    }

    const custom = findCustomCategory(dec.category, options?.customCategories);
    const isAction =
      dec.category === "important" ||
      dec.needsReply >= thresholds.category ||
      dec.hasTask >= thresholds.llmEscalate ||
      dec.hasEvent >= thresholds.llmEscalate ||
      dec.urgency >= 1.5;

    if (custom?.excludeFromPriority && !isAction) {
      if (groups.infos.length < MAX_SUMMARY_INFOS) groups.infos.push(ref);
      continue;
    }

    if (isAction) {
      if (groups.actions.length < MAX_SUMMARY_ACTIONS) groups.actions.push(ref);
    } else if (groups.infos.length < MAX_SUMMARY_INFOS) {
      groups.infos.push(ref);
    }
  }

  return groups;
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
    ...(options?.apiKey ? { api_key: options.apiKey } : {}),
    ...(options?.clearApiKey ? { clear_api_key: true } : {}),
  };
}

/**
 * File de triage bornée côté front : en mode API, trie au plus 40 mails récents
 * (ou jusqu'à `limit`, borné à 50 pour le scan manuel) non encore en cache,
 * met à jour IndexedDB, émet les stats de décision et publie chaque décision
 * sur le canal E2EE `ai` si actif.
 */
export async function triageRecentMails(options: TriageRecentOptions): Promise<MailDecision[]> {
  const cap =
    typeof options.limit === "number"
      ? Math.min(Math.max(1, options.limit), 50)
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
