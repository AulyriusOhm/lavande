import type { LlmUsage } from "@/lib/llm";
import { demoReadOnly } from "@/lib/mail-backend";

export const AI_STATS_KEY = "lavande.ai.stats";
export const AI_STATS_RETENTION_DAYS = 90;

export type AiUsage = { prompt: number; completion: number; calls: number };

/** Métriques dédiées au modèle de décision (Système 1), séparées du LLM. */
export type DecisionAiUsage = {
  prompt: number;
  completion: number;
  calls: number;
  /** Nombre d'appels LLM Système 2 évités grâce au filtrage du modèle de décision. */
  llmSaved: number;
  /** Énergie cumulée en joules (renvoyée par NeuralWatt). */
  energyJoules: number;
  /** Somme des latences en ms (pour calculer la moyenne). */
  totalLatencyMs: number;
};

export type AiStats = {
  total: AiUsage;
  byDay: Record<string, AiUsage>;
  byModel: Record<string, AiUsage>;
  byDomain: Record<string, AiUsage>;
  decision: DecisionAiUsage;
};

const EMPTY_USAGE: AiUsage = { prompt: 0, completion: 0, calls: 0 };
const EMPTY_DECISION_USAGE: DecisionAiUsage = {
  prompt: 0,
  completion: 0,
  calls: 0,
  llmSaved: 0,
  energyJoules: 0,
  totalLatencyMs: 0,
};

const listeners = new Set<() => void>();

export function emptyUsage(): AiUsage {
  return { ...EMPTY_USAGE };
}

export function emptyDecisionUsage(): DecisionAiUsage {
  return { ...EMPTY_DECISION_USAGE };
}

export function emptyAiStats(): AiStats {
  return {
    total: emptyUsage(),
    byDay: {},
    byModel: {},
    byDomain: {},
    decision: emptyDecisionUsage(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function float(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readUsage(value: unknown): AiUsage {
  if (!isRecord(value)) return emptyUsage();
  return { prompt: count(value.prompt), completion: count(value.completion), calls: count(value.calls) };
}

function readDecisionUsage(value: unknown): DecisionAiUsage {
  if (!isRecord(value)) return emptyDecisionUsage();
  return {
    prompt: count(value.prompt),
    completion: count(value.completion),
    calls: count(value.calls),
    llmSaved: count(value.llmSaved),
    energyJoules: float(value.energyJoules),
    totalLatencyMs: count(value.totalLatencyMs),
  };
}

function readBucket(value: unknown): Record<string, AiUsage> {
  if (!isRecord(value)) return {};
  const bucket: Record<string, AiUsage> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "") continue;
    bucket[key] = readUsage(entry);
  }
  return bucket;
}

function normalize(value: unknown): AiStats {
  if (!isRecord(value)) return emptyAiStats();
  return {
    total: readUsage(value.total),
    byDay: readBucket(value.byDay),
    byModel: readBucket(value.byModel),
    byDomain: readBucket(value.byDomain),
    decision: readDecisionUsage(value.decision),
  };
}

/** Jour local au format `YYYY-MM-DD`. */
export function dayKey(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function cutoffDay(days = AI_STATS_RETENTION_DAYS, now = new Date()): string {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return dayKey(cutoff);
}

function purge(byDay: Record<string, AiUsage>, now = new Date()): Record<string, AiUsage> {
  const cutoff = cutoffDay(AI_STATS_RETENTION_DAYS, now);
  const kept: Record<string, AiUsage> = {};
  for (const [day, usage] of Object.entries(byDay)) {
    if (day >= cutoff) kept[day] = usage;
  }
  return kept;
}

/** Hôte d'un endpoint LLM : la clé API, elle, n'est jamais conservée ni synchronisée. */
export function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed === "") return "";
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  }
}

export function readAiStats(): AiStats {
  try {
    const raw = window.localStorage.getItem(AI_STATS_KEY);
    if (raw === null) return emptyAiStats();
    return normalize(JSON.parse(raw));
  } catch {
    return emptyAiStats();
  }
}

function write(stats: AiStats): void {
  try {
    window.localStorage.setItem(AI_STATS_KEY, JSON.stringify(stats));
  } catch {
    // quota dépassé : les stats restent celles du dernier écrit réussi
  }
}

function add(target: Record<string, AiUsage>, key: string, delta: AiUsage): void {
  const current = target[key] ?? emptyUsage();
  target[key] = {
    prompt: current.prompt + delta.prompt,
    completion: current.completion + delta.completion,
    calls: current.calls + delta.calls,
  };
}

