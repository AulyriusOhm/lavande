import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUMMARY,
  SUMMARY_CACHE_KEY,
  currentPeriod,
  fallbackSummary,
  generateSummary,
  periodSince,
  readSummaryCache,
  summarySignature,
  writeSummaryCache,
  type SummaryConfig,
  type SummaryMailInput,
  type SummaryResult,
} from "@/lib/summary";
import { EMPTY_LLM } from "@/lib/llm";

const ROLLING: SummaryConfig = { ...DEFAULT_SUMMARY, mode: "rolling", rollingDays: 15 };
const NOW = new Date(2026, 0, 15, 14, 0, 0);
const DAY = 86_400_000;
const at = (daysAgo: number, unread = true, id = String(daysAgo)): SummaryMailInput => ({
  id,
  from: "Camille",
  subject: `Sujet ${id}`,
  snippet: `Aperçu ${id}`,
  timestamp: NOW.getTime() - daysAgo * DAY,
  unread,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("résumé glissant · fenêtre", () => {
  it("nomme la fenêtre en jours depuis la configuration", () => {
    expect(currentPeriod(ROLLING, NOW)).toEqual({ id: "rolling", label: "Non lus · 15 jours" });
    expect(currentPeriod({ ...ROLLING, rollingDays: 1 }, NOW).label).toBe("Non lus · 1 jour");
  });

  it("garde les plages de la journée en mode périodique", () => {
    const morning = currentPeriod(DEFAULT_SUMMARY, new Date(2026, 0, 15, 7, 0, 0));
    expect(morning).toEqual({ id: "morning", label: "Résumé du matin" });
    expect(periodSince(DEFAULT_SUMMARY, new Date(2026, 0, 15, 7, 0, 0)).getTime()).toBe(
      new Date(2026, 0, 15, 7, 0, 0).getTime() - DEFAULT_SUMMARY.lookbackHours * 3_600_000,
    );
  });

  it("remonte de N jours en mode glissant", () => {
    expect(periodSince(ROLLING, NOW).getTime()).toBe(NOW.getTime() - 15 * DAY);
    expect(periodSince({ ...ROLLING, rollingDays: 3 }, NOW).getTime()).toBe(NOW.getTime() - 3 * DAY);
  });
});

describe("résumé glissant · génération", () => {
  const config = { ...ROLLING, enabled: false };

  it("ne résume que les mails non lus de la fenêtre", async () => {
    const mails = [at(1, true, "non-lu"), at(2, false, "lu"), at(20, true, "trop-vieux")];

    const result = await generateSummary(config, EMPTY_LLM, mails, NOW);

    expect(result.period.id).toBe("rolling");
    expect(result.period.label).toBe("Non lus · 15 jours");
    expect(result.mailIds).toEqual(["non-lu"]);
    expect(result.mailCount).toBe(1);
  });

  it("garde les mails lus en mode périodique", async () => {
    const periodic = { ...config, mode: "period" as const, lookbackHours: 24 };
    const mails = [at(0, true, "non-lu"), at(0, false, "lu")];

    const result = await generateSummary(periodic, EMPTY_LLM, mails, NOW);

    expect(result.mailIds.sort()).toEqual(["lu", "non-lu"]);
  });

  it("nomme le repli local et plafonne à 40 mails", async () => {
    const mails = Array.from({ length: 60 }, (_entry, index) => at(1, true, `m${index}`));

    const result = await generateSummary(config, EMPTY_LLM, mails, NOW);

    expect(result.mailCount).toBe(40);
    expect(result.source).toBe("fallback");
  });
});

describe("résumé glissant · cache", () => {
  const result = (overrides: Partial<SummaryResult> = {}): SummaryResult => ({
    ...fallbackSummary([at(1)], { id: "rolling", label: "Non lus · 15 jours" }),
    ...overrides,
  });

  it("accepte une entrée glissante relue depuis le poste", () => {
    const storage = window.localStorage;
    const signature = summarySignature([at(1)], ROLLING);

    writeSummaryCache(storage, "all", "rolling", signature, result());

    expect(readSummaryCache(storage, "all", "rolling", signature)?.period.id).toBe("rolling");
  });

  it("refuse une entrée glissante d'une autre fenêtre", () => {
    const storage = window.localStorage;
    writeSummaryCache(storage, "all", "rolling", summarySignature([at(1)], ROLLING), result());

    const other = { ...ROLLING, rollingDays: 30 };
    expect(readSummaryCache(storage, "all", "rolling", summarySignature([at(1)], other))).toBeNull();
  });

  it("garde le préfixe de cache existant", () => {
    expect(SUMMARY_CACHE_KEY).toBe("lavande.summary.cache.v2");
  });
});

describe("résumé glissant · signature", () => {
  const mails = [at(1)];

  it("ne change rien en mode périodique", () => {
    expect(summarySignature(mails, DEFAULT_SUMMARY)).toBe(summarySignature(mails));
    expect(summarySignature(mails, { ...DEFAULT_SUMMARY, rollingDays: 30 })).toBe(
      summarySignature(mails),
    );
  });

  it("change avec le mode et avec le nombre de jours", () => {
    const rolling = summarySignature(mails, ROLLING);

    expect(rolling).not.toBe(summarySignature(mails));
    expect(rolling).not.toBe(summarySignature(mails, { ...ROLLING, rollingDays: 30 }));
    expect(rolling).toContain(":r15");
  });

  it("change quand un mail devient lu en mode glissant, pas en périodique", () => {
    expect(summarySignature([at(1, true)], ROLLING)).not.toBe(
      summarySignature([at(1, false)], ROLLING),
    );
    expect(summarySignature([at(1, true)], DEFAULT_SUMMARY)).toBe(
      summarySignature([at(1, false)], DEFAULT_SUMMARY),
    );
  });
});
