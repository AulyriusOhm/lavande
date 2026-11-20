import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailSource } from "@/lib/mail";
import { setAccountDecryptPolicy } from "@/lib/mail-backend";

const { htmlImages, openExternal } = vi.hoisted(() => ({
  htmlImages: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  mailApi: { htmlImages },
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
}));

vi.mock("@/lib/open-external", () => ({ openExternal, isTauriShell: () => false }));

const { MailBody, fitMailWidth, fitMailZoom, liftDarkText, mailZoomScale } = await import(
  "@/components/mail-body"
);

const SOURCE: MailSource = { accountId: "perso", folderPath: "INBOX", uid: 12 };
const STORED = "<p>Soldes du mois</p>";
const WITH_IMAGES = '<p>Soldes du mois <img src="https://pix.example/solde.png" alt="visuel"></p>';

function renderBody(
  html: string | null = STORED,
  source: MailSource | null = SOURCE,
  encrypted = false,
) {
  return render(
    <MailBody
      className="mt-5"
      html={html ?? undefined}
      paragraphs={["Soldes du mois"]}
      source={source ?? undefined}
      encrypted={encrypted}
    />,
  );
}

function frame(container: HTMLElement) {
  const element = container.querySelector("iframe");
  if (!(element instanceof HTMLIFrameElement)) throw new Error("iframe absente");
  return element;
}

function srcDoc(container: HTMLElement) {
  return frame(container).getAttribute("srcdoc") ?? "";
}

function loadedDocument(container: HTMLElement, markup = "") {
  const contentDocument = document.implementation.createHTMLDocument("message");
  contentDocument.body.innerHTML = markup;
  const element = frame(container);
  Object.defineProperty(element, "contentDocument", {
    configurable: true,
    value: contentDocument,
  });
  fireEvent.load(element);
  return contentDocument;
}

function measureWith(container: HTMLElement, scrollHeight: number) {
  const contentDocument = loadedDocument(container);
  Object.defineProperty(contentDocument.documentElement, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  fireEvent.load(frame(container));
}

function clickInside(contentDocument: Document, selector: string) {
  const target = contentDocument.querySelector(selector);
  if (!target) throw new Error(`cible absente : ${selector}`);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  htmlImages.mockReset();
  openExternal.mockReset();
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--accent");
  setAccountDecryptPolicy({});
});

describe("isolation du HTML", () => {
  it("rend le corps dans une iframe srcdoc, jamais dans le DOM de l'app", () => {
    const { container } = renderBody();

    expect(srcDoc(container)).toContain("<body><p>Soldes du mois</p></body>");
    expect(container.querySelector("p")).toBeNull();
    expect(container.firstElementChild?.className).toBe("mt-5");
  });

  it("sandboxe l'iframe : allow-scripts requis par WebKitGTK, reste verrouillé", () => {
    const { container } = renderBody();

    const sandbox = frame(container).getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-same-origin");
    // Sans allow-scripts, WebKitGTK n'exécute pas le listener de clic posé par
    // le parent dans le cadre : les liens ne partent jamais (mesuré).
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-forms");
  });

  it("ouvre les liens dans un nouvel onglet via la base du document", () => {
    const { container } = renderBody('<p><a href="https://lavande.example">Le site</a></p>');

    expect(srcDoc(container)).toContain('<base target="_blank">');
  });

  it("embarque sa propre feuille de style", () => {
    const { container } = renderBody();
    const doc = srcDoc(container);

    expect(doc).toContain("<style>");
    expect(doc).toContain("body{margin:0");
    expect(doc).toContain("a{color:var(--accent-ink)");
    expect(document.querySelector("style")).toBeNull();
  });
});

