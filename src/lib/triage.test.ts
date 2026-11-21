import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THRESHOLD_PRESETS, setDecisionUsageSink, type MailDecision } from "@/lib/decision";
import { createMemoryDecisionDb, decisionMailKey } from "@/lib/decision-db";
import type { Mail } from "@/lib/mail";
import {
  MAX_RECENT_TRIAGE,
  filterMailsForLlm,
  fromApiDecision,
  indexDecisions,
  stableDecisionKey,
  summaryGroupsFromDecisions,
  toApiDecision,
  triageDecisionFor,
  triageRecentMails,
} from "@/lib/triage";

const THRESHOLDS = THRESHOLD_PRESETS.balanced.values;

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

function makeMail(uid: number, overrides: Partial<Mail> = {}): Mail {
  return {
    id: `perso:INBOX:${uid}`,
    account: "perso",
    folder: "inbox",
    source: { accountId: "perso", folderPath: "INBOX", uid },
    messageId: `<m${uid}@example.com>`,
    name: `Expéditeur ${uid}`,
    email: `sender${uid}@example.com`,
    subject: `Sujet ${uid}`,
    preview: `Aperçu ${uid}`,
    body: [`Corps ${uid}`],
    time: "10:00",
    timestamp: 1_731_000_000_000 + uid * 60_000,
    unread: true,
    starred: false,
    pgp: "none",
    tone: 0,
    ...overrides,
  };
}

beforeEach(() => {
  setDecisionUsageSink(null);
});

afterEach(() => {
  setDecisionUsageSink(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("triage · convertisseurs et recherche multi-appareils", () => {
  it("convertit aller-retour ApiMailDecision <-> MailDecision", () => {
    const dec = makeDecision({
      assignee: "Marc",
      assigneeConf: 0.88,
      totpCode: "482917",
      totpService: "GitHub",
      suggestedFolder: "Factures",
      suggestedFolderConf: 0.91,
      source: "synced",
    });

    const api = toApiDecision(dec);
    expect(api.account_id).toBe("perso");
    expect(api.totp_code).toBe("482917");
    expect(api.suggested_folder).toBe("Factures");
    expect(fromApiDecision(api)).toEqual(dec);
  });

  it("retrouve une décision par clé exacte ou par messageId normalisé (héritage PC -> Mobile)", () => {
    const pcDecision = makeDecision({
      accountId: "pc-account",
      folderPath: "INBOX",
      uid: 999,
      messageId: "  <OTP-42@GitHub.com> ",
      category: "auth_totp",
      totpCode: "482917",
      source: "synced",
    });
    const localDecision = makeDecision({ uid: 1, messageId: "<local-1@x>" });
    const idx = indexDecisions([pcDecision, localDecision]);

    const mobileMail = makeMail(77, {
      account: "mobile-account",
      source: { accountId: "mobile-account", folderPath: "INBOX", uid: 77 },
      messageId: "<otp-42@github.com>",
    });

    expect(triageDecisionFor(mobileMail, idx.byKey, idx.byMessageId)).toEqual(pcDecision);
    expect(triageDecisionFor(makeMail(1), idx.byKey, idx.byMessageId)).toEqual(localDecision);
    expect(stableDecisionKey(pcDecision)).toBe(stableDecisionKey({ ...pcDecision, accountId: "mobile", uid: 77 }));
  });
});

describe("triage · filterMailsForLlm (budget & pare-feu)", () => {
  const mails = [
    makeMail(1), // important, hasTask=0.8, hasEvent=0.2, urgency=1.8
    makeMail(2), // promo
    makeMail(3), // spam
    makeMail(4), // auth_totp
    makeMail(5), // notification
    makeMail(6), // prompt_injection >= 0.8
    makeMail(7), // info avec hasEvent=0.85, hasTask=0.1, urgency=1.2
    makeMail(8), // custom exclu de prioritaire
  ];

  const decisions = indexDecisions([
    makeDecision({ uid: 1, messageId: "<m1@example.com>" }),
    makeDecision({ uid: 2, messageId: "<m2@example.com>", category: "promo", hasTask: 0.9, hasEvent: 0.9, urgency: 2.5 }),
    makeDecision({ uid: 3, messageId: "<m3@example.com>", category: "spam", hasTask: 0.9 }),
    makeDecision({ uid: 4, messageId: "<m4@example.com>", category: "auth_totp", hasTask: 0.9 }),
    makeDecision({ uid: 5, messageId: "<m5@example.com>", category: "notification", hasTask: 0.9 }),
    makeDecision({
      uid: 6,
      messageId: "<m6@example.com>",
      category: "important",
      hasTask: 0.99,
      hasEvent: 0.99,
      urgency: 3.0,
      security: "prompt_injection",
      securityConf: 0.91,
    }),
    makeDecision({
      uid: 7,
      messageId: "<m7@example.com>",
      category: "info",
      urgency: 2.4,
      needsReply: 0.1,
      hasTask: 0.1,
      hasEvent: 0.85,
    }),
    makeDecision({
      uid: 8,
      messageId: "<m8@example.com>",
      category: "custom:factures",
      urgency: 0.5,
      needsReply: 0.1,
      hasTask: 0.2,
      hasEvent: 0.1,
    }),
  ]);

  it("exclut strictement promo, spam, auth_totp, notification et prompt_injection pour tasks", () => {
    const { kept, skippedCount } = filterMailsForLlm(mails, decisions, THRESHOLDS, "tasks");
    expect(kept.map((m) => m.source?.uid)).toEqual([1]);
    expect(skippedCount).toBe(7);
  });

  it("ne garde que hasEvent >= llmEscalate et hors bruit/injection pour events", () => {
    const { kept, skippedCount } = filterMailsForLlm(mails, decisions, THRESHOLDS, "events");
    expect(kept.map((m) => m.source?.uid)).toEqual([7]);
    expect(skippedCount).toBe(7);
  });

  it("trie les mails qualifiés du résumé par urgence décroissante et exclut bruit/injection/custom exclu", () => {
    const { kept, skippedCount } = filterMailsForLlm(mails, decisions, THRESHOLDS, "summary", {
      customCategories: [
        {
          id: "factures",
          name: "Factures",
          description: "Factures et reçus",
          color: "accent",
          excludeFromPriority: true,
          allowNotifications: true,
          cleanupEligible: false,
        },
      ],
    });
    expect(kept.map((m) => m.source?.uid)).toEqual([7, 1]);
    expect(skippedCount).toBe(6);
  });
});

describe("triage · summaryGroupsFromDecisions", () => {
  it("construit actions / infos / notifications instantanément sans LLM", () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3), makeMail(4)];
    const decisions = indexDecisions([
      makeDecision({ uid: 1, messageId: "<m1@example.com>", category: "important", urgency: 2.6, needsReply: 0.9 }),
      makeDecision({ uid: 2, messageId: "<m2@example.com>", category: "info", urgency: 0.9, needsReply: 0.1, hasTask: 0.1, hasEvent: 0.1 }),
      makeDecision({ uid: 3, messageId: "<m3@example.com>", category: "promo", urgency: 0.2 }),
      makeDecision({ uid: 4, messageId: "<m4@example.com>", category: "auth_totp", totpCode: "482917", totpService: "GitHub", urgency: 2.0 }),
    ]);

    const groups = summaryGroupsFromDecisions(mails, decisions, THRESHOLDS);
    expect(groups.actions.map((ref) => ref.mailId)).toEqual(["perso:INBOX:1"]);
    expect(groups.actions[0].reason).toBe("Réponse attendue");
    expect(groups.infos.map((ref) => ref.mailId)).toEqual(["perso:INBOX:2"]);
    expect(groups.notifications.map((ref) => ref.mailId)).toEqual(["perso:INBOX:4", "perso:INBOX:3"]);
    expect(groups.notifications[0].reason).toContain("482917");
  });
});

