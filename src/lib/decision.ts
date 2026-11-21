import { isTauriShell } from "@/lib/open-external";
import { READ_ONLY_NOTICE, demoReadOnly } from "@/lib/mail-backend";
import { endpointHost } from "@/lib/ai-stats";

/**
 * Modèle de décision (Système 1) : triage, filtrage, scoring, routage et
 * sécurité en une seule passe avant (SystemOne / Jev).
 *
 * Strictement segmenté du LLM conversationnel (`llm.ts`) : configuration,
 * fournisseur, clé API et statistiques dédiés.
 */

export type DecisionProvider = "neuralwatt" | "baseten" | "jev" | "custom";
export type DecisionProtocol = "systemone" | "jev";
export type DecisionAuthHeader = "bearer" | "api_key" | "none";
export type NotifFilterMode = "all" | "smart" | "urgent_only";
export type ThresholdPresetId = "prudent" | "balanced" | "strict";

export type DecisionThresholds = {
  /** Seuil minimal sur `has_task` / `has_event` pour escalader un mail au LLM Système 2. */
  llmEscalate: number;
  /** Seuil pour afficher les badges/catégories (`needs_reply`, `auth_totp`, catégories custom). */
  category: number;
  /** Seuil du bouclier sécurité (`phishing`, `prompt_injection`). */
  security: number;
  /** Seuil pour proposer un rangement dans un dossier IMAP. */
  folder: number;
};

export type CustomCategory = {
  id: string;
  name: string;
  description: string;
  color: string;
  excludeFromPriority: boolean;
  allowNotifications: boolean;
  cleanupEligible: boolean;
};

