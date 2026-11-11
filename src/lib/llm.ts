export type LlmConfig = { endpoint: string; apiKey: string; model: string };

export const EMPTY_LLM: LlmConfig = { endpoint: "", apiKey: "", model: "" };

export function llmReady(config: LlmConfig | null | undefined): boolean {
  return Boolean(config?.endpoint?.trim() && config?.apiKey?.trim() && config?.model?.trim());
}

export async function llmChat(
  config: LlmConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = config.endpoint.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`,
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
  if (!response.ok) throw new Error(`Le modèle a répondu ${response.status}`);
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Réponse du modèle vide");
  return content.trim();
}