describe("triage · triageRecentMails (file bornée)", () => {
  it("borne le lot à 40 mails récents non en cache, stocke en IndexedDB, émet stats et E2EE", async () => {
    const db = createMemoryDecisionDb();
    await db.putDecision(makeDecision({ uid: 55, messageId: "<m55@example.com>" }));

    const mails = Array.from({ length: 55 }, (_, i) => makeMail(i + 1));
    const usageEvents: unknown[] = [];
    setDecisionUsageSink((e) => usageEvents.push(e));
    const synced: MailDecision[] = [];

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        targets: { account_id: string; folder_path: string; uid: number }[];
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: payload.targets.map((t) => ({
            decision: toApiDecision(
              makeDecision({
                accountId: t.account_id,
                folderPath: t.folder_path,
                uid: t.uid,
                messageId: `<m${t.uid}@example.com>`,
              }),
            ),
            cached: false,
            usage: { prompt_tokens: 100, completion_tokens: 0 },
            latency_ms: 45,
          })),
          errors: [],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const triaged = await triageRecentMails({
      mails,
      db,
      domain: "api.neuralwatt.com",
      publishSynced: (dec) => synced.push(dec),
    });

    expect(triaged).toHaveLength(MAX_RECENT_TRIAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      targets: { uid: number }[];
    };
    expect(body.targets).toHaveLength(40);
    // uid 55 était déjà en cache, donc les 40 plus récents hors 55 sont 54..15
    expect(body.targets[0].uid).toBe(54);
    expect(body.targets.some((t) => t.uid === 55)).toBe(false);
    expect(usageEvents).toHaveLength(40);
    expect(synced).toHaveLength(40);

    const stored54 = await db.getDecision(decisionMailKey("perso", "INBOX", 54));
    expect(stored54?.category).toBe("important");
  });
});