describe("feuille de repli", () => {
  it("n'impose ni bordures de cellules ni marges de paragraphes", () => {
    const doc = srcDoc(renderBody().container);

    expect(doc).not.toContain("th,td{");
    expect(doc).not.toContain("border:1px solid var(--line)");
    expect(doc).not.toContain("p,div{margin");
    expect(doc).not.toContain("h1,h2");
    expect(doc).not.toContain("ul,ol{");
  });

  it("ne pose que des aides neutres en dessous du point de rupture mobile", () => {
    const doc = srcDoc(renderBody().container);
    const mobile = doc.indexOf("@media (max-width:720px)");

    expect(mobile).toBeGreaterThan(-1);
    expect(doc.indexOf("td,th{white-space:normal!important}")).toBeGreaterThan(mobile);
    expect(doc.indexOf("img{height:auto!important}")).toBeGreaterThan(mobile);
    expect(doc.indexOf("box-sizing:border-box!important")).toBeGreaterThan(mobile);
    expect(
      doc.indexOf("html,body{width:100%!important;max-width:100%!important;min-width:0!important}"),
    ).toBeGreaterThan(mobile);
    expect(doc).not.toContain("overflow-x");
  });

  it("n'écrase la largeur ni des tables ni du contenu sous 720px", () => {
    const doc = srcDoc(renderBody().container);

    expect(doc).not.toContain("table{width:100%!important}");
    expect(doc).not.toContain("body *{");
  });



  it("laisse le mail écrire sa mise en page après la feuille du client", () => {
    const mail =
      '<style>.promo{background-color:#8b7cf6;color:#fff}</style>' +
      '<table width="600" cellpadding="0" bgcolor="#ffffff"><tr><td style="padding:24px">x</td></tr></table>';
    const doc = srcDoc(renderBody(mail).container);

    expect(doc).toContain(`<body><style>.promo{background-color:#8b7cf6;color:#fff}</style>`);
    expect(doc.indexOf(".promo{")).toBeGreaterThan(doc.indexOf("--accent-ink"));
    expect(doc).toContain('width="600"');
    expect(doc).toContain('style="padding:24px"');
  });

  it("n'applique aucun filtre CSS au document en thème sombre", () => {
    document.documentElement.classList.add("dark");
    const doc = srcDoc(renderBody().container);

    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("background:transparent");
    expect(doc).not.toContain("invert");
    expect(doc).not.toContain("filter:");
  });
});

