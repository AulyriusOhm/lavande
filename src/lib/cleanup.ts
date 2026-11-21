import {
  DEFAULT_DECISION_THRESHOLDS,
  type CustomCategory,
  type DecisionThresholds,
  type MailDecision,
} from "@/lib/decision";
import {
  decisionMailKey,
  normalizeMessageId,
  type CleanupAction,
  type CleanupReview,
} from "@/lib/decision-db";
import type { FolderId, Mail } from "@/lib/mail";

/**
 * Logique pure du mode Nettoyage / Tinder de mails (« Inbox Detox »).
 *
 * Règle d'or absolue : aucune suppression automatique n'est jamais déclenchée
 * ici. Ce module ne fait que sélectionner les candidats éligibles et formuler
 * des raisons humaines pour l'interface sous contrôle explicite de l'utilisateur.
 */

export type CleanupFilter = "all" | "promo" | "old_totp" | "notifications";
export type CleanupCardKind = Exclude<CleanupFilter, "all">;

/** Âge minimal (24 h) avant qu'un code TOTP soit proposé au nettoyage. */
export const TOTP_STALE_MS = 24 * 3_600_000;

const DAY_MS = 24 * 3_600_000;
const IGNORED_FOLDERS = new Set<FolderId>(["trash", "spam", "sent", "drafts"]);
const ESTIMATED_MAIL_KB = 175;

export type CleanupCard = {
  mailKey: string;
  mail: Mail;
  decision: MailDecision;
  kind: CleanupCardKind;
  reason: string;
  senderEmail: string;
  senderName: string;
  confidence: number;
};

export type CleanupSenderGroup = {
  senderEmail: string;
  senderName: string;
  tone: number;
  cards: CleanupCard[];
  mails: Mail[];
  count: number;
  summaryLabel: string;
  primaryReason: string;
};

export type CleanupSessionStats = {
  trashed: number;
  kept: number;
  archived: number;
  processed: number;
};

export type ReviewsInput =
  | readonly CleanupReview[]
  | ReadonlyMap<string, CleanupReview>
  | Readonly<Record<string, CleanupReview>>;

export type ProtectedSendersInput = readonly string[] | ReadonlySet<string>;

export function emptyCleanupStats(): CleanupSessionStats {
  return { trashed: 0, kept: 0, archived: 0, processed: 0 };
}

export function applyCleanupStat(
  stats: CleanupSessionStats,
  action: CleanupAction,
  count: number,
  direction: 1 | -1 = 1,
): CleanupSessionStats {
  const delta = Math.max(0, count) * direction;
  const clamp = (value: number) => Math.max(0, value);
  return {
    trashed: action === "trashed" ? clamp(stats.trashed + delta) : stats.trashed,
    kept: action === "kept" ? clamp(stats.kept + delta) : stats.kept,
    archived: action === "archived" ? clamp(stats.archived + delta) : stats.archived,
    processed: clamp(stats.processed + delta),
  };
}

export function mailCleanupKey(mail: Mail): string {
  if (mail.source) {
    return decisionMailKey(mail.source.accountId, mail.source.folderPath, mail.source.uid);
  }
  return mail.id;
}

export function resolveMailDecision(
  mail: Mail,
  decisions: Readonly<Record<string, MailDecision>>,
): MailDecision | null {
  const key = mailCleanupKey(mail);
  if (decisions[key]) return decisions[key];
  if (decisions[mail.id]) return decisions[mail.id];
  if (mail.messageId) {
    const raw = decisions[mail.messageId];
    if (raw) return raw;
    const norm = decisions[normalizeMessageId(mail.messageId)];
    if (norm) return norm;
  }
  return null;
}

