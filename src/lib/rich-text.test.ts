import { describe, expect, it } from "vitest";
import {
  buildQuotedHtml,
  ensureHtml,
  extractImageTokens,
  htmlToText,
  isHtmlEmpty,
  looksLikeHtml,
  looksLikeMarkdown,
  markdownToHtml,
  restoreImageTokens,
  sanitizeHtml,
  splitQuotedBody,
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

  it("remplace une image par son libellé", () => {
    expect(htmlToText('<p>Voici <img src="data:image/png;base64,iVBORw=="></p>')).toBe(
      "Voici [image]",
    );
    expect(htmlToText('<p><img src="x.png" alt="capture"></p>')).toBe("[capture]");
  });

  it("garde une URL entre chevrons au lieu de la prendre pour une balise", () => {
    expect(htmlToText("<p>Suivi : <https://example.com/x></p>")).toBe(
      "Suivi : https://example.com/x",
    );
    expect(htmlToText("<p>Écrire à <mailto:a@b.fr> ou <ftp://ftp.example/pub></p>")).toBe(
      "Écrire à mailto:a@b.fr ou ftp://ftp.example/pub",
    );
  });

  it("laisse les entités &lt; &gt; intactes", () => {
    expect(htmlToText("<p>Voir &lt;https://example.com/x&gt;</p>")).toBe(
      "Voir <https://example.com/x>",
    );
  });
});

describe("extractImageTokens / restoreImageTokens", () => {
  const IMAGE = '<img src="a.png" alt="capture">';
  const OTHER = '<img src="b.png">';

  it("extrait les images dans l'ordre et met un jeton dans le texte", () => {
    const { text, images } = extractImageTokens(`<p>Voici</p>${IMAGE}<p>Merci</p>${OTHER}`);

    expect(images).toEqual([IMAGE, OTHER]);
    expect(text).toBe("Voici\n⟦img-0⟧Merci\n⟦img-1⟧");
  });

  it("réinsère l'image à la place du jeton", () => {
    const { text, images } = extractImageTokens(`<p>Voici</p>${IMAGE}<p>Merci</p>`);

    expect(restoreImageTokens(text, images)).toBe(`<p>Voici</p>${IMAGE}<p>Merci</p>`);
  });

  it("ajoute en fin l'image dont le jeton a été supprimé", () => {
    expect(restoreImageTokens("Bonjour\n\nMerci.", [IMAGE])).toBe(`<p>Bonjour</p><p>Merci.</p>${IMAGE}`);
  });

  it("gère plusieurs images, y compris après suppression d'un jeton", () => {
    expect(restoreImageTokens("⟦img-1⟧\nEntre", [IMAGE, OTHER])).toBe(`${OTHER}<p>Entre</p>${IMAGE}`);
    expect(restoreImageTokens("Entre", [IMAGE, OTHER])).toBe(`<p>Entre</p>${IMAGE}${OTHER}`);
  });

  it("retombe sur textToHtml quand il n'y a aucune image", () => {
    expect(restoreImageTokens("Bonjour\n\nÀ toi", [])).toBe(textToHtml("Bonjour\n\nÀ toi"));
  });

  it("conserve les images sur un aller-retour", () => {
    const html = `<p>Regarde</p>${IMAGE}<p>et</p>${OTHER}<p>fin</p>`;
    const { text, images } = extractImageTokens(html);

    const restored = restoreImageTokens(text, images);

    expect(restored).toContain(IMAGE);
    expect(restored).toContain(OTHER);
    expect(restored.indexOf(IMAGE)).toBeLessThan(restored.indexOf(OTHER));
    expect(restored).not.toContain("⟦img-");
  });

  it("gère un texte vide", () => {
    expect(extractImageTokens("")).toEqual({ text: "", images: [] });
    expect(restoreImageTokens("", [IMAGE])).toBe(IMAGE);
    expect(restoreImageTokens("", [])).toBe("");
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

  it("ne considère pas un corps fait d'images comme vide", () => {
    expect(isHtmlEmpty('<p><img src="data:image/png;base64,iVBORw=="></p>')).toBe(false);
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

  it("conserve une image en data URL", () => {
    const html = '<p>Capture :</p><img src="data:image/png;base64,iVBORw==" alt="capture">';
    expect(sanitizeHtml(html)).toBe(html);
  });
});

describe("buildQuotedHtml", () => {
  it("enveloppe l'attribution et l'historique dans un blockquote marqué", () => {
    expect(buildQuotedHtml("Le 9 novembre, Support a écrit :", "<p>Bonjour</p>")).toBe(
      '<blockquote class="lavande-quote"><p class="lavande-quote-head">Le 9 novembre, Support a écrit :</p><p>Bonjour</p></blockquote>',
    );
  });

  it("échappe l'attribution pour qu'elle ne devienne pas du HTML", () => {
    expect(buildQuotedHtml("De : <a@b.fr>", "")).toContain("De : &lt;a@b.fr&gt;");
  });
});

describe("splitQuotedBody", () => {
  const quoted = buildQuotedHtml("Le 9 novembre, Support a écrit :", "<p>Bonjour<br>Suite</p>");

  it("retrouve le corps et la citation produits par buildQuotedHtml", () => {
    const split = splitQuotedBody(`<p>Ma réponse</p><br>${quoted}`);

    expect(split.body).toBe("<p>Ma réponse</p>");
    expect(split.quoted).toBe(quoted);
  });

  it("survit à un passage par sanitizeHtml", () => {
    const split = splitQuotedBody(sanitizeHtml(`<p>Ma réponse</p><br>${quoted}`));

    expect(split.body).toBe("<p>Ma réponse</p>");
    expect(split.quoted).toBe(quoted);
  });

  it("laisse un corps sans citation intact", () => {
    expect(splitQuotedBody("<p>Bonjour</p>")).toEqual({ body: "<p>Bonjour</p>", quoted: "" });
    expect(splitQuotedBody("Bonjour")).toEqual({ body: "Bonjour", quoted: "" });
  });

  it("renvoie un corps vide pour une entrée vide", () => {
    expect(splitQuotedBody("")).toEqual({ body: "", quoted: "" });
    expect(splitQuotedBody("   ")).toEqual({ body: "   ", quoted: "" });
  });
});