import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION,
  THRESHOLD_PRESETS,
  setDecisionUsageSink,
  type DecisionConfig,
  type MailDecision,
} from "@/lib/decision";
import { createMemoryDecisionDb, decisionMailKey } from "@/lib/decision-db";
import { buildDemoDecisions } from "@/lib/demo-decisions";
import type { Mail } from "@/lib/mail";
import {
  MAX_RECENT_TRIAGE,
  applyTrustRules,
  eventDraftFromMail,
  extractAuthLink,
  filterMailsForLlm,
  fromApiDecision,
  indexDecisions,
  isTrustedSender,
  reasonFromDecision,
  stableDecisionKey,
  summaryGroupsFromDecisions,
  taskDraftFromMail,
  toApiDecision,
  toApiDecisionConfig,
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
      description: "Camille valide la v3 et attend ton retour.",
      source: "synced",
    });

    const api = toApiDecision(dec);
    expect(api.account_id).toBe("perso");
    expect(api.totp_code).toBe("482917");
    expect(api.suggested_folder).toBe("Factures");
    expect(api.description).toBe("Camille valide la v3 et attend ton retour.");
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

  it("indexDecisions retrouve chaque décision d'un Record par sa clé (y compris uid === 0 et démo)", () => {
    const record: Record<string, MailDecision> = {
      "1": makeDecision({ uid: 0, accountId: "perso", category: "important", messageId: undefined }),
      "demo-totp-live": makeDecision({
        uid: 0,
        accountId: "perso",
        category: "auth_totp",
        totpCode: "482917",
        totpService: "GitHub",
        messageId: undefined,
      }),
      "demo-phish-1": makeDecision({
        uid: 0,
        accountId: "perso",
        category: "important",
        security: "phishing",
        securityConf: 0.96,
        messageId: undefined,
      }),
    };
    const idx = indexDecisions(record);

    expect(triageDecisionFor({ id: "1" }, idx.byKey, idx.byMessageId)?.category).toBe("important");
    expect(triageDecisionFor({ id: "demo-totp-live" }, idx.byKey, idx.byMessageId)?.totpCode).toBe("482917");
    expect(triageDecisionFor({ id: "demo-phish-1" }, idx.byKey, idx.byMessageId)?.security).toBe("phishing");

    const demoIdx = indexDecisions(buildDemoDecisions());
    expect(triageDecisionFor({ id: "demo-totp-live" }, demoIdx.byKey, demoIdx.byMessageId)?.totpCode).toBe("482917");
    expect(triageDecisionFor({ id: "demo-phish-1" }, demoIdx.byKey, demoIdx.byMessageId)?.security).toBe("phishing");
    expect(triageDecisionFor({ id: "8" }, demoIdx.byKey, demoIdx.byMessageId)?.suggestedFolder).toBe("Factures");
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
    expect(groups.actions[0].reason).toBe("Urgent · Réponse attendue · Tâche détectée");
    expect(groups.infos.map((ref) => ref.mailId)).toEqual(["perso:INBOX:2"]);
    expect(groups.notifications.map((ref) => ref.mailId)).toEqual(["perso:INBOX:4", "perso:INBOX:3"]);
    expect(groups.notifications[0].reason).toContain("482917");
  });

  it("met les TOTP récents (< 24 h) tout en premier, puis les suspects, puis les importantes, et les vieux TOTP en notifications", () => {
    const now = Date.now();
    const HOUR = 3_600_000;
    const mails = [
      makeMail(1, { timestamp: now - HOUR }),
      makeMail(2, { timestamp: now - 2 * HOUR }),
      makeMail(3, { timestamp: now - 30 * HOUR }),
      makeMail(4, { timestamp: now - 3 * HOUR }),
      makeMail(5, {
        timestamp: now - HOUR,
        body: ["Cliquez sur https://app.example.com/verify?token=xyz pour activer votre compte."],
        preview: "Lien de vérification https://app.example.com/verify?token=xyz",
      }),
    ];
    const decisions = indexDecisions([
      makeDecision({ uid: 1, messageId: "<m1@example.com>", category: "important", urgency: 2.8, needsReply: 0.9 }),
      makeDecision({ uid: 2, messageId: "<m2@example.com>", category: "auth_totp", totpCode: "482917", totpService: "GitHub", urgency: 0.5 }),
      makeDecision({ uid: 3, messageId: "<m3@example.com>", category: "auth_totp", totpCode: "901442", totpService: "Stripe", urgency: 0.3 }),
      makeDecision({ uid: 4, messageId: "<m4@example.com>", category: "spam", security: "phishing", securityConf: 0.96, urgency: 0.2 }),
      makeDecision({ uid: 5, messageId: "<m5@example.com>", category: "auth_totp", totpService: "Linear", urgency: 0.4 }),
    ]);

    const groups = summaryGroupsFromDecisions(mails, decisions, THRESHOLDS, { now });
    expect(groups.actions.map((ref) => ref.mailId)).toEqual([
      "perso:INBOX:2",
      "perso:INBOX:5",
      "perso:INBOX:4",
      "perso:INBOX:1",
    ]);
    expect(groups.actions[2].reason).toContain("Hameçonnage détecté");
    expect(groups.notifications.map((ref) => ref.mailId)).toEqual(["perso:INBOX:3"]);
  });

  it("génère des raisons courtes combinées via reasonFromDecision (au plus 3 signaux)", () => {
    expect(
      reasonFromDecision(
        makeDecision({ urgency: 2.4, needsReply: 0.9, hasTask: 0.1, hasEvent: 0.1 }),
        THRESHOLDS,
      ),
    ).toBe("Urgent · Réponse attendue");

    expect(
      reasonFromDecision(
        makeDecision({ urgency: 1.0, needsReply: 0.1, hasTask: 0.1, hasEvent: 0.85 }),
        THRESHOLDS,
      ),
    ).toBe("Rendez-vous proposé");

    expect(
      reasonFromDecision(
        makeDecision({
          urgency: 1.2,
          needsReply: 0.1,
          hasTask: 0.8,
          hasEvent: 0.1,
          assignee: "Camille",
        }),
        THRESHOLDS,
      ),
    ).toBe("Tâche détectée · Assigné à Camille");

    expect(
      reasonFromDecision(
        makeDecision({
          urgency: 1.0,
          needsReply: 0.1,
          hasTask: 0.1,
          hasEvent: 0.1,
          assignee: "moi",
        }),
        THRESHOLDS,
      ),
    ).toBe("Message prioritaire");
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

  const targetsOf = (fetchMock: ReturnType<typeof vi.fn>) =>
    (
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
        targets: { uid: number }[];
      }
    ).targets;

  it("suit une limite explicite au-delà de 40 mails", async () => {
    const db = createMemoryDecisionDb();
    const mails = Array.from({ length: 150 }, (_, i) => makeMail(i + 1));
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
          })),
          errors: [],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const triaged = await triageRecentMails({ mails, db, limit: 120 });

    expect(triaged).toHaveLength(120);
    expect(targetsOf(fetchMock)).toHaveLength(120);
  });

  it("borne la limite à 200 mails au plus", async () => {
    const db = createMemoryDecisionDb();
    const mails = Array.from({ length: 250 }, (_, i) => makeMail(i + 1));
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
          })),
          errors: [],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const triaged = await triageRecentMails({ mails, db, limit: 999 });

    expect(triaged).toHaveLength(200);
    expect(targetsOf(fetchMock)).toHaveLength(200);
  });

  it("annonce une fois les clés envoyées au modèle, avant l'appel réseau", async () => {
    const db = createMemoryDecisionDb();
    const mails = Array.from({ length: 5 }, (_, i) => makeMail(i + 1));
    const seen: string[][] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(seen).toHaveLength(1);
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
          })),
          errors: [],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const triaged = await triageRecentMails({
      mails,
      db,
      limit: 3,
      onPendingKeys: (keys) => seen.push(keys),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      decisionMailKey("perso", "INBOX", 5),
      decisionMailKey("perso", "INBOX", 4),
      decisionMailKey("perso", "INBOX", 3),
    ]);
    expect(triaged).toHaveLength(3);
  });

  it("n'annonce aucune clé quand tout est déjà décidé", async () => {
    const db = createMemoryDecisionDb();
    const mails = [makeMail(1)];
    await db.putDecision(makeDecision({ uid: 1, messageId: "<m1@example.com>" }));
    const seen: string[][] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const triaged = await triageRecentMails({ mails, db, onPendingKeys: (keys) => seen.push(keys) });

    expect(triaged).toEqual([]);
    expect(seen).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ramène une limite nulle ou négative à un seul mail", async () => {
    for (const limit of [0, -5]) {
      const db = createMemoryDecisionDb();
      const mails = Array.from({ length: 5 }, (_, i) => makeMail(i + 1));
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
            })),
            errors: [],
          }),
        } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const triaged = await triageRecentMails({ mails, db, limit });

      expect(triaged).toHaveLength(1);
      expect(targetsOf(fetchMock)).toHaveLength(1);
    }
  });
});

