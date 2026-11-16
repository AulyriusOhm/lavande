import { isTauriShell } from "@/lib/open-external";
import { READ_ONLY_NOTICE, demoReadOnly } from "@/lib/mail-backend";

export type LlmConfig = { endpoint: string; apiKey: string; model: string };

export type LlmUsage = { prompt: number; completion: number };

export const EMPTY_LLM: LlmConfig = { endpoint: "", apiKey: "", model: "" };

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
  return Boolean(config?.endpoint?.trim() && config?.apiKey?.trim() && config?.model?.trim());
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
export async function llmModels(config: Pick<LlmConfig, "endpoint" | "apiKey">): Promise<string[]> {
  if (demoReadOnly) throw new Error(READ_ONLY_NOTICE);
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
