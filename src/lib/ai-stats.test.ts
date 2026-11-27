import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_STATS_KEY,
  dayKey,
  endpointHost,
  formatTokens,
  lastDays,
  mergeAiStats,
  readAiStats,
  recordUsage,
  resetAiStats,
  statsFromDoc,
  subscribeAiStats,
  topModels,
} from "@/lib/ai-stats";

const stored = () => JSON.parse(window.localStorage.getItem(AI_STATS_KEY) ?? "null") as unknown;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("recordUsage", () => {
  it("agrège le total, le jour, le modèle et le domaine", () => {
    recordUsage("gpt-4o-mini", "api.exemple.fr", { prompt: 100, completion: 20 });
    recordUsage("gpt-4o-mini", "api.exemple.fr", { prompt: 50, completion: 5 });
    recordUsage("qwen3-coder", "opencode.ai", { prompt: 10, completion: 1 });

    const stats = readAiStats();
    expect(stats.total).toEqual({ prompt: 160, completion: 26, calls: 3 });
    expect(stats.byDay[dayKey()]).toEqual({ prompt: 160, completion: 26, calls: 3 });
    expect(stats.byModel["gpt-4o-mini"]).toEqual({ prompt: 150, completion: 25, calls: 2 });
    expect(stats.byDomain["opencode.ai"]).toEqual({ prompt: 10, completion: 1, calls: 1 });
  });

  it("ignore un modèle ou un domaine vide", () => {
    recordUsage("  ", "", { prompt: 3, completion: 1 });

    const stats = readAiStats();
    expect(stats.total.calls).toBe(1);
    expect(stats.byModel).toEqual({});
    expect(stats.byDomain).toEqual({});
  });

  it("purge les jours de plus de 90 jours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 31, 12, 0, 0));
    recordUsage("gpt", "api.exemple.fr", { prompt: 1, completion: 1 });
    const old = readAiStats();
    const stale = { ...old, byDay: { ...old.byDay, "2025-01-01": { prompt: 9, completion: 9, calls: 9 } } };
    window.localStorage.setItem(AI_STATS_KEY, JSON.stringify(stale));

    recordUsage("gpt", "api.exemple.fr", { prompt: 1, completion: 1 });

    const stats = readAiStats();
    expect(stats.byDay["2025-01-01"]).toBeUndefined();
    expect(stats.byDay["2026-01-31"]).toEqual({ prompt: 2, completion: 2, calls: 2 });
  });

  it("notifie les abonnés et se désabonne", () => {
    const listener = vi.fn();
    const stop = subscribeAiStats(listener);

    recordUsage("gpt", "api.exemple.fr", { prompt: 1, completion: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
    recordUsage("gpt", "api.exemple.fr", { prompt: 1, completion: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ne fait rien en démo lecture seule", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MAIL_BACKEND", "demo");
    vi.stubEnv("VITE_DEMO_READONLY", "1");
    const fresh = await import("@/lib/ai-stats");

    fresh.recordUsage("gpt", "api.exemple.fr", { prompt: 10, completion: 10 });

    expect(window.localStorage.getItem("lavande.ai.stats")).toBeNull();
    expect(fresh.readAiStats().total.calls).toBe(0);
  });
});

describe("resetAiStats", () => {
  it("efface l'agrégat et prévient les abonnés", () => {
    recordUsage("gpt", "api.exemple.fr", { prompt: 10, completion: 2 });
    const listener = vi.fn();
    const stop = subscribeAiStats(listener);

    resetAiStats();

    expect(stored()).toBeNull();
    expect(readAiStats().total.calls).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("readAiStats", () => {
  it("survit à un stockage corrompu", () => {
    window.localStorage.setItem(AI_STATS_KEY, "{pas du json");
    expect(readAiStats().total).toEqual({ prompt: 0, completion: 0, calls: 0 });
  });

  it("normalise les valeurs illisibles", () => {
    window.localStorage.setItem(
      AI_STATS_KEY,
      JSON.stringify({ total: { prompt: "12", completion: -3, calls: 2.4 }, byDay: { "2026-01-01": null } }),
    );

    const stats = readAiStats();
    expect(stats.total).toEqual({ prompt: 0, completion: 0, calls: 2 });
    expect(stats.byDay["2026-01-01"]).toEqual({ prompt: 0, completion: 0, calls: 0 });
  });
});

describe("mergeAiStats", () => {
  it("somme les appareils, jour par jour et modèle par modèle", () => {
    const today = dayKey();
    const decision = { prompt: 0, completion: 0, calls: 0, llmSaved: 0, energyJoules: 0, totalLatencyMs: 0 };
    const first = {
      total: { prompt: 10, completion: 5, calls: 2 },
      byDay: { [today]: { prompt: 10, completion: 5, calls: 2 } },
      byModel: { gpt: { prompt: 10, completion: 5, calls: 2 } },
      byDomain: { "api.exemple.fr": { prompt: 10, completion: 5, calls: 2 } },
      decision,
    };
    const second = {
      total: { prompt: 4, completion: 1, calls: 1 },
      byDay: { [today]: { prompt: 4, completion: 1, calls: 1 } },
      byModel: { gpt: { prompt: 4, completion: 1, calls: 1 } },
      byDomain: { "api.exemple.fr": { prompt: 4, completion: 1, calls: 1 } },
      decision,
    };

    const merged = mergeAiStats([first, second]);

    expect(merged.total).toEqual({ prompt: 14, completion: 6, calls: 3 });
    expect(merged.byDay[today]).toEqual({ prompt: 14, completion: 6, calls: 3 });
    expect(merged.byModel.gpt).toEqual({ prompt: 14, completion: 6, calls: 3 });
    expect(merged.byDomain["api.exemple.fr"]).toEqual({ prompt: 14, completion: 6, calls: 3 });
  });

  it("lit le patch d'un doc ai", () => {
    const stats = statsFromDoc({
      usage: { prompt: 7, completion: 3, calls: 1 },
      byDay: { "2026-02-02": { prompt: 7, completion: 3, calls: 1 } },
      byModel: { "gpt-4o-mini": { prompt: 7, completion: 3, calls: 1 } },
      byDomain: { "api.exemple.fr": { prompt: 7, completion: 3, calls: 1 } },
    });

    expect(stats.total).toEqual({ prompt: 7, completion: 3, calls: 1 });
    expect(stats.byModel["gpt-4o-mini"].calls).toBe(1);
  });
});

describe("formatage", () => {
  it("donne les 7 derniers jours dans l'ordre, jours vides compris", () => {
    const stats = {
      total: { prompt: 0, completion: 0, calls: 0 },
      byDay: { "2026-01-05": { prompt: 1, completion: 1, calls: 1 } },
      byModel: {},
      byDomain: {},
      decision: { prompt: 0, completion: 0, calls: 0, llmSaved: 0, energyJoules: 0, totalLatencyMs: 0 },
    };

    const days = lastDays(stats, 7, new Date(2026, 0, 7, 10, 0, 0));

    expect(days).toHaveLength(7);
    expect(days[0].day).toBe("2026-01-01");
    expect(days[6].day).toBe("2026-01-07");
    expect(days[4].usage.calls).toBe(1);
    expect(days[6].usage.calls).toBe(0);
  });

  it("classe les modèles par appels décroissants", () => {
    const stats = {
      total: { prompt: 0, completion: 0, calls: 0 },
      byDay: {},
      byModel: {
        b: { prompt: 0, completion: 0, calls: 1 },
        a: { prompt: 0, completion: 0, calls: 5 },
      },
      byDomain: {},
      decision: { prompt: 0, completion: 0, calls: 0, llmSaved: 0, energyJoules: 0, totalLatencyMs: 0 },
    };

    expect(topModels(stats).map((entry) => entry.model)).toEqual(["a", "b"]);
  });

  it("extrait l'hôte d'un endpoint et formate les tokens en français", () => {
    expect(endpointHost("https://api.exemple.fr/v1")).toBe("api.exemple.fr");
    expect(endpointHost("  ")).toBe("");
    expect(endpointHost("pas-une-url/v1")).toBe("pas-une-url");
    expect(formatTokens(12345)).toBe(new Intl.NumberFormat("fr-FR").format(12345));
  });
});