describe("triage · extractAuthLink, whitelist de confiance et drafts", () => {
  it("extrait le lien de vérification HTTPS en excluant unsubscribe", () => {
    const body = [
      "Pour vous désabonner : https://example.com/unsubscribe?id=1",
      "Confirmez votre compte : https://auth.service.fr/verify?token=abc123.",
    ].join("\n");
    expect(extractAuthLink(body)).toBe("https://auth.service.fr/verify?token=abc123");
    expect(extractAuthLink("https://example.com/unsubscribe")).toBeNull();
  });

  it("applique la whitelist expéditeurs et domaines sans appel API", () => {
    expect(isTrustedSender("Alertes@Banque.FR", ["alertes@banque.fr"], [])).toBe(true);
    expect(isTrustedSender("conseiller@boursorama.fr", [], ["boursorama.fr"])).toBe(true);
    expect(isTrustedSender("evil@phish.xyz", ["alertes@banque.fr"], ["boursorama.fr"])).toBe(false);

    const phish = makeDecision({
      category: "spam",
      security: "phishing",
      securityConf: 0.95,
    });
    const cleared = applyTrustRules(phish, "alertes@banque.fr", {
      trustedSenders: ["alertes@banque.fr"],
      trustedDomains: [],
    });
    expect(cleared.security).toBe("safe");
    expect(cleared.securityConf).toBe(1);
    expect(cleared.category).toBe("important");

    const infoCleared = applyTrustRules(
      makeDecision({ category: "info", security: "prompt_injection", securityConf: 0.92 }),
      "bot@boursorama.fr",
      { trustedSenders: [], trustedDomains: ["boursorama.fr"] },
    );
    expect(infoCleared.security).toBe("safe");
    expect(infoCleared.category).toBe("info");
  });

  it("construit NewTaskDraft et EventDraft pré-remplis depuis un mail", () => {
    const mail = makeMail(10, {
      name: "Camille",
      subject: "Devis signé",
      preview: "Peux-tu envoyer la facture ?",
    });
    const dec = makeDecision({ assignee: "Marc" });
    expect(taskDraftFromMail(mail, { reason: "Facturer le client", due: "2026-11-25" }, dec)).toEqual({
      title: "Devis signé",
      description: "Facturer le client\n\nPeux-tu envoyer la facture ?",
      dueDate: "2026-11-25",
      assignee: "Marc",
      mailId: mail.id,
      mailFrom: "Camille",
      mailSubject: "Devis signé",
    });
    expect(eventDraftFromMail(mail, { reason: "Point", due: "2026-11-25" })).toEqual({
      title: "Devis signé",
      date: "2026-11-25",
      mailId: mail.id,
      mailFrom: "Camille",
      mailSubject: "Devis signé",
    });
  });
});

