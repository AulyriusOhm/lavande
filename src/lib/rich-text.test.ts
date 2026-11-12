import { describe, expect, it } from "vitest";
import {
  ensureHtml,
  htmlToText,
  isHtmlEmpty,
  looksLikeHtml,
  looksLikeMarkdown,
  markdownToHtml,
  sanitizeHtml,
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

  it("ignore les lignes vides de tête et de queue", () => {
    expect(textToHtml("\n\nBonjour\n")).toBe("<p>Bonjour</p>");
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

  it("ne prend pas une URL entre chevrons, un mailto ou un émoticône pour du HTML", () => {
    expect(looksLikeHtml("<https://bbfhigcd.r.af.d.sendibt2.com/tr/cl/abc123>")).toBe(false);
    expect(looksLikeHtml("<mailto:a@b.c>")).toBe(false);
    expect(looksLikeHtml("j'ai vu <3")).toBe(false);
    expect(looksLikeHtml("Bonjour\n> citation")).toBe(false);
  });

  it("reconnaît les vraies balises HTML", () => {
    expect(looksLikeHtml("<p>")).toBe(true);
    expect(looksLikeHtml("<div class=x>")).toBe(true);
    expect(looksLikeHtml("<br/>")).toBe(true);
    expect(looksLikeHtml('<a href="https://x.fr">lien</a>')).toBe(true);
    expect(looksLikeHtml("</blockquote>")).toBe(true);
  });

  it("garde une ligne par ligne d'une réponse citée contenant <https://…>", () => {
    const body = [
      "",
      "---",
      "Le lundi 9 novembre, Support a écrit :",
      "> Bonjour,",
      ">",
      "> Suivi :",
      "> <https://example.com/a/b>",
      "> Je vais relancer.",
    ].join("\n");

    const html = ensureHtml(body);

    expect(html.split("<br>").length).toBe(7);
    expect(html).toContain(
      "Suivi :<br>&gt; &lt;https://example.com/a/b&gt;<br>&gt; Je vais relancer.",
    );
    expect(html).not.toContain("<https");
  });

  it("préserve les paragraphes d'un texte brut contenant une URL entre chevrons", () => {
    const html = ensureHtml("Bonjour\n\n> citation\n<https://x.fr>\n\nMerci");

    expect(html.match(/<p>/g)?.length).toBe(3);
    expect(html).toContain("&gt; citation<br>&lt;https://x.fr&gt;");
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

describe("sanitizeHtml", () => {
  it("conserve le HTML sûr", () => {
    expect(sanitizeHtml("<p>Bonjour <b>monde</b></p>")).toBe("<p>Bonjour <b>monde</b></p>");
  });

  it("retire les scripts et iframes", () => {
    expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
    expect(sanitizeHtml('<iframe src="x"></iframe><p>ok</p>')).toBe("<p>ok</p>");
  });

  it("retire les gestionnaires d'événements et les URL javascript:", () => {
    expect(sanitizeHtml('<p onclick="alert(1)">x</p>')).toBe("<p>x</p>");
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("renvoie vide pour une entrée vide", () => {
    expect(sanitizeHtml("")).toBe("");
    expect(sanitizeHtml("   ")).toBe("");
  });
});