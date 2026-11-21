import { describe, expect, it } from "vitest";
import { createMemoryDecisionDb, decisionMailKey, type MailLlmExtraction } from "@/lib/decision-db";
import type { MailDecision } from "@/lib/decision";

const sample = (overrides: Partial<MailDecision> = {}): MailDecision => ({
  accountId: "perso",
  folderPath: "INBOX",
  uid: 10,
  messageId: "<m-10@exemple.fr>",
  contentHash: "h10",
  schemaVersion: 1,
  model: "mammoth-1",
  category: "promo",
  categoryConf: 0.94,
  categoryProbs: { promo: 0.94, info: 0.06 },
  urgency: 0.2,
  needsReply: 0.02,
  hasTask: 0.01,
  hasEvent: 0.0,
  security: "safe",
  securityConf: 0.99,
  cleanupScore: 0.95,
  decidedAt: 1_700_000_000,
  source: "local",
  ...overrides,
});

describe("decision-db", () => {
  it("stocke, filtre par compte/catégorie et retrouve par messageId", async () => {
    const db = createMemoryDecisionDb();
    await db.putDecisions([
      sample({ uid: 10, category: "promo" }),
      sample({ uid: 11, messageId: "<M-11@EXEMPLE.FR>", category: "important", decidedAt: 1_700_000_500 }),
    ]);

    const byKey = await db.getDecision(decisionMailKey("perso", "INBOX", 10));
    expect(byKey?.category).toBe("promo");

    const byMid = await db.getDecisionByMessageId("<m-11@exemple.fr>");
    expect(byMid?.uid).toBe(11);

    const promos = await db.listDecisions({ category: "promo" });
    expect(promos).toHaveLength(1);

    await db.clearDecisions("perso");
    expect(await db.listDecisions()).toHaveLength(0);
  });

  it("gère les revues de nettoyage Tinder et les expéditeurs protégés", async () => {
    const db = createMemoryDecisionDb();
    const key = decisionMailKey("perso", "INBOX", 10);

    await db.putCleanupReview({ mailKey: key, action: "kept", reviewedAt: 123 });
    expect((await db.getCleanupReview(key))?.action).toBe("kept");

    await db.deleteCleanupReview(key);
    expect(await db.getCleanupReview(key)).toBeNull();

    await db.setSenderProtected("News@Boutique.FR", true);
    expect(await db.isSenderProtected("news@boutique.fr")).toBe(true);
    expect(await db.listProtectedSenders()).toEqual(["news@boutique.fr"]);
  });

  it("stocke, lit par lot et efface le cache incrémental LLM par mail", async () => {
    const db = createMemoryDecisionDb();
    const k1 = decisionMailKey("perso", "INBOX", 10);
    const k2 = decisionMailKey("perso", "INBOX", 11);
    const e1: MailLlmExtraction = {
      mailKey: k1,
      messageId: "<m10@exemple.fr>",
      contentHash: "hash-10",
      summaryReason: "Valider le devis",
      summaryDue: "2026-11-25",
      summaryProcessed: true,
      tasks: [{ title: "Valider le devis", due: "2026-11-25", from: "Camille", mailId: k1 }],
      tasksProcessed: true,
      updatedAt: 1_700_000_100,
    };
    const e2: MailLlmExtraction = {
      mailKey: k2,
      contentHash: "hash-11",
      events: [
        { title: "Point produit", date: "2026-11-26", start: "10:00", end: "10:30", from: "Marc", mailId: k2 },
      ],
      eventsProcessed: true,
      updatedAt: 1_700_000_200,
    };

    expect(await db.getLlmExtraction(k1)).toBeNull();
    await db.putLlmExtraction(e1);
    expect(await db.getLlmExtraction(k1)).toEqual(e1);

    await db.putLlmExtractions([
      { ...e1, summaryReason: "Valider le devis v2", updatedAt: 1_700_000_300 },
      e2,
    ]);
    expect((await db.getLlmExtraction(k1))?.summaryReason).toBe("Valider le devis v2");
    expect((await db.getLlmExtraction(k2))?.eventsProcessed).toBe(true);

    await db.clearLlmExtractions();
    expect(await db.getLlmExtraction(k1)).toBeNull();
    expect(await db.getLlmExtraction(k2)).toBeNull();
  });
});