describe("triage · configuration de décision envoyée au démon", () => {
  const config = (overrides: Partial<DecisionConfig> = {}): DecisionConfig => ({
    ...DEFAULT_DECISION,
    ...overrides,
  });

  it("envoie description_model tel quel, espaces retirés", () => {
    expect(toApiDecisionConfig(config()).description_model).toBe("nw-flash");
    expect(
      toApiDecisionConfig(config({ descriptionModel: "  my-chat-model  " })).description_model,
    ).toBe("my-chat-model");
    expect(toApiDecisionConfig(config({ descriptionModel: "" })).description_model).toBe("");
  });

  it("envoie la source de description", () => {
    expect(toApiDecisionConfig(config()).description_source).toBe("decision");
    expect(
      toApiDecisionConfig(config({ descriptionSource: "llm", descriptionModel: "" }))
        .description_source,
    ).toBe("llm");
  });

  it("garde les autres champs du contrat intacts", () => {
    const api = toApiDecisionConfig(
      config({ provider: "baseten", descriptionModel: "my-chat-model", recentMailCount: 120 }),
    );

    expect(api.provider).toBe("baseten");
    expect(api.endpoint).toBe(DEFAULT_DECISION.endpoint);
    expect(api.recent_mail_count).toBe(120);
    expect(api.description_model).toBe("my-chat-model");
    expect(api).not.toHaveProperty("api_key");
    expect(toApiDecisionConfig(config(), { apiKey: "nw-key" }).api_key).toBe("nw-key");
  });
});