function mailTimestampMs(mail: Mail, decision: MailDecision): number | null {
  if (typeof mail.timestamp === "number" && Number.isFinite(mail.timestamp)) {
    return mail.timestamp;
  }
  if (typeof decision.decidedAt === "number" && Number.isFinite(decision.decidedAt) && decision.decidedAt > 0) {
    return decision.decidedAt < 1e12 ? decision.decidedAt * 1000 : decision.decidedAt;
  }
  return null;
}

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function classifyCleanupMail(
  mail: Mail,
  decision: MailDecision,
  thresholds: Pick<DecisionThresholds, "category">,
  customCategories: readonly CustomCategory[],
  now: number,
): { kind: CleanupCardKind; reason: string; confidence: number } | null {
  if (decision.category === "promo" || decision.category === "spam") {
    const confidence = decision.categoryConf;
    const label = decision.category === "spam" ? "Courrier indésirable" : "Publicité";
    return {
      kind: "promo",
      confidence,
      reason: `${label} · ${percent(confidence)} %`,
    };
  }

  if (decision.category === "auth_totp") {
    const ts = mailTimestampMs(mail, decision);
    if (ts === null) return null;
    const ageMs = now - ts;
    if (ageMs < TOTP_STALE_MS) return null;
    const days = Math.max(1, Math.floor(ageMs / DAY_MS));
    const confidence = decision.categoryConf;
    return {
      kind: "old_totp",
      confidence,
      reason: `Code TOTP expiré · il y a ${days} j · ${percent(confidence)} %`,
    };
  }

  const custom = customCategories.find(
    (entry) => entry.id === decision.category || entry.name === decision.category,
  );
  if (custom) {
    if (!custom.cleanupEligible) return null;
    const confidence = decision.categoryConf;
    return {
      kind: "notifications",
      confidence,
      reason: `${custom.name} · ${percent(confidence)} %`,
    };
  }

  if (decision.category === "notification") {
    const confidence = decision.categoryConf;
    return {
      kind: "notifications",
      confidence,
      reason: `Notification jetable · ${percent(confidence)} %`,
    };
  }

  if (decision.cleanupScore >= thresholds.category) {
    const confidence = decision.cleanupScore;
    return {
      kind: "notifications",
      confidence,
      reason: `Mail éphémère · ${percent(confidence)} %`,
    };
  }

  return null;
}

function extractReviewSets(reviews: ReviewsInput): {
  keys: Set<string>;
  messageIds: Set<string>;
} {
  const keys = new Set<string>();
  const messageIds = new Set<string>();
  const items: Iterable<CleanupReview> = Array.isArray(reviews)
    ? reviews
    : reviews instanceof Map
      ? reviews.values()
      : Object.values(reviews);

  for (const review of items) {
    if (review.mailKey) keys.add(review.mailKey);
    const mid = normalizeMessageId(review.messageId);
    if (mid) messageIds.add(mid);
  }
  return { keys, messageIds };
}

function extractProtectedSet(protectedSenders: ProtectedSendersInput): Set<string> {
  const set = new Set<string>();
  for (const email of protectedSenders) {
    const norm = email.trim().toLowerCase();
    if (norm) set.add(norm);
  }
  return set;
}

/**
 * Construit la pile de cartes nettoyables selon le filtre choisi, en excluant
 * corbeille/spam/envoyés/brouillons, favoris, mails déjà revus et expéditeurs protégés.
 */
export function buildCleanupDeck(
  mails: readonly Mail[],
  decisions: Readonly<Record<string, MailDecision>>,
  reviews: ReviewsInput = [],
  protectedSenders: ProtectedSendersInput = [],
  thresholds: Pick<DecisionThresholds, "category"> = DEFAULT_DECISION_THRESHOLDS,
  filter: CleanupFilter = "all",
  now: number = Date.now(),
  customCategories: readonly CustomCategory[] = [],
): CleanupCard[] {
  const { keys: reviewedKeys, messageIds: reviewedMessageIds } = extractReviewSets(reviews);
  const protectedSet = extractProtectedSet(protectedSenders);
  const deck: CleanupCard[] = [];

  for (const mail of mails) {
    if (IGNORED_FOLDERS.has(mail.folder)) continue;
    if (mail.starred) continue;

    const senderEmail = mail.email.trim().toLowerCase();
    if (senderEmail && protectedSet.has(senderEmail)) continue;

    const mailKey = mailCleanupKey(mail);
    if (reviewedKeys.has(mailKey) || reviewedKeys.has(mail.id)) continue;
    const normMid = normalizeMessageId(mail.messageId);
    if (normMid && reviewedMessageIds.has(normMid)) continue;

    const decision = resolveMailDecision(mail, decisions);
    if (!decision) continue;

    const classified = classifyCleanupMail(mail, decision, thresholds, customCategories, now);
    if (!classified) continue;
    if (filter !== "all" && classified.kind !== filter) continue;

    deck.push({
      mailKey,
      mail,
      decision,
      kind: classified.kind,
      reason: classified.reason,
      senderEmail,
      senderName: mail.name.trim() || mail.email,
      confidence: classified.confidence,
    });
  }

  return deck;
}

