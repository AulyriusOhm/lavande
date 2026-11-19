import { isTauriShell } from "@/lib/open-external";
import { READ_ONLY_NOTICE, demoReadOnly } from "@/lib/mail-backend";
import { ApiError, mailApi } from "@/lib/api";
import { endpointHost } from "@/lib/ai-stats";
import {
  NOT_CONNECTED,
  copilotConnected,
  copilotModels,
  refreshCopilotSession,
} from "@/lib/copilot";

/** `copilot` passe par le démon (jetons côté agent) ; les autres parlent REST en direct. */
export type LlmProvider = "custom" | "openai" | "copilot";

export type LlmConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  provider?: LlmProvider;
  /** Client ID GitHub Copilot propre à l'utilisateur ; vide = celui du démon. */
  copilotClientId?: string;
};

export type LlmUsage = { prompt: number; completion: number };

export const EMPTY_LLM: LlmConfig = {
  endpoint: "",
  apiKey: "",
  model: "",
  provider: "custom",
  copilotClientId: "",
};

export const OPENAI_ENDPOINT = "https://api.openai.com/v1";

/** Fournisseurs proposés dans les réglages, dans l'ordre d'affichage. */
export const LLM_PROVIDERS: { id: LlmProvider; label: string }[] = [
  { id: "custom", label: "Custom" },
  { id: "openai", label: "OpenAI" },
  { id: "copilot", label: "GitHub Copilot" },
];

export const providerOf = (config: { provider?: LlmProvider }): LlmProvider =>
  config.provider ?? "custom";

const PROBE_TIMEOUT = 20_000;

let usageSink: ((usage: LlmUsage) => void) | null = null;

/** Branche la consommation de tokens sur un agrégat (stats locales + synchro). */
export function setUsageSink(sink: ((usage: LlmUsage) => void) | null): void {
  usageSink = sink;
}

function publishUsage(usage: unknown): void {
  if (usageSink === null || typeof usage !== "object" || usage === null) return;
  const raw = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const prompt = typeof raw.prompt_tokens === "number" && raw.prompt_tokens >= 0 ? raw.prompt_tokens : 0;
  const completion =
    typeof raw.completion_tokens === "number" && raw.completion_tokens >= 0 ? raw.completion_tokens : 0;
  if (prompt === 0 && completion === 0) return;
  usageSink({ prompt, completion });
}

/**
 * L'endpoint opencode.ai (`https://opencode.ai/inference/go/openai/v1`) refuse
 * les requêtes sans `x-opencode-session` (MissingSessionID). Les autres
 * endpoints compatibles OpenAI ignorent cet en-tête.
 */
let session: string | null = null;
function opencodeSession(): string {
  session ??= `lavande-${Math.random().toString(36).slice(2, 10)}`;
  return session;
}

export function llmReady(config: LlmConfig | null | undefined): boolean {
  if (!config?.model?.trim()) return false;
  if (providerOf(config) === "copilot") return copilotConnected();
  return Boolean(config.endpoint?.trim() && config.apiKey?.trim());
}

/** Domaine compté dans les stats : Copilot passe par le proxy du démon. */
export function llmDomain(config: LlmConfig): string {
  return providerOf(config) === "copilot" ? "api.githubcopilot.com" : endpointHost(config.endpoint);
}

/**
 * En coquille Tauri, la requête passe par le plugin HTTP (côté Rust) : l'endpoint
 * opencode.ai ne renvoie pas d'en-tête CORS, le fetch du webview échouerait
 * (« Load failed »). Hors Tauri, fetch normal.
 */
async function llmFetch(url: string, init: RequestInit): Promise<Response> {
  if (isTauriShell()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

export async function llmChat(
  config: LlmConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
  if (providerOf(config) === "copilot") {
    const reply = await mailApi
      .aiChat(
        {
          model: config.model.trim(),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.6,
        },
        signal,
      )
      .catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.status === 409) throw new Error(NOT_CONNECTED);
        throw failure;
      });
    publishUsage(reply.usage);
    const content = reply.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Réponse du modèle vide");
    return content.trim();
  }
  const base = config.endpoint.trim().replace(/\/+$/, "");
  const response = await llmFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`,
      "x-opencode-session": opencodeSession(),
    },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.6,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Le modèle a répondu ${response.status}${detail.trim() ? ` · ${detail.trim().slice(0, 200)}` : ""}`,
    );
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: unknown;
  };
  publishUsage(data.usage);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Réponse du modèle vide");
  return content.trim();
}

/** Modèles proposés par l'endpoint (`GET {base}/models`), triés ; la saisie libre reste possible. */
export async function llmModels(
  config: Pick<LlmConfig, "endpoint" | "apiKey" | "provider">,
): Promise<string[]> {
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
  if (providerOf(config) === "copilot") return copilotModels();
  const base = config.endpoint.trim().replace(/\/+$/, "");
  if (base === "") throw new Error("Endpoint du modèle requis pour charger la liste");
  const response = await llmFetch(`${base}/models`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`,
      "x-opencode-session": opencodeSession(),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Liste des modèles indisponible (${response.status})${detail.trim() ? ` · ${detail.trim().slice(0, 200)}` : ""}`,
    );
  }
  const data = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (data === null || !Array.isArray(data.data)) {
    throw new Error("Réponse inattendue de l'endpoint : { data: [{ id }] } attendu");
  }
  const ids = data.data
    .map((entry) =>
      typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id.trim()
        : "",
    )
    .filter((id) => id !== "");
  if (ids.length === 0) throw new Error("Aucun modèle proposé par cet endpoint");
  return [...new Set(ids)].sort();
}

/** Test de connexion depuis les réglages : un aller-retour minimal, borné dans le temps. */
export async function llmProbe(config: LlmConfig): Promise<string> {
  if (providerOf(config) === "copilot") {
    const session = await refreshCopilotSession();
    if (!session.connected) throw new Error(NOT_CONNECTED);
    return session.login ? `Compte GitHub connecté · ${session.login}` : "Compte GitHub connecté";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    return await llmChat(
      config,
      "Tu vérifies une configuration. Réponds uniquement « OK ».",
      "Réponds OK",
      controller.signal,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Délai dépassé : le modèle n'a pas répondu en 20 s");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