export function recordUsage(model: string, domain: string, usage: LlmUsage): void {
  if (demoReadOnly) return;
  const stats = readAiStats();
  const delta: AiUsage = { prompt: usage.prompt, completion: usage.completion, calls: 1 };
  const total = {
    prompt: stats.total.prompt + delta.prompt,
    completion: stats.total.completion + delta.completion,
    calls: stats.total.calls + delta.calls,
  };
  const byDay = purge(stats.byDay);
  add(byDay, dayKey(), delta);
  const byModel = { ...stats.byModel };
  if (model.trim() !== "") add(byModel, model.trim(), delta);
  const byDomain = { ...stats.byDomain };
  if (domain.trim() !== "") add(byDomain, domain.trim(), delta);
  write({ total, byDay, byModel, byDomain, decision: stats.decision });
  notify();
}

export function recordDecisionUsage(
  model: string,
  domain: string,
  usage: LlmUsage,
  meta: { latencyMs?: number; energyJoules?: number } = {},
): void {
  if (demoReadOnly) return;
  const stats = readAiStats();
  const delta: AiUsage = { prompt: usage.prompt, completion: usage.completion, calls: 1 };
  const byDay = purge(stats.byDay);
  add(byDay, dayKey(), delta);
  const byModel = { ...stats.byModel };
  if (model.trim() !== "") add(byModel, `decision:${model.trim()}`, delta);
  const byDomain = { ...stats.byDomain };
  if (domain.trim() !== "") add(byDomain, domain.trim(), delta);
  const decision: DecisionAiUsage = {
    prompt: stats.decision.prompt + usage.prompt,
    completion: stats.decision.completion + usage.completion,
    calls: stats.decision.calls + 1,
    llmSaved: stats.decision.llmSaved,
    energyJoules: stats.decision.energyJoules + float(meta.energyJoules),
    totalLatencyMs: stats.decision.totalLatencyMs + count(meta.latencyMs),
  };
  write({ total: stats.total, byDay, byModel, byDomain, decision });
  notify();
}

export function recordLlmSaved(savedCount: number): void {
  if (demoReadOnly || savedCount <= 0) return;
  const stats = readAiStats();
  const decision: DecisionAiUsage = {
    ...stats.decision,
    llmSaved: stats.decision.llmSaved + Math.round(savedCount),
  };
  write({ ...stats, decision });
  notify();
}

export function resetAiStats(): void {
  if (demoReadOnly) return;
  try {
    window.localStorage.removeItem(AI_STATS_KEY);
  } catch {
    // rien à effacer
  }
  notify();
}

export function subscribeAiStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Somme des stats de plusieurs appareils (docs `ai` reçus + valeurs locales). */
export function mergeAiStats(entries: readonly AiStats[]): AiStats {
  const merged = emptyAiStats();
  for (const entry of entries) {
    merged.total = {
      prompt: merged.total.prompt + entry.total.prompt,
      completion: merged.total.completion + entry.total.completion,
      calls: merged.total.calls + entry.total.calls,
    };
    const dec = entry.decision ?? EMPTY_DECISION_USAGE;
    merged.decision = {
      prompt: merged.decision.prompt + dec.prompt,
      completion: merged.decision.completion + dec.completion,
      calls: merged.decision.calls + dec.calls,
      llmSaved: merged.decision.llmSaved + dec.llmSaved,
      energyJoules: merged.decision.energyJoules + dec.energyJoules,
      totalLatencyMs: merged.decision.totalLatencyMs + dec.totalLatencyMs,
    };
    for (const [day, usage] of Object.entries(entry.byDay)) add(merged.byDay, day, usage);
    for (const [model, usage] of Object.entries(entry.byModel)) add(merged.byModel, model, usage);
    for (const [domain, usage] of Object.entries(entry.byDomain)) add(merged.byDomain, domain, usage);
  }
  return {
    total: merged.total,
    byDay: purge(merged.byDay),
    byModel: merged.byModel,
    byDomain: merged.byDomain,
    decision: merged.decision,
  };
}

/** Stats portées par un doc `ai` (patch `{usage, byDay, byModel, byDomain, decision}`). */
export function statsFromDoc(raw: Record<string, unknown>): AiStats {
  return normalize({
    total: raw.usage,
    byDay: raw.byDay,
    byModel: raw.byModel,
    byDomain: raw.byDomain,
    decision: raw.decision,
  });
}

/** Les `n` derniers jours, du plus ancien au plus récent (jours sans appel à zéro). */
export function lastDays(stats: AiStats, days = 7, now = new Date()): { day: string; usage: AiUsage }[] {
  const entries: { day: string; usage: AiUsage }[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const day = dayKey(date);
    entries.push({ day, usage: stats.byDay[day] ?? emptyUsage() });
  }
  return entries;
}

/** Modèles triés par consommation décroissante. */
export function topModels(stats: AiStats, limit = 3): { model: string; usage: AiUsage }[] {
  return Object.entries(stats.byModel)
    .map(([model, usage]) => ({ model, usage }))
    .sort((a, b) => b.usage.calls - a.usage.calls || a.model.localeCompare(b.model))
    .slice(0, limit);
}

const NUMBER = new Intl.NumberFormat("fr-FR");

export function formatTokens(value: number): string {
  return NUMBER.format(Math.round(value));
}
