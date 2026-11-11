import { describe, expect, it } from "vitest";
import {
  ensureHtml,
  htmlToText,
  isHtmlEmpty,
  looksLikeHtml,
  looksLikeMarkdown,
  markdownToHtml,
  textToHtml,
} from "@/lib/rich-text";

describe("textToHtml", () => {
  it("enveloppe les paragraphes et échappe le HTML", () => {
    expect(textToHtml("Bonjour\n\nÀ <toi> & moi")).toBe(
      "<p>Bonjour</p><p>À &lt;toi&gt; &amp; moi</p>",
    );
  });

  it("convertit les sauts de ligne simples en <br>", () => {
    expect(textToHtml("ligne 1\nligne 2")).toBe("<p>ligne 1<br>ligne 2</p>");
  });

  it("renvoie une chaîne vide pour un texte vide", () => {
    expect(textToHtml("   \n  ")).toBe("");
  });
});

describe("htmlToText", () => {
  it("extrait le texte des paragraphes avec des sauts de ligne", () => {
    expect(htmlToText("<p>Bonjour</p><p>le monde</p>")).toBe("Bonjour\nle monde");
  });

  it("décode les entités et retire les balises", () => {
    expect(htmlToText("<p>À &lt;toi&gt; &amp; moi</p>")).toBe("À <toi> & moi");
  });

  it("gère <br> et les titres", () => {
    expect(htmlToText("<h2>Titre</h2><p>a<br>b</p>")).toBe("Titre\na\nb");
  });

  it("renvoie vide pour une entrée vide", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<p></p>")).toBe("");
  });
});

describe("isHtmlEmpty", () => {
  it("détecte un éditeur vide", () => {
    expect(isHtmlEmpty("")).toBe(true);
    expect(isHtmlEmpty("<p></p>")).toBe(true);
    expect(isHtmlEmpty("<p><br></p>")).toBe(true);
    expect(isHtmlEmpty("   ")).toBe(true);
  });

  it("détecte un contenu non vide", () => {
    expect(isHtmlEmpty("<p>Salut</p>")).toBe(false);
    expect(isHtmlEmpty("Salut")).toBe(false);
  });
});

describe("ensureHtml / looksLikeHtml", () => {
  it("laisse le HTML existant intact", () => {
    expect(ensureHtml("<p>Déjà</p>")).toBe("<p>Déjà</p>");
    expect(looksLikeHtml("<p>x</p>")).toBe(true);
  });

  it("convertit le texte brut en HTML", () => {
    expect(ensureHtml("Brut")).toBe("<p>Brut</p>");
    expect(looksLikeHtml("Brut")).toBe(false);
  });

  it("renvoie vide pour une entrée vide", () => {
    expect(ensureHtml("  ")).toBe("");
  });
});

describe("looksLikeMarkdown", () => {
  it("reconnaît la syntaxe Markdown courante", () => {
    expect(looksLikeMarkdown("# Titre")).toBe(true);
    expect(looksLikeMarkdown("- item")).toBe(true);
    expect(looksLikeMarkdown("1. item")).toBe(true);
    expect(looksLikeMarkdown("> citation")).toBe(true);
    expect(looksLikeMarkdown("du **gras**")).toBe(true);
    expect(looksLikeMarkdown("[lien](https://x.fr)")).toBe(true);
    expect(looksLikeMarkdown("```code```")).toBe(true);
  });

  it("ne confond pas le texte simple avec du Markdown", () => {
    expect(looksLikeMarkdown("Bonjour, comment ça va ?")).toBe(false);
    expect(looksLikeMarkdown("Une phrase normale.")).toBe(false);
  });
});

describe("markdownToHtml", () => {
  it("convertit le Markdown en HTML", () => {
    const html = markdownToHtml("# Titre\n\nUn **mot** en gras.");
    expect(html).toContain("<h1>Titre</h1>");
    expect(html).toContain("<strong>mot</strong>");
  });

  it("convertit les listes", () => {
    const html = markdownToHtml("- a\n- b");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>a</li>");
  });
});