describe("largeur du cadre", () => {
  const NEWSLETTER =
    '<style>body{width:600px;margin:0;color:#3b3548}\n' +
    ".wrap{min-width:600px;width:600px;padding:24px}\n" +
    "@media (min-width:480px){.card{width:600px}}\n" +
    "@supports (display:grid){.grid{width:30pc}}\n" +
    ".small{width:320px}</style>" +
    '<table width="600"><tr><td width="600" style="min-width:600px;padding:0 32px">x</td></tr></table>';

  function neutralize(available: number) {
    const style = document.createElement("style");
    style.textContent =
      "body{width:600px;margin:0;color:#3b3548}" +
      ".wrap{min-width:600px;width:600px;padding:24px}" +
      "@media (min-width:480px){.card{width:600px}}" +
      "@supports (display:grid){.grid{width:30pc}}" +
      ".small{width:320px}";
    document.head.appendChild(style);
    const cell = document.createElement("td");
    cell.setAttribute("width", "600");
    cell.style.minWidth = "600px";
    cell.style.padding = "0 32px";
    const image = document.createElement("img");
    image.setAttribute("width", "520");
    const smallImage = document.createElement("img");
    smallImage.setAttribute("width", "120");
    const link = document.createElement("a");
    link.style.color = "#e1306c";
    document.body.append(cell, image, smallImage, link);

    fitMailWidth(document, available);

    const rules = style.sheet?.cssRules ?? [];
    const nested = (index: number) => rules[index].cssRules[0].style;
    return {
      body: rules[0].style,
      wrap: rules[1].style,
      media: nested(2),
      supports: nested(3),
      small: rules[4].style,
      cell,
      image,
      smallImage,
      link,
      cleanup: () => {
        style.remove();
        cell.remove();
        image.remove();
        smallImage.remove();
        link.remove();
        document.documentElement.style.removeProperty("width");
        document.documentElement.style.removeProperty("min-width");
        document.body.style.removeProperty("width");
        document.body.style.removeProperty("min-width");
      },
    };
  }

  it("ramène à 100% les largeurs absolues plus larges que le cadre", () => {
    const page = neutralize(400);
    try {
      expect(page.body.getPropertyValue("width")).toBe("100%");
      expect(page.wrap.getPropertyValue("width")).toBe("100%");
      expect(Number.parseFloat(page.wrap.getPropertyValue("min-width"))).toBe(0);
      expect(page.media.getPropertyValue("width")).toBe("100%");
      expect(page.supports.getPropertyValue("width")).toBe("100%");
      expect(page.cell.getAttribute("width")).toBe("100%");
      expect(page.image.getAttribute("width")).toBe("100%");
      expect(Number.parseFloat(page.cell.style.getPropertyValue("min-width"))).toBe(0);
      expect(document.documentElement.style.getPropertyValue("width")).toBe("100%");
      expect(Number.parseFloat(document.body.style.getPropertyValue("min-width"))).toBe(0);
    } finally {
      page.cleanup();
    }
  });

  it("ne touche ni aux couleurs, ni aux marges, ni aux largeurs qui tiennent", () => {
    const page = neutralize(400);
    try {
      expect(page.body.getPropertyValue("color")).toBe("rgb(59, 53, 72)");
      expect(page.body.getPropertyValue("margin")).toBe("0px");
      expect(page.wrap.getPropertyValue("padding")).toBe("24px");
      expect(page.small.getPropertyValue("width")).toBe("320px");
      expect(page.smallImage.getAttribute("width")).toBe("120");
      expect(page.link.style.getPropertyValue("color")).toBe("rgb(225, 48, 108)");
      expect(page.cell.style.getPropertyValue("padding")).toBe("0px 32px");
    } finally {
      page.cleanup();
    }
  });

  it("laisse un cadre large à la mise en page du mail", () => {
    const page = neutralize(800);
    try {
      expect(page.body.getPropertyValue("width")).toBe("600px");
      expect(page.wrap.getPropertyValue("min-width")).toBe("600px");
      expect(page.cell.getAttribute("width")).toBe("600");
      expect(page.image.getAttribute("width")).toBe("520");
      expect(document.documentElement.style.getPropertyValue("width")).toBe("");
    } finally {
      page.cleanup();
    }
  });

  it("neutralise le document à l'onload quand le cadre est étroit", () => {
    const { container } = renderBody(NEWSLETTER);
    const element = frame(container);
    const contentDocument = loadedDocument(container, NEWSLETTER);
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 412 });

    fireEvent.load(element);

    expect(contentDocument.documentElement.style.getPropertyValue("width")).toBe("100%");
  });

  it("laisse le document tel quel quand le cadre est large", () => {
    const { container } = renderBody(NEWSLETTER);
    const element = frame(container);
    const contentDocument = loadedDocument(container, NEWSLETTER);
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 1000 });

    fireEvent.load(element);

    expect(contentDocument.documentElement.style.getPropertyValue("width")).toBe("");
  });
});