export function countCleanupByFilter(
  mails: readonly Mail[],
  decisions: Readonly<Record<string, MailDecision>>,
  reviews: ReviewsInput = [],
  protectedSenders: ProtectedSendersInput = [],
  thresholds: Pick<DecisionThresholds, "category"> = DEFAULT_DECISION_THRESHOLDS,
  now: number = Date.now(),
  customCategories: readonly CustomCategory[] = [],
): Record<CleanupFilter, number> {
  const all = buildCleanupDeck(
    mails,
    decisions,
    reviews,
    protectedSenders,
    thresholds,
    "all",
    now,
    customCategories,
  );
  const counts: Record<CleanupFilter, number> = {
    all: all.length,
    promo: 0,
    old_totp: 0,
    notifications: 0,
  };
  for (const card of all) {
    counts[card.kind] += 1;
  }
  return counts;
}

function senderGroupLabel(cards: readonly CleanupCard[], senderName: string): string {
  const count = cards.length;
  const kinds = new Set(cards.map((card) => card.kind));
  let noun: string;
  if (kinds.size === 1 && kinds.has("promo")) {
    noun = count > 1 ? "pubs" : "pub";
  } else if (kinds.size === 1 && kinds.has("old_totp")) {
    noun = count > 1 ? "vieux codes" : "vieux code";
  } else if (kinds.size === 1 && kinds.has("notifications")) {
    noun = count > 1 ? "notifications" : "notification";
  } else {
    noun = count > 1 ? "mails" : "mail";
  }
  return `${count} ${noun} de ${senderName}`;
}

/** Regroupe les cartes par expéditeur, triées par volume décroissant. */
export function groupCleanupBySender(cards: readonly CleanupCard[]): CleanupSenderGroup[] {
  const buckets = new Map<string, CleanupCard[]>();
  for (const card of cards) {
    const key = card.senderEmail || card.mailKey;
    const list = buckets.get(key);
    if (list) list.push(card);
    else buckets.set(key, [card]);
  }

  const groups: CleanupSenderGroup[] = [];
  for (const [senderEmail, groupCards] of buckets.entries()) {
    const first = groupCards[0];
    const senderName = first.senderName || senderEmail;
    groups.push({
      senderEmail,
      senderName,
      tone: first.mail.tone,
      cards: groupCards,
      mails: groupCards.map((card) => card.mail),
      count: groupCards.length,
      summaryLabel: senderGroupLabel(groupCards, senderName),
      primaryReason: first.reason,
    });
  }

  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const tsA = Math.max(...a.mails.map((m) => m.timestamp ?? 0));
    const tsB = Math.max(...b.mails.map((m) => m.timestamp ?? 0));
    return tsB - tsA;
  });

  return groups;
}

/** Estimation lisible de l'espace libéré pour `count` mails nettoyés. */
export function formatCleanupSize(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0 Ko";
  const kb = Math.round(count * ESTIMATED_MAIL_KB);
  if (kb < 1000) return `~${kb} Ko`;
  const mb = (kb / 1000).toFixed(1).replace(".", ",");
  return `~${mb} Mo`;
}
