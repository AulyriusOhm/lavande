import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION,
  NEURALWATT_ENDPOINT,
  THRESHOLD_PRESETS,
  applyDecisionProvider,
  decisionCallDirect,
  decisionProbeDirect,
  decisionReady,
  detectThresholdPreset,
  isBlockedFromAutoLlm,
  parseDecisionPayload,
  setDecisionUsageSink,
  withoutSpamCategory,
  type MailDecision,
} from "@/lib/decision";

afterEach(() => {
  setDecisionUsageSink(null);
  vi.unstubAllGlobals();
});

describe("decision (Système 1)", () => {
  it("parse une réponse NeuralWatt avec input_tokens/output_tokens et energy", () => {
    const parsed = parseDecisionPayload(
      {
        model: "mammoth-1",
        answers: {
          urgent: { type: "noul", noul: 0.94 },
          category: {
            type: "choice",
            choice: "important",
            probabilities: { important: 0.93, promo: 0.05, spam: 0.02 },
            confidence: 0.88,
          },
        },
        usage: { input_tokens: 142, output_tokens: 18 },
        energy: {
          energy_joules: 48.25,
          energy_kwh: 0.0000134,
          avg_power_watts: 3600,
          duration_seconds: 0.075,
        },
      },
      "fallback",
      82,
    );

    expect(parsed.model).toBe("mammoth-1");
    expect(parsed.usage).toEqual({ prompt: 142, completion: 18 });
    expect(parsed.answers.urgent.noul).toBe(0.94);
    expect(parsed.answers.category.choice).toBe("important");
    expect(parsed.energy?.energyJoules).toBe(48.25);
  });

  it("parse une réponse Baseten/vLLM avec prompt_tokens/completion_tokens", () => {
    const parsed = parseDecisionPayload(
      {
        model: "decision-models/baseten-mammoth-27b-latest",
        answers: { urgency: { type: "score", score: 2.5 } },
        usage: { prompt_tokens: 90, completion_tokens: 0 },
      },
      "mammoth-1",
      110,
    );
    expect(parsed.usage).toEqual({ prompt: 90, completion: 0 });
    expect(parsed.answers.urgency.score).toBe(2.5);
    expect(parsed.energy).toBeUndefined();
  });

  it("gère les presets de fournisseur (NeuralWatt / Baseten / Jev / Custom)", () => {
    expect(DEFAULT_DECISION.provider).toBe("neuralwatt");
    expect(DEFAULT_DECISION.endpoint).toBe(NEURALWATT_ENDPOINT);
    expect(DEFAULT_DECISION.defaultInboxFilter).toBe("all");

    const baseten = applyDecisionProvider(DEFAULT_DECISION, "baseten");
    expect(baseten.authHeader).toBe("api_key");
    expect(baseten.endpoint).toContain("baseten.co");

    const jev = applyDecisionProvider(DEFAULT_DECISION, "jev");
    expect(jev.protocol).toBe("jev");
    expect(jev.model).toBe("jev-latest");
  });

  it("détecte le profil de seuils actif et bloque pub/spam/totp/injection du LLM auto", () => {
    expect(detectThresholdPreset(THRESHOLD_PRESETS.balanced.values)).toBe("balanced");
    expect(detectThresholdPreset(THRESHOLD_PRESETS.strict.values)).toBe("strict");
    expect(detectThresholdPreset({ ...THRESHOLD_PRESETS.balanced.values, llmEscalate: 0.61 })).toBe("custom");

    const thresholds = THRESHOLD_PRESETS.balanced.values;
    expect(isBlockedFromAutoLlm({ category: "promo", security: "safe", securityConf: 0.99 }, thresholds)).toBe(true);
    expect(isBlockedFromAutoLlm({ category: "auth_totp", security: "safe", securityConf: 0.99 }, thresholds)).toBe(true);
    expect(
      isBlockedFromAutoLlm({ category: "important", security: "prompt_injection", securityConf: 0.85 }, thresholds),
    ).toBe(true);
    expect(
      isBlockedFromAutoLlm({ category: "important", security: "safe", securityConf: 0.99 }, thresholds),
    ).toBe(false);
  });

  it("envoie Authorization: Bearer sur NeuralWatt et publie l'usage séparé", async () => {
    const events: unknown[] = [];
    setDecisionUsageSink((event) => events.push(event));

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "mammoth-1",
        answers: { urgent: { type: "noul", noul: 0.95 } },
        usage: { input_tokens: 40, output_tokens: 0 },
        energy: { energy_joules: 11.2, energy_kwh: 0.000003, avg_power_watts: 3100, duration_seconds: 0.05 },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const cfg = { ...DEFAULT_DECISION, enabled: true, apiKey: "nw-key-123" };
    expect(decisionReady(cfg)).toBe(true);

    const probed = await decisionProbeDirect(cfg);
    expect(probed.ok).toBe(true);
    expect(probed.answer).toBe(0.95);
    expect(events).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(NEURALWATT_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer nw-key-123");

    await decisionCallDirect(cfg, "state", { ok: { type: "noul", instructions: "ok?" } });
    expect(events).toHaveLength(2);
  });
});

describe("decision · catégorisation spam désactivée", () => {
  const spamDecision = (): MailDecision => ({
    accountId: "perso",
    folderPath: "INBOX",
    uid: 7,
    messageId: "<spam@example.com>",
    contentHash: "hash",
    schemaVersion: 1,
    model: "mammoth-1",
    category: "spam",
    categoryConf: 0.95,
    categoryProbs: { spam: 0.95, important: 0.05 },
    urgency: 1.1,
    needsReply: 0.1,
    hasTask: 0,
    hasEvent: 0,
    security: "safe",
    securityConf: 0.97,
    cleanupScore: 0.6,
    decidedAt: 1_731_000_000,
    source: "local",
  });

  it("rapatrie spam en info et renomme la probabilité quand la catégorisation est coupée", () => {
    const decision = spamDecision();
    const neutral = withoutSpamCategory(decision, false);

    expect(neutral.category).toBe("info");
    expect(neutral.categoryProbs).toEqual({ info: 0.95, important: 0.05 });
    expect(decision.category).toBe("spam");
    expect(decision.categoryProbs).toEqual({ spam: 0.95, important: 0.05 });
  });

  it("garde la probabilité info déjà présente", () => {
    const decision = { ...spamDecision(), categoryProbs: { spam: 0.6, info: 0.35 } };
    expect(withoutSpamCategory(decision, false).categoryProbs).toEqual({ info: 0.35 });
  });

  it("rend la même référence quand la catégorisation est active ou la catégorie autre", () => {
    const decision = spamDecision();
    expect(withoutSpamCategory(decision, true)).toBe(decision);

    const promo = { ...spamDecision(), category: "promo" };
    expect(withoutSpamCategory(promo, false)).toBe(promo);
  });
});