describe("zoom adaptatif", () => {
  it("plafonne l'agrandissement à 1,8", () => {
    expect(mailZoomScale(2400, 600)).toBe(1.8);
  });

  it("suit la largeur disponible quand elle dépasse le design de peu", () => {
    expect(mailZoomScale(700, 600)).toBeCloseTo(700 / 600);
  });

  it("ne réduit jamais un mail plus large que le panneau", () => {
    expect(mailZoomScale(390, 600)).toBe(1);
  });

  it("ignore un gain sous le deadband de 1,05", () => {
    expect(mailZoomScale(610, 600)).toBe(1);
  });

  it("retombe sur le rendu natif sans design ou sans largeur", () => {
    expect(mailZoomScale(2400, 0)).toBe(1);
    expect(mailZoomScale(0, 600)).toBe(1);
  });

  it("ne zoome pas un mail dont le design remplit déjà le panneau", () => {
    expect(mailZoomScale(1200, 1200)).toBe(1);
  });

  it("laisse le zoom vide quand jsdom ne sait pas mesurer le design", () => {
    const contentDocument = document.implementation.createHTMLDocument("message");
    contentDocument.body.innerHTML = "<p>Soldes du mois</p>";

    fitMailZoom(contentDocument, 2400);

    expect(contentDocument.body.style.getPropertyValue("zoom")).toBe("");
    expect(contentDocument.body.style.getPropertyValue("width")).toBe("");
    expect(contentDocument.documentElement.style.getPropertyValue("width")).toBe("");
  });

  it("applique le facteur sur un design mesuré, largeur inline du mail intacte", () => {
    const contentDocument = document.implementation.createHTMLDocument("message");
    contentDocument.body.innerHTML = "<p>Soldes du mois</p>";
    contentDocument.body.style.setProperty("width", "600px");
    Object.defineProperty(contentDocument.body, "scrollWidth", {
      configurable: true,
      value: 600,
    });

    fitMailZoom(contentDocument, 2400);

    expect(contentDocument.body.style.getPropertyValue("zoom")).toBe("1.8");
    expect(contentDocument.body.style.getPropertyValue("width")).toBe("600px");
    expect(contentDocument.documentElement.style.getPropertyValue("width")).toBe("");
  });

  it("retire le zoom quand le cadre repasse sous le point de rupture mobile", () => {
    const contentDocument = document.implementation.createHTMLDocument("message");
    contentDocument.body.style.setProperty("zoom", "1.8");

    fitMailZoom(contentDocument, 412);

    expect(contentDocument.body.style.getPropertyValue("zoom")).toBe("");
  });

  it("recalcule le zoom à l'onload d'un cadre élargi", () => {
    const { container } = renderBody('<p style="width:600px">Soldes du mois</p>');
    const element = frame(container);
    const contentDocument = loadedDocument(container, '<p style="width:600px">Soldes du mois</p>');
    contentDocument.body.style.setProperty("zoom", "1.8");
    Object.defineProperty(contentDocument.body, "scrollWidth", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 2400 });

    fireEvent.load(element);

    expect(contentDocument.body.style.getPropertyValue("zoom")).toBe("1.8");

    Object.defineProperty(contentDocument.body, "scrollWidth", {
      configurable: true,
      value: 2400,
    });
    fireEvent.load(element);

    expect(contentDocument.body.style.getPropertyValue("zoom")).toBe("");
  });
});

describe("thème", () => {
  it("suit le thème clair de l'app", () => {
    const { container } = renderBody();
    const doc = srcDoc(container);

    expect(doc).toContain("color-scheme:light");
    expect(doc).toContain("color:var(--ink-soft)");
    expect(doc).toContain("--ink:#1b1523");
    expect(doc).toContain("--line:#ece8f5");
  });

  it("bascule sur la palette sombre et force les couleurs du document", () => {
    document.documentElement.classList.add("dark");
    const { container } = renderBody();
    const doc = srcDoc(container);

    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("--ink:#f4f1fa");
    expect(doc).toContain("--ink-soft:#a8a1b8");
    expect(doc).toContain("--ink-muted:#8c8699");
    expect(doc).toContain("--line:#2a2438");
    expect(doc).toContain("55%,#ffffff");
  });

  it("reprend l'accent choisi et retombe sur le lavande sinon", () => {
    document.documentElement.style.setProperty("--accent", "#34d399");
    const { container, unmount } = renderBody();
    expect(srcDoc(container)).toContain("--accent:#34d399");

    unmount();
    document.documentElement.style.setProperty("--accent", "rgb(255, 0, 0)");
    const invalid = renderBody();
    expect(srcDoc(invalid.container)).toContain("--accent:#8b7cf6");
  });
});

