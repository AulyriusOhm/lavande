import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECISION_THRESHOLDS,
  type CustomCategory,
  type MailDecision,
} from "@/lib/decision";
import { decisionMailKey, type CleanupReview } from "@/lib/decision-db";
import type { Mail } from "@/lib/mail";
import {
  TOTP_STALE_MS,
  applyCleanupStat,
  buildCleanupDeck,
  countCleanupByFilter,
  emptyCleanupStats,
  formatCleanupSize,
  groupCleanupBySender,
  mailCleanupKey,
} from "@/lib/cleanup";

const NOW = 1_760_000_000_000;

function makeMail(overrides: Partial<Mail> = {}): Mail {
  const id = overrides.id ?? "m1";
  return {
    id,
    account: "perso",
    folder: "inbox",
    name: "Boutique X",
    email: "news@boutique-x.fr",
    subject: "Soldes d'hiver -40 %",
    preview: "Profitez de notre offre spéciale avant dimanche.",
    body: ["Profitez de notre offre spéciale avant dimanche."],
    time: "10:00",
    timestamp: NOW - 2 * 3_600_000,
    unread: true,
    starred: false,
    pgp: "none",
    tone: 0,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<MailDecision> = {}): MailDecision {
  return {
    accountId: "perso",
    folderPath: "INBOX",
    uid: 1,
    contentHash: "hash-1",
    schemaVersion: 1,
    model: "mammoth-1",
    category: "promo",
    categoryConf: 0.94,
    categoryProbs: { promo: 0.94, info: 0.06 },
    urgency: 0.1,
    needsReply: 0.02,
    hasTask: 0.01,
    hasEvent: 0.0,
    security: "safe",
    securityConf: 0.99,
    cleanupScore: 0.92,
    decidedAt: NOW,
    source: "local",
    ...overrides,
  };
}

describe("cleanup logic", () => {
  it("retient les promos, spams (hors dossier spam), vieux TOTP >= 24 h et notifications", () => {
    const promo = makeMail({ id: "p1", name: "Boutique X", email: "news@boutique.fr" });
    const oldTotp = makeMail({
      id: "t-old",
      name: "GitHub",
      email: "noreply@github.com",
      subject: "Code de vérification : 482917",
      timestamp: NOW - 5 * 24 * 3_600_000,
    });
    const freshTotp = makeMail({
      id: "t-fresh",
      name: "GitHub",
      email: "noreply@github.com",
      subject: "Code de vérification : 112233",
      timestamp: NOW - 2 * 3_600_000,
    });
    const notif = makeMail({
      id: "n1",
      name: "Service Cloud",
      email: "alerts@cloud.test",
      subject: "Sauvegarde terminée",
    });
    const highScoreInfo = makeMail({
      id: "n2",
      name: "Newsletter",
      email: "digest@info.test",
      subject: "Digest du matin",
    });
    const important = makeMail({
      id: "imp",
      name: "Camille",
      email: "camille@studio.fr",
      subject: "Contrat à relire",
    });

    const decisions: Record<string, MailDecision> = {
      p1: makeDecision({ category: "promo", categoryConf: 0.94 }),
      "t-old": makeDecision({ category: "auth_totp", categoryConf: 0.97, cleanupScore: 0.95 }),
      // Même avec un cleanupScore élevé, un code TOTP < 24 h NE DOIT PAS être nettoyable !
      "t-fresh": makeDecision({ category: "auth_totp", categoryConf: 0.99, cleanupScore: 0.99 }),
      n1: makeDecision({ category: "notification", categoryConf: 0.88 }),
      n2: makeDecision({ category: "info", categoryConf: 0.65, cleanupScore: 0.82 }),
      imp: makeDecision({ category: "important", categoryConf: 0.95, cleanupScore: 0.05 }),
    };

    const all = buildCleanupDeck(
      [promo, oldTotp, freshTotp, notif, highScoreInfo, important],
      decisions,
      [],
      [],
      DEFAULT_DECISION_THRESHOLDS,
      "all",
      NOW,
    );

    expect(all.map((c) => c.mail.id)).toEqual(["p1", "t-old", "n1", "n2"]);
    expect(all[0].reason).toBe("Publicité · 94 %");
    expect(all[1].reason).toBe("Code TOTP expiré · il y a 5 j · 97 %");
    expect(all[2].reason).toBe("Notification jetable · 88 %");
    expect(all[3].reason).toBe("Mail éphémère · 82 %");

    expect(
      buildCleanupDeck([promo, oldTotp, notif], decisions, [], [], DEFAULT_DECISION_THRESHOLDS, "promo", NOW).map(
        (c) => c.mail.id,
      ),
    ).toEqual(["p1"]);
    expect(
      buildCleanupDeck([promo, oldTotp, notif], decisions, [], [], DEFAULT_DECISION_THRESHOLDS, "old_totp", NOW).map(
        (c) => c.mail.id,
      ),
    ).toEqual(["t-old"]);
    expect(
      buildCleanupDeck(
        [promo, oldTotp, notif, highScoreInfo],
        decisions,
        [],
        [],
        DEFAULT_DECISION_THRESHOLDS,
        "notifications",
        NOW,
      ).map((c) => c.mail.id),
    ).toEqual(["n1", "n2"]);
  });

  it("respecte exactement le seuil de 24 h pour les TOTP", () => {
    const justUnder = makeMail({ id: "u", timestamp: NOW - (TOTP_STALE_MS - 1000) });
    const exactBoundary = makeMail({ id: "e", timestamp: NOW - TOTP_STALE_MS });
    const decisions: Record<string, MailDecision> = {
      u: makeDecision({ category: "auth_totp", categoryConf: 0.9, cleanupScore: 0.99 }),
      e: makeDecision({ category: "auth_totp", categoryConf: 0.9, cleanupScore: 0.99 }),
    };

    const deck = buildCleanupDeck([justUnder, exactBoundary], decisions, [], [], DEFAULT_DECISION_THRESHOLDS, "all", NOW);
    expect(deck.map((c) => c.mail.id)).toEqual(["e"]);
  });

  it("exclut corbeille, spam, envoyés, brouillons, étoilés, déjà revus et expéditeurs protégés", () => {
    const trash = makeMail({ id: "m-trash", folder: "trash" });
    const spam = makeMail({ id: "m-spam", folder: "spam" });
    const sent = makeMail({ id: "m-sent", folder: "sent" });
    const drafts = makeMail({ id: "m-drafts", folder: "drafts" });
    const starred = makeMail({ id: "m-star", starred: true });
    const protectedSender = makeMail({ id: "m-prot", email: "VIP@Boutique-X.FR" });
    const reviewedByKey = makeMail({
      id: "m-rev-key",
      source: { accountId: "perso", folderPath: "INBOX", uid: 42 },
    });
    const reviewedByMid = makeMail({
      id: "m-rev-mid",
      messageId: "<Already-Seen@Example.org>",
    });
    const eligible = makeMail({ id: "m-ok", email: "promo@autre.fr" });

    const allMails = [
      trash,
      spam,
      sent,
      drafts,
      starred,
      protectedSender,
      reviewedByKey,
      reviewedByMid,
      eligible,
    ];

    const decisions: Record<string, MailDecision> = {};
    for (const mail of allMails) {
      decisions[mailCleanupKey(mail)] = makeDecision({ category: "promo", categoryConf: 0.9 });
    }

    const reviews: CleanupReview[] = [
      { mailKey: decisionMailKey("perso", "INBOX", 42), action: "kept", reviewedAt: NOW - 1000 },
      {
        mailKey: "autre-cle",
        messageId: "<already-seen@example.org>",
        action: "trashed",
        reviewedAt: NOW - 500,
      },
    ];

    const deck = buildCleanupDeck(
      allMails,
      decisions,
      reviews,
      ["vip@boutique-x.fr"],
      DEFAULT_DECISION_THRESHOLDS,
      "all",
      NOW,
    );

    expect(deck.map((c) => c.mail.id)).toEqual(["m-ok"]);
  });

  it("prend en charge les catégories custom selon cleanupEligible", () => {
    const customEligible: CustomCategory = {
      id: "colis",
      name: "Suivis colis",
      description: "Notifications de livraison",
      color: "#8b7cf6",
      excludeFromPriority: true,
      allowNotifications: false,
      cleanupEligible: true,
    };
    const customLocked: CustomCategory = {
      id: "factures",
      name: "Factures",
      description: "Factures et reçus",
      color: "#0f7a56",
      excludeFromPriority: false,
      allowNotifications: true,
      cleanupEligible: false,
    };

    const m1 = makeMail({ id: "c1" });
    const m2 = makeMail({ id: "c2" });
    const decisions: Record<string, MailDecision> = {
      c1: makeDecision({ category: "colis", categoryConf: 0.91, cleanupScore: 0.4 }),
      c2: makeDecision({ category: "factures", categoryConf: 0.95, cleanupScore: 0.99 }),
    };

    const deck = buildCleanupDeck(
      [m1, m2],
      decisions,
      [],
      [],
      DEFAULT_DECISION_THRESHOLDS,
      "all",
      NOW,
      [customEligible, customLocked],
    );

    expect(deck.map((c) => c.mail.id)).toEqual(["c1"]);
    expect(deck[0].reason).toBe("Suivis colis · 91 %");
  });

  it("regroupe par expéditeur et trie par volume décroissant", () => {
    const mails = [
      makeMail({ id: "a1", name: "Service A", email: "a@test.fr" }),
      makeMail({ id: "b1", name: "Boutique X", email: "news@boutique.fr" }),
      makeMail({ id: "b2", name: "Boutique X", email: "NEWS@boutique.fr" }),
      makeMail({ id: "b3", name: "Boutique X", email: "news@boutique.fr" }),
    ];
    const decisions: Record<string, MailDecision> = {
      a1: makeDecision({ category: "notification", categoryConf: 0.85 }),
      b1: makeDecision({ category: "promo", categoryConf: 0.93 }),
      b2: makeDecision({ category: "promo", categoryConf: 0.92 }),
      b3: makeDecision({ category: "promo", categoryConf: 0.91 }),
    };

    const cards = buildCleanupDeck(mails, decisions, [], [], DEFAULT_DECISION_THRESHOLDS, "all", NOW);
    const groups = groupCleanupBySender(cards);

    expect(groups).toHaveLength(2);
    expect(groups[0].senderEmail).toBe("news@boutique.fr");
    expect(groups[0].count).toBe(3);
    expect(groups[0].summaryLabel).toBe("3 pubs de Boutique X");
    expect(groups[1].senderEmail).toBe("a@test.fr");
    expect(groups[1].count).toBe(1);
    expect(groups[1].summaryLabel).toBe("1 notification de Service A");
  });

  it("calcule les compteurs par filtre, la taille estimée et les stats de session", () => {
    const mails = [
      makeMail({ id: "1" }),
      makeMail({ id: "2", timestamp: NOW - 3 * 24 * 3_600_000 }),
      makeMail({ id: "3" }),
    ];
    const decisions: Record<string, MailDecision> = {
      "1": makeDecision({ category: "promo" }),
      "2": makeDecision({ category: "auth_totp" }),
      "3": makeDecision({ category: "notification" }),
    };

    expect(countCleanupByFilter(mails, decisions, [], [], DEFAULT_DECISION_THRESHOLDS, NOW)).toEqual({
      all: 3,
      promo: 1,
      old_totp: 1,
      notifications: 1,
    });

    expect(formatCleanupSize(0)).toBe("0 Ko");
    expect(formatCleanupSize(2)).toBe("~350 Ko");
    expect(formatCleanupSize(24)).toBe("~4,2 Mo");

    let stats = emptyCleanupStats();
    stats = applyCleanupStat(stats, "trashed", 3, 1);
    stats = applyCleanupStat(stats, "kept", 2, 1);
    expect(stats).toEqual({ trashed: 3, kept: 2, archived: 0, processed: 5 });
    stats = applyCleanupStat(stats, "trashed", 3, -1);
    expect(stats).toEqual({ trashed: 0, kept: 2, archived: 0, processed: 2 });
  });
});