export type DecisionConfig = {
  enabled: boolean;
  provider: DecisionProvider;
  protocol: DecisionProtocol;
  endpoint: string;
  model: string;
  authHeader: DecisionAuthHeader;
  /** Clé locale hors démon (web/tests) ; en mode démon, la clé vit dans le trousseau Rust. */
  apiKey: string;
  /** Indique que le démon possède déjà une clé enregistrée dans son trousseau. */
  daemonHasKey?: boolean;
  thresholds: DecisionThresholds;
  customCategories: CustomCategory[];
  /** Vue par défaut à l'ouverture de la boîte : `"all"` par défaut, configurable. */
  defaultInboxFilter: string;
  notifMode: NotifFilterMode;
  preSendGuard: boolean;
  totpPopup: boolean;
};

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer = {
  type: "choice" | "noul" | "score" | string;
  choice?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type DecisionUsage = {
  prompt: number;
  completion: number;
};

export type DecisionEnergy = {
  energyJoules: number;
  energyKwh: number;
  avgPowerWatts: number;
  durationSeconds: number;
};

export type DecisionOutput = {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
  energy?: DecisionEnergy;
  latencyMs: number;
};

export type DecisionProbeResult = {
  ok: true;
  model: string;
  latencyMs: number;
  answer: number;
  usage: DecisionUsage;
  energy?: DecisionEnergy;
};

/** Décision persistée pour un mail (SQLite côté démon + miroir IndexedDB + synchro E2EE). */
export type MailDecision = {
  accountId: string;
  folderPath: string;
  uid: number;
  messageId?: string;
  contentHash: string;
  schemaVersion: number;
  model: string;
  category: string;
  categoryConf: number;
  categoryProbs: Record<string, number>;
  urgency: number;
  needsReply: number;
  hasTask: number;
  hasEvent: number;
  security: "safe" | "phishing" | "prompt_injection" | string;
  securityConf: number;
  cleanupScore: number;
  assignee?: string;
  assigneeConf?: number;
  totpCode?: string;
  totpService?: string;
  suggestedFolder?: string;
  suggestedFolderConf?: number;
  decidedAt: number;
  source: "local" | "synced";
};

export const NEURALWATT_ENDPOINT = "https://api.neuralwatt.com/v1/systemone";
export const BASETEN_ENDPOINT = "https://inference.baseten.co/v1/systemone";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/decide";

export const THRESHOLD_PRESETS: Record<
  ThresholdPresetId,
  { label: string; hint: string; values: DecisionThresholds }
> = {
  prudent: {
    label: "Prudent",
    hint: "Moins d'alertes, escalade plus facilement au LLM",
    values: { llmEscalate: 0.45, category: 0.78, security: 0.88, folder: 0.9 },
  },
  balanced: {
    label: "Équilibré",
    hint: "Bon compromis précision / économie de tokens",
    values: { llmEscalate: 0.55, category: 0.7, security: 0.8, folder: 0.85 },
  },
  strict: {
    label: "Strict",
    hint: "Filtre agressivement le bruit et minimise les appels LLM",
    values: { llmEscalate: 0.68, category: 0.6, security: 0.72, folder: 0.78 },
  },
};

export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = {
  ...THRESHOLD_PRESETS.balanced.values,
};

export const DECISION_PROVIDERS: {
  id: DecisionProvider;
  label: string;
  endpoint: string;
  protocol: DecisionProtocol;
  authHeader: DecisionAuthHeader;
  models: string[];
}[] = [
  {
    id: "neuralwatt",
    label: "NeuralWatt",
    endpoint: NEURALWATT_ENDPOINT,
    protocol: "systemone",
    authHeader: "bearer",
    models: ["mammoth-1", "elephant-1"],
  },
  {
    id: "baseten",
    label: "Baseten",
    endpoint: BASETEN_ENDPOINT,
    protocol: "systemone",
    authHeader: "api_key",
    models: [
      "decision-models/baseten-mammoth-27b-latest",
      "decision-models/baseten-elephant-9b-latest",
    ],
  },
  {
    id: "jev",
    label: "Jev",
    endpoint: JEV_ENDPOINT,
    protocol: "jev",
    authHeader: "bearer",
    models: ["jev-latest", "jev-1.14.0"],
  },
  {
    id: "custom",
    label: "Custom / vLLM",
    endpoint: "",
    protocol: "systemone",
    authHeader: "bearer",
    models: ["baselabs/mammoth-1", "baselabs/elephant-1"],
  },
];

export const DEFAULT_DECISION: DecisionConfig = {
  enabled: false,
  provider: "neuralwatt",
  protocol: "systemone",
  endpoint: NEURALWATT_ENDPOINT,
  model: "mammoth-1",
  authHeader: "bearer",
  apiKey: "",
  daemonHasKey: false,
  thresholds: { ...DEFAULT_DECISION_THRESHOLDS },
  customCategories: [],
  defaultInboxFilter: "all",
  notifMode: "all",
  preSendGuard: true,
  totpPopup: true,
};

export function decisionProviderPreset(provider: DecisionProvider) {
  return DECISION_PROVIDERS.find((entry) => entry.id === provider) ?? DECISION_PROVIDERS[0];
}

export function applyDecisionProvider(
  current: DecisionConfig,
  provider: DecisionProvider,
): DecisionConfig {
  const preset = decisionProviderPreset(provider);
  const keepCustom = provider === "custom";
  return {
    ...current,
    provider,
    protocol: preset.protocol,
    authHeader: preset.authHeader,
    endpoint: keepCustom ? current.endpoint : preset.endpoint,
    model: keepCustom ? current.model : preset.models[0] ?? current.model,
  };
}

export function detectThresholdPreset(thresholds: DecisionThresholds): ThresholdPresetId | "custom" {
  const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
  for (const id of ["prudent", "balanced", "strict"] as const) {
    const v = THRESHOLD_PRESETS[id].values;
    if (
      close(thresholds.llmEscalate, v.llmEscalate) &&
      close(thresholds.category, v.category) &&
      close(thresholds.security, v.security) &&
      close(thresholds.folder, v.folder)
    ) {
      return id;
    }
  }
  return "custom";
}

export function clampThresholds(input: Partial<DecisionThresholds>): DecisionThresholds {
  const clamp = (val: unknown, fallback: number, min: number, max: number) =>
    typeof val === "number" && Number.isFinite(val) ? Math.min(max, Math.max(min, val)) : fallback;
  return {
    llmEscalate: clamp(input.llmEscalate, DEFAULT_DECISION_THRESHOLDS.llmEscalate, 0.1, 0.99),
    category: clamp(input.category, DEFAULT_DECISION_THRESHOLDS.category, 0.1, 0.99),
    security: clamp(input.security, DEFAULT_DECISION_THRESHOLDS.security, 0.3, 0.99),
    folder: clamp(input.folder, DEFAULT_DECISION_THRESHOLDS.folder, 0.3, 0.99),
  };
}

export function decisionReady(config: DecisionConfig | null | undefined): boolean {
  if (!config?.enabled) return false;
  if (!config.endpoint?.trim() || !config.model?.trim()) return false;
  if (config.authHeader === "none") return true;
  return Boolean(config.apiKey?.trim() || config.daemonHasKey);
}

export function decisionDomain(config: Pick<DecisionConfig, "endpoint">): string {
  return endpointHost(config.endpoint);
}

/** Catégories bruyantes qui ne doivent jamais être transmises automatiquement au LLM. */
export const NOISE_CATEGORIES = new Set(["promo", "spam", "auth_totp", "notification"]);

export function isNoiseCategory(category: string): boolean {
  return NOISE_CATEGORIES.has(category);
}

export function isPromptInjection(
  decision: Pick<MailDecision, "security" | "securityConf">,
  thresholds: Pick<DecisionThresholds, "security">,
): boolean {
  return decision.security === "prompt_injection" && decision.securityConf >= thresholds.security;
}

export function isPhishing(
  decision: Pick<MailDecision, "security" | "securityConf">,
  thresholds: Pick<DecisionThresholds, "security">,
): boolean {
  return decision.security === "phishing" && decision.securityConf >= thresholds.security;
}

/**
 * Règle budgétaire & sécurité : un mail classé PUB, spam, TOTP, notification
 * ou prompt_injection n'est jamais envoyé automatiquement au LLM Système 2.
 */
export function isBlockedFromAutoLlm(
  decision: Pick<MailDecision, "category" | "security" | "securityConf">,
  thresholds: Pick<DecisionThresholds, "security">,
): boolean {
  return isNoiseCategory(decision.category) || isPromptInjection(decision, thresholds);
}

export type DecisionUsageEvent = {
  model: string;
  domain: string;
  usage: DecisionUsage;
  latencyMs: number;
  energyJoules?: number;
};

let decisionUsageSink: ((event: DecisionUsageEvent) => void) | null = null;

export function setDecisionUsageSink(sink: ((event: DecisionUsageEvent) => void) | null): void {
  decisionUsageSink = sink;
}

export function emitDecisionUsage(event: DecisionUsageEvent): void {
  if (decisionUsageSink === null) return;
  if (event.usage.prompt === 0 && event.usage.completion === 0 && event.latencyMs === 0) return;
  decisionUsageSink(event);
}

async function decisionFetch(url: string, init: RequestInit): Promise<Response> {
  if (isTauriShell()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

function authHeaderFor(config: Pick<DecisionConfig, "authHeader" | "apiKey">): string | null {
  if (config.authHeader === "none") return null;
  const key = config.apiKey.trim();
  if (!key) return null;
  return config.authHeader === "api_key" ? `Api-Key ${key}` : `Bearer ${key}`;
}

/** Parse indifféremment NeuralWatt (`/v1/systemone`), Baseten/vLLM et Jev (`/v1/decide`). */
export function parseDecisionPayload(
  raw: unknown,
  fallbackModel: string,
  latencyMs: number,
): DecisionOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Réponse du modèle de décision invalide");
  }
  const obj = raw as Record<string, unknown>;
  const model =
    typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : fallbackModel;
  const answersRaw =
    (obj.answers && typeof obj.answers === "object" && !Array.isArray(obj.answers)
      ? (obj.answers as Record<string, unknown>)
      : null) ??
    (obj.decisions && typeof obj.decisions === "object" && !Array.isArray(obj.decisions)
      ? (obj.decisions as Record<string, unknown>)
      : null);
  if (!answersRaw) {
    throw new Error("Réponse inattendue du modèle de décision : champ « answers » absent");
  }

  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, entry] of Object.entries(answersRaw)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      answers[key] = { type: "noul", noul: Math.min(1, Math.max(0, entry)) };
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const probabilities: Record<string, number> = {};
    if (item.probabilities && typeof item.probabilities === "object" && !Array.isArray(item.probabilities)) {
      for (const [label, prob] of Object.entries(item.probabilities as Record<string, unknown>)) {
        if (typeof prob === "number" && Number.isFinite(prob)) {
          probabilities[label] = Math.min(1, Math.max(0, prob));
        }
      }
    }
    const kind =
      typeof item.type === "string"
        ? item.type
        : typeof item.choice === "string"
          ? "choice"
          : typeof item.score === "number"
            ? "score"
            : "noul";
    const parsed: DecisionAnswer = { type: kind };
    if (typeof item.choice === "string") parsed.choice = item.choice;
    else if (typeof item.value === "string") parsed.choice = item.value;
    if (typeof item.noul === "number" && Number.isFinite(item.noul)) {
      parsed.noul = Math.min(1, Math.max(0, item.noul));
    } else if (typeof item.probability === "number" && Number.isFinite(item.probability)) {
      parsed.noul = Math.min(1, Math.max(0, item.probability));
    }
    if (typeof item.score === "number" && Number.isFinite(item.score)) parsed.score = item.score;
    if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
      parsed.confidence = Math.min(1, Math.max(0, item.confidence));
    }
    if (Object.keys(probabilities).length > 0) parsed.probabilities = probabilities;
    answers[key] = parsed;
  }

  const usageRaw =
    obj.usage && typeof obj.usage === "object" ? (obj.usage as Record<string, unknown>) : null;
  const prompt =
    typeof usageRaw?.prompt_tokens === "number"
      ? usageRaw.prompt_tokens
      : typeof usageRaw?.input_tokens === "number"
        ? usageRaw.input_tokens
        : 0;
  const completion =
    typeof usageRaw?.completion_tokens === "number"
      ? usageRaw.completion_tokens
      : typeof usageRaw?.output_tokens === "number"
        ? usageRaw.output_tokens
        : 0;

  let energy: DecisionEnergy | undefined;
  if (obj.energy && typeof obj.energy === "object" && !Array.isArray(obj.energy)) {
    const e = obj.energy as Record<string, unknown>;
    if (typeof e.energy_joules === "number" || typeof e.duration_seconds === "number") {
      energy = {
        energyJoules: typeof e.energy_joules === "number" ? e.energy_joules : 0,
        energyKwh: typeof e.energy_kwh === "number" ? e.energy_kwh : 0,
        avgPowerWatts: typeof e.avg_power_watts === "number" ? e.avg_power_watts : 0,
        durationSeconds: typeof e.duration_seconds === "number" ? e.duration_seconds : 0,
      };
    }
  }

  return {
    model,
    answers,
    usage: { prompt: Math.max(0, Math.round(prompt)), completion: Math.max(0, Math.round(completion)) },
    ...(energy ? { energy } : {}),
    latencyMs,
  };
}

