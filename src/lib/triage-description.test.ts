import { describe, expect, it } from "vitest";
import { THRESHOLD_PRESETS, type CustomCategory, type MailDecision } from "@/lib/decision";
import { listDescription, reasonFromDecision } from "@/lib/triage";

const THRESHOLDS = THRESHOLD_PRESETS.balanced.values;

const CATEGORIES: CustomCategory[] = [
  {
    id: "factures",
    name: "Factures",
    description: "Factures, devis et justificatifs de paiement",
    color: "emerald",
    excludeFromPriority: false,
    allowNotifications: true,
    cleanupEligible: false,
  },
];

function makeDecision(overrides: Partial<MailDecision> = {}): MailDecision {
  return {
    accountId: "perso",
    folderPath: "INBOX",
    uid: 1,
    messageId: "<m1@example.com>",
    contentHash: "abc123",
    schemaVersion: 1,
    model: "mammoth-1",
    category: "important",
    categoryConf: 0.92,
    categoryProbs: { important: 0.92 },
    urgency: 1.8,
    needsReply: 0.85,
    hasTask: 0.8,
    hasEvent: 0.2,
    security: "safe",
    securityConf: 0.99,
    cleanupScore: 0.05,
    decidedAt: 1_731_000_000,
    source: "local",
    ...overrides,
  };
}

describe("triage · description de la liste (signaux)", () => {
  it("reprend les signaux de reasonFromDecision", () => {
    expect(
      listDescription(
        makeDecision({ urgency: 2.4, needsReply: 0.9, hasTask: 0.1, hasEvent: 0.1 }),
        THRESHOLDS,
        "signaux",
      ),
    ).toBe("Urgent · Réponse attendue");

    expect(
      listDescription(
        makeDecision({ category: "auth_totp", totpCode: "482917", totpService: "GitHub" }),
        THRESHOLDS,
        "signaux",
      ),
    ).toBe("Code GitHub : 482917");
  });

  it("retombe sur l'étiquette de catégorie quand aucun signal ne sort", () => {
    const quiet = { urgency: 1, needsReply: 0.1, hasTask: 0.1, hasEvent: 0.1 };

    expect(listDescription(makeDecision({ category: "info", ...quiet }), THRESHOLDS, "signaux")).toBe(
      "Information",
    );
    expect(
      listDescription(makeDecision({ category: "important", ...quiet }), THRESHOLDS, "signaux"),
    ).toBe("Message prioritaire");
    expect(
      listDescription(makeDecision({ category: "notification", ...quiet }), THRESHOLDS, "signaux"),
    ).toBe("Notification");
    expect(listDescription(makeDecision({ category: "promo", ...quiet }), THRESHOLDS, "signaux")).toBe(
      "Publicité / offre",
    );
    expect(listDescription(makeDecision({ category: "spam", ...quiet }), THRESHOLDS, "signaux")).toBe(
      "Courrier indésirable",
    );
    expect(
      listDescription(makeDecision({ category: "auth_totp", ...quiet }), THRESHOLDS, "signaux"),
    ).toBe("Code de vérification");
  });

  it("nomme la catégorie personnalisée, et retombe sur Information si inconnue", () => {
    const quiet = { urgency: 1, needsReply: 0.1, hasTask: 0.1, hasEvent: 0.1 };

    expect(
      listDescription(
        makeDecision({ category: "custom:factures", ...quiet }),
        THRESHOLDS,
        "signaux",
        CATEGORIES,
      ),
    ).toBe("Factures");
    expect(
      listDescription(
        makeDecision({ category: "factures", ...quiet }),
        THRESHOLDS,
        "signaux",
        CATEGORIES,
      ),
    ).toBe("Factures");
    expect(
      listDescription(makeDecision({ category: "custom:inconnue", ...quiet }), THRESHOLDS, "signaux", CATEGORIES),
    ).toBe("Information");
    expect(listDescription(makeDecision({ category: "info", ...quiet }), THRESHOLDS, "signaux")).toBe(
      "Information",
    );
  });

  it("ignore la phrase du modèle en style signaux", () => {
    expect(
      listDescription(
        makeDecision({ description: "Camille valide la v3 et attend ton retour.", urgency: 1, needsReply: 0.1, hasTask: 0.1, hasEvent: 0.1 }),
        THRESHOLDS,
        "signaux",
      ),
    ).toBe("Message prioritaire");
  });
});

describe("triage · description de la liste (phrase)", () => {
  it("préfère la phrase du modèle", () => {
    expect(
      listDescription(
        makeDecision({ description: "  Camille valide la v3 et attend ton retour.  ", urgency: 2.4 }),
        THRESHOLDS,
        "phrase",
      ),
    ).toBe("Camille valide la v3 et attend ton retour.");
  });

  it("retombe sur les signaux quand la phrase manque ou est vide", () => {
    expect(
      listDescription(
        makeDecision({ urgency: 2.4, needsReply: 0.9, hasTask: 0.1, hasEvent: 0.1 }),
        THRESHOLDS,
        "phrase",
      ),
    ).toBe("Urgent · Réponse attendue");

    expect(
      listDescription(
        makeDecision({ description: "   ", category: "info", urgency: 1, needsReply: 0.1, hasTask: 0.1, hasEvent: 0.1 }),
        THRESHOLDS,
        "phrase",
      ),
    ).toBe("Information");
  });
});

describe("triage · l'alerte sécurité passe avant la phrase", () => {
  const phish = makeDecision({
    security: "phishing",
    securityConf: 0.97,
    description: "Offre commerciale sans intérêt.",
  });
  const injection = makeDecision({
    security: "prompt_injection",
    securityConf: 0.95,
    description: "Récapitulatif hebdomadaire.",
  });

  it("signaux : texte d'hameçonnage et d'injection", () => {
    expect(listDescription(phish, THRESHOLDS, "signaux")).toBe(
      "Hameçonnage détecté · Ne cliquez sur aucun lien",
    );
    expect(listDescription(injection, THRESHOLDS, "signaux")).toBe(
      "Alerte sécurité · injection détectée",
    );
  });

  it("phrase : la phrase du modèle ne masque jamais l'alerte", () => {
    expect(listDescription(phish, THRESHOLDS, "phrase")).toBe(
      reasonFromDecision(phish, THRESHOLDS),
    );
    expect(listDescription(injection, THRESHOLDS, "phrase")).toBe(
      "Alerte sécurité · injection détectée",
    );
  });

  it("sous le seuil de sécurité, la décision reste normale", () => {
    const below = makeDecision({
      security: "phishing",
      securityConf: THRESHOLDS.security - 0.05,
      category: "info",
      urgency: 1,
      needsReply: 0.1,
      hasTask: 0.1,
      hasEvent: 0.1,
    });
    expect(listDescription(below, THRESHOLDS, "signaux")).toBe("Information");
  });
});