describe("mode sombre : lisibilité du texte", () => {
  function mailFrame(markup: string) {
    const element = document.createElement("iframe");
    document.body.append(element);
    const contentDocument = element.contentDocument as Document;
    contentDocument.body.innerHTML = markup;
    return { contentDocument, cleanup: () => element.remove() };
  }

  function colorOf(contentDocument: Document, selector: string) {
    const element = contentDocument.querySelector(selector);
    if (!element) throw new Error(`cible absente : ${selector}`);
    return contentDocument.defaultView!.getComputedStyle(element).color;
  }

  it("remonte un texte noir posé sur le fond sombre de l'app", () => {
    const page = mailFrame('<p style="color:#000">Un devis</p>');
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "p")).toBe("rgb(244, 241, 250)");
      expect(page.contentDocument.querySelector("p")?.style.getPropertyPriority("color")).toBe(
        "important",
      );
    } finally {
      page.cleanup();
    }
  });

  it("garde une hiérarchie : le noir remonte à l'encre, le gris sombre à l'encre douce", () => {
    const page = mailFrame(
      '<h1 style="color:#333">Titre</h1><p style="color:#6b6478">Corps</p><p style="color:#fff9e6">Déjà clair</p>',
    );
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "h1")).toBe("rgb(244, 241, 250)");
      expect(colorOf(page.contentDocument, "p:nth-of-type(1)")).toBe("rgb(168, 161, 184)");
      expect(colorOf(page.contentDocument, "p:nth-of-type(2)")).toBe("rgb(255, 249, 230)");
    } finally {
      page.cleanup();
    }
  });

  it("laisse le texte noir d'un encadré au fond clair, style inline ou classe", () => {
    const page = mailFrame(
      '<style>.callout{background-color:#fff9e6}</style>' +
        '<div style="background-color:#fff9e6"><p id="inline" style="color:#000">Encadré</p></div>' +
        '<div class="callout"><p id="classed" style="color:#000">Encadré aussi</p></div>',
    );
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "#inline")).toBe("rgb(0, 0, 0)");
      expect(colorOf(page.contentDocument, "#classed")).toBe("rgb(0, 0, 0)");
    } finally {
      page.cleanup();
    }
  });

  it("remonte un texte sombre posé sur un fond sombre du mail", () => {
    const page = mailFrame(
      '<div style="background-color:#241b3a"><p style="color:#333">Encadré sombre</p></div>',
    );
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "p")).toBe("rgb(244, 241, 250)");
    } finally {
      page.cleanup();
    }
  });

  it("s'arrête au fond le plus proche : un encadré clair garde son texte sous un ancêtre sombre", () => {
    const page = mailFrame(
      '<div style="background-color:#241b3a"><div style="background-color:#fff9e6">' +
        '<p style="color:#000">Encadré clair</p></div></div>',
    );
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "p")).toBe("rgb(0, 0, 0)");
    } finally {
      page.cleanup();
    }
  });

  it("remonte une couleur sombre héritée d'un ancêtre", () => {
    const page = mailFrame('<div style="color:#111"><p>Hérité</p></div>');
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "div")).toBe("rgb(244, 241, 250)");
      expect(colorOf(page.contentDocument, "p")).toBe("rgb(244, 241, 250)");
    } finally {
      page.cleanup();
    }
  });

  it("traverse un fond translucide pour trouver le fond clair du dessous", () => {
    const page = mailFrame(
      '<div style="background-color:#ffffff"><div style="background-color:rgba(0, 0, 0, 0.05)">' +
        '<p style="color:#000">Carte</p></div></div>',
    );
    try {
      liftDarkText(page.contentDocument);

      expect(colorOf(page.contentDocument, "p")).toBe("rgb(0, 0, 0)");
    } finally {
      page.cleanup();
    }
  });

  it("laisse telle quelle une couleur qu'il ne sait pas lire", () => {
    const page = mailFrame('<p style="color:#000">Exotique</p>');
    try {
      Object.defineProperty(page.contentDocument, "defaultView", {
        configurable: true,
        value: {
          getComputedStyle: () => ({
            color: "color(display-p3 0 0 0)",
            backgroundColor: "rgba(0, 0, 0, 0)",
          }),
        },
      });

      liftDarkText(page.contentDocument);

      expect(page.contentDocument.querySelector("p")?.style.color).toBe("rgb(0, 0, 0)");
    } finally {
      page.cleanup();
    }
  });

  it("ne fait rien sans vue sur le document", () => {
    const contentDocument = document.implementation.createHTMLDocument("message");
    contentDocument.body.innerHTML = '<p style="color:#000">x</p>';

    liftDarkText(contentDocument);

    expect(contentDocument.querySelector("p")?.style.color).toBe("rgb(0, 0, 0)");
  });

  it("tourne au chargement du cadre en thème sombre", () => {
    document.documentElement.classList.add("dark");
    const { container } = renderBody();
    const contentDocument = frame(container).contentDocument as Document;
    contentDocument.body.innerHTML = '<p style="color:#000">Un devis</p>';

    fireEvent.load(frame(container));

    expect(colorOf(contentDocument, "p")).toBe("rgb(244, 241, 250)");
  });

  it("rejoue la passe quand le thème bascule : le cadre se recharge et l'onLoad repart", async () => {
    const { container } = renderBody();
    const element = frame(container);
    const light = srcDoc(container);
    fireEvent.load(element);

    document.documentElement.classList.add("dark");
    await waitFor(() => expect(srcDoc(container)).toContain("color-scheme:dark"));
    expect(srcDoc(container)).not.toBe(light);

    const contentDocument = element.contentDocument as Document;
    contentDocument.body.innerHTML = '<p style="color:#000">Un devis</p>';
    fireEvent.load(element);

    expect(colorOf(contentDocument, "p")).toBe("rgb(244, 241, 250)");
  });

  it("ne touche à rien au chargement du cadre en thème clair", () => {
    const { container } = renderBody();
    const contentDocument = frame(container).contentDocument as Document;
    contentDocument.body.innerHTML = '<p style="color:#000">Un devis</p>';

    fireEvent.load(frame(container));

    expect(colorOf(contentDocument, "p")).toBe("rgb(0, 0, 0)");
  });
});

