import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { asLlm, PrefsProvider, usePrefs } from "@/lib/prefs";
import { llmChat } from "@/lib/llm";

const response = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const stored = () => JSON.parse(window.localStorage.getItem("lavande.prefs") ?? "{}") as Record<string, unknown>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PrefsProvider, null, children);

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("VITE_MAIL_BACKEND", "demo");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("asLlm", () => {
  it("relit une configuration historique sans fournisseur en custom", () => {
    expect(
      asLlm({ endpoint: "https://opencode.ai/inference/go/openai/v1", apiKey: "sk-test", model: "qwen3-coder" }),
    ).toEqual({
      provider: "custom",
      endpoint: "https://opencode.ai/inference/go/openai/v1",
      apiKey: "sk-test",
      model: "qwen3-coder",
      copilotClientId: "",
    });
  });

  it("ramène un fournisseur inconnu sur custom", () => {
    expect(asLlm({ provider: "mistral", model: "x" }).provider).toBe("custom");
    expect(asLlm({ provider: 42 }).provider).toBe("custom");
    expect(asLlm(null)).toEqual({ provider: "custom", endpoint: "", apiKey: "", model: "", copilotClientId: "" });
  });

  it("conserve les fournisseurs connus et le client_id Copilot", () => {
    expect(asLlm({ provider: "copilot", model: "gpt-4o", copilotClientId: "Iv1.maison" })).toEqual({
      provider: "copilot",
      endpoint: "",
      apiKey: "",
      model: "gpt-4o",
      copilotClientId: "Iv1.maison",
    });
    expect(asLlm({ provider: "openai" }).provider).toBe("openai");
  });
});

describe("usePrefs · fournisseur IA", () => {
  it("garde le fournisseur et le client_id au fil des écritures", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ llm: { provider: "copilot", model: "gpt-4o", copilotClientId: "Iv1.maison" } }),
    );
    const { result } = renderHook(() => usePrefs(), { wrapper });

    expect(result.current.llm).toMatchObject({ provider: "copilot", model: "gpt-4o" });

    act(() => result.current.setLlm({ model: "claude-sonnet-4" }));

    await waitFor(() => expect(stored().llm).toMatchObject({ provider: "copilot", model: "claude-sonnet-4" }));
    expect((stored().llm as { copilotClientId?: string }).copilotClientId).toBe("Iv1.maison");
  });

  it("compte la consommation Copilot sous api.githubcopilot.com", async () => {
    window.localStorage.setItem(
      "lavande.prefs",
      JSON.stringify({ llm: { provider: "copilot", endpoint: "", apiKey: "", model: "gpt-4o" } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      ),
    );
    renderHook(() => usePrefs(), { wrapper });

    await act(async () => {
      await llmChat({ provider: "copilot", endpoint: "", apiKey: "", model: "gpt-4o" }, "s", "u");
    });

    await waitFor(() => {
      const stats = JSON.parse(window.localStorage.getItem("lavande.ai.stats") ?? "{}") as {
        byDomain?: Record<string, { prompt: number }>;
      };
      expect(stats.byDomain?.["api.githubcopilot.com"]?.prompt).toBe(12);
    });
  });
});