/** Appel direct vers l'endpoint du modèle de décision (hors démon / tests / mode web). */
export async function decisionCallDirect(
  config: DecisionConfig,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  signal?: AbortSignal,
): Promise<DecisionOutput> {
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
  const endpoint = config.endpoint.trim();
  const model = config.model.trim();
  if (!endpoint || !model) throw new Error("Endpoint et modèle de décision requis");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const auth = authHeaderFor(config);
  if (auth) headers.authorization = auth;

  const started = Date.now();
  const response = await decisionFetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, state, questions }),
    signal,
  });
  const latencyMs = Math.max(0, Date.now() - started);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Le modèle de décision a répondu ${response.status}${detail.trim() ? ` · ${detail.trim().slice(0, 200)}` : ""}`,
    );
  }

  const raw = await response.json();
  const output = parseDecisionPayload(raw, model, latencyMs);
  emitDecisionUsage({
    model: output.model,
    domain: decisionDomain(config),
    usage: output.usage,
    latencyMs: output.latencyMs,
    energyJoules: output.energy?.energyJoules,
  });
  return output;
}

const PROBE_TIMEOUT_MS = 15_000;

export async function decisionProbeDirect(config: DecisionConfig): Promise<DecisionProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const output = await decisionCallDirect(
      config,
      "Checkout has been failing for every customer for the last hour.",
      {
        urgent: {
          type: "noul",
          instructions: "Is this an urgent production outage?",
        },
      },
      controller.signal,
    );
    return {
      ok: true,
      model: output.model,
      latencyMs: output.latencyMs,
      answer: output.answers.urgent?.noul ?? 0,
      usage: output.usage,
      ...(output.energy ? { energy: output.energy } : {}),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Délai dépassé : le modèle de décision n'a pas répondu en 15 s");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