describe("hauteur", () => {
  it("mesure le contenu à l'onload", () => {
    const { container } = renderBody();
    const element = frame(container);
    expect(element.style.height).toBe("65vh");

    measureWith(container, 420);
    expect(element.style.height).toBe("420px");
  });

  it("plafonne la hauteur pour laisser un scroll interne", () => {
    const { container } = renderBody();
    const element = frame(container);

    measureWith(container, 5_000);
    expect(element.style.height).toBe("900px");
  });

  it("ignore une mesure nulle", () => {
    const { container } = renderBody();
    const element = frame(container);

    measureWith(container, 0);
    expect(element.style.height).toBe("65vh");
  });
});

describe("liens externes", () => {
  it("ouvre un lien http dans le navigateur du système, pas dans la webview", () => {
    const { container } = renderBody('<p><a href="https://lavande.example/promo">Le site</a></p>');
    const contentDocument = loadedDocument(
      container,
      '<p><a href="https://lavande.example/promo">Le site</a></p>',
    );

    const event = clickInside(contentDocument, "a");

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://lavande.example/promo");
  });

  it("intercepte aussi un lien cliqué depuis son contenu imbriqué", () => {
    const { container } = renderBody('<p><a href="http://lavande.example"><span>Le site</span></a></p>');
    const contentDocument = loadedDocument(
      container,
      '<p><a href="http://lavande.example"><span>Le site</span></a></p>',
    );

    clickInside(contentDocument, "span");

    expect(openExternal).toHaveBeenCalledWith("http://lavande.example/");
  });

  it("laisse les liens mailto au document", () => {
    const { container } = renderBody('<p><a href="mailto:contact@lavande.example">Écrire</a></p>');
    const contentDocument = loadedDocument(
      container,
      '<p><a href="mailto:contact@lavande.example">Écrire</a></p>',
    );

    const event = clickInside(contentDocument, "a");

    expect(event.defaultPrevented).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("réattache l'interception au document recréé par un nouveau srcdoc", () => {
    const { container, rerender } = renderBody('<p><a href="https://un.example">Un</a></p>');
    loadedDocument(container, '<p><a href="https://un.example">Un</a></p>');
    const previous = srcDoc(container);

    rerender(
      <MailBody
        className="mt-5"
        html={'<p><a href="https://deux.example">Deux</a></p>'}
        paragraphs={["Soldes du mois"]}
        source={SOURCE}
      />,
    );
    const contentDocument = loadedDocument(
      container,
      '<p><a href="https://deux.example">Deux</a></p>',
    );

    expect(srcDoc(container)).not.toBe(previous);
    const event = clickInside(contentDocument, "a");

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://deux.example/");
  });
});

describe("fallback texte", () => {
  it("rend les paragraphes sans iframe quand il n'y a pas de HTML", () => {
    const { container } = renderBody(null);

    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Soldes du mois")).toBeTruthy();
  });
});

describe("images distantes", () => {
  it("reste masquées tant que le lecteur ne clique pas", () => {
    const { container } = renderBody();

    expect(screen.getByText("Images masquées")).toBeTruthy();
    expect(screen.getByLabelText("Afficher les images de ce message")).toBeTruthy();
    expect(htmlImages).not.toHaveBeenCalled();
    expect(srcDoc(container)).not.toContain("<img");
  });

  it("relit le corps sur le service au clic et rend les images", async () => {
    htmlImages.mockResolvedValue({ html: WITH_IMAGES });
    const { container } = renderBody();

    fireEvent.click(screen.getByLabelText("Afficher les images de ce message"));

    await waitFor(() => expect(htmlImages).toHaveBeenCalledWith("perso", "INBOX", 12));
    await waitFor(() =>
      expect(srcDoc(container)).toContain('src="https://pix.example/solde.png"'),
    );
    expect(screen.queryByText("Images masquées")).toBeNull();
  });

  it("montre le chargement puis l'erreur du service, corps intact", async () => {
    let fail: (error: Error) => void = () => {};
    htmlImages.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const { container } = renderBody();

    fireEvent.click(screen.getByLabelText("Afficher les images de ce message"));
    expect(await screen.findByText("Chargement…")).toBeTruthy();
    expect(srcDoc(container)).toContain("Soldes du mois");

    fail(new Error("message 12 introuvable"));
    expect(await screen.findByText("Réessayer")).toBeTruthy();
    expect(screen.getByText(/Images non affichées · message 12 introuvable/)).toBeTruthy();
    expect(srcDoc(container)).toContain("Soldes du mois");
  });

  it("refuse de relire un message chiffré d'un compte PGP fermé", async () => {
    setAccountDecryptPolicy({ perso: false });
    renderBody(STORED, SOURCE, true);

    fireEvent.click(screen.getByLabelText("Afficher les images de ce message"));

    expect(
      await screen.findByText(/Images non affichées · PGP désactivé pour ce compte/),
    ).toBeTruthy();
    expect(htmlImages).not.toHaveBeenCalled();
  });

  it("relit un message en clair même quand le compte est fermé", async () => {
    setAccountDecryptPolicy({ perso: false });
    htmlImages.mockResolvedValue({ html: WITH_IMAGES });
    const { container } = renderBody(STORED, SOURCE, false);

    fireEvent.click(screen.getByLabelText("Afficher les images de ce message"));

    await waitFor(() => expect(htmlImages).toHaveBeenCalledWith("perso", "INBOX", 12));
    await waitFor(() =>
      expect(srcDoc(container)).toContain('src="https://pix.example/solde.png"'),
    );
  });

  it("n'affiche aucun bandeau pour un message sans HTML", () => {
    renderBody(null);

    expect(screen.queryByText("Images masquées")).toBeNull();
    expect(screen.getByText("Soldes du mois")).toBeTruthy();
  });

  it("n'affiche aucun bandeau pour un message de la maquette", () => {
    renderBody(STORED, null);

    expect(screen.queryByText("Images masquées")).toBeNull();
    expect(srcDoc(document.body)).toContain("Soldes du mois");
  });
});
