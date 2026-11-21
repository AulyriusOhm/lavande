import { describe, expect, it } from "vitest";
import { createMemoryDecisionDb, decisionMailKey } from "@/lib/decision-db";
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
});
