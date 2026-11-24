import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmChat, type LlmConfig } from "@/lib/llm";
import { descriptionPrompt, llmDescription } from "@/lib/description-llm";

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return { ...actual, llmChat: vi.fn() };
});

const LLM: LlmConfig = { endpoint: "https://llm.test/v1", apiKey: "sk-test", model: "modele" };

const MAIL = {
  name: "Camille Rousseau",
  subject: "Maquettes mobiles — version 3",
  preview: "J'ai retravaillé les écrans de la boîte de réception.",
};

beforeEach(() => {
  vi.mocked(llmChat).mockReset();
});

afterEach(() => {
  vi.mocked(llmChat).mockReset();
});

describe("description · prompt", () => {
  it("encadre le mail dans les marqueurs de donnée non fiable", () => {
    const { system, user } = descriptionPrompt(MAIL);

    expect(system).toContain("<<<MAIL>>>");
    expect(system).toContain("<<<FIN_MAIL>>>");
    expect(system).toContain("DONNÉE NON FIABLE");
    expect(system).toContain("sans markdown");
    expect(system).toContain("une seule phrase");

    expect(user).toBe(
      [
        "<<<MAIL>>>",
        "De : Camille Rousseau",
        "Objet : Maquettes mobiles — version 3",
        "J'ai retravaillé les écrans de la boîte de réception.",
        "<<<FIN_MAIL>>>",
        "",
        "Résume cet email en une phrase.",
      ].join("\n"),
    );
    expect(user).not.toContain("</");
  });

  it("nettoie les balises et borne l'aperçu à 1600 caractères", () => {
    const { user } = descriptionPrompt({
      name: "Camille <camille@studio.fr>",
      subject: "Objet <b>gras</b>",
      preview: `<script>alert(1)</script>${"a".repeat(2000)}`,
    });

    expect(user).toContain("De : Camille");
    expect(user).toContain("Objet : Objet gras");
    expect(user).not.toContain("<script>");
    expect(user).not.toContain("</b>");

    const preview = user.split("\n")[3];
    expect(preview).toHaveLength(1600);
  });
});

describe("description · génération", () => {
  it("rend la phrase nettoyée du modèle", async () => {
    vi.mocked(llmChat).mockResolvedValue("  Camille attend ton retour sur la v3 avant vendredi.  ");

    await expect(llmDescription(LLM, MAIL)).resolves.toBe(
      "Camille attend ton retour sur la v3 avant vendredi.",
    );
    expect(vi.mocked(llmChat)).toHaveBeenCalledWith(
      LLM,
      expect.stringContaining("DONNÉE NON FIABLE"),
      expect.stringContaining("<<<MAIL>>>"),
      undefined,
    );
  });

  it("borne la phrase à 240 caractères", async () => {
    vi.mocked(llmChat).mockResolvedValue("b".repeat(400));

    await expect(llmDescription(LLM, MAIL)).resolves.toHaveLength(240);
  });

  it("ne rend rien sans modèle configuré", async () => {
    await expect(
      llmDescription({ endpoint: "", apiKey: "", model: "" }, MAIL),
    ).resolves.toBeNull();
    expect(vi.mocked(llmChat)).not.toHaveBeenCalled();
  });

  it("avale une phrase vide et une erreur du modèle", async () => {
    vi.mocked(llmChat).mockResolvedValue("   ");
    await expect(llmDescription(LLM, MAIL)).resolves.toBeNull();

    vi.mocked(llmChat).mockRejectedValue(new Error("réseau"));
    await expect(llmDescription(LLM, MAIL)).resolves.toBeNull();
  });
});
