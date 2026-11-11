import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailSource } from "@/lib/mail";

const { htmlImages } = vi.hoisted(() => ({ htmlImages: vi.fn() }));

vi.mock("@/lib/api", () => ({
  mailApi: { htmlImages },
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
}));

const { MailBody } = await import("@/components/mail-body");

const SOURCE: MailSource = { accountId: "perso", folderPath: "INBOX", uid: 12 };
const STORED = "<p>Soldes du mois</p>";
const WITH_IMAGES = '<p>Soldes du mois <img src="https://pix.example/solde.png" alt="visuel"></p>';

function renderBody(html: string | null = STORED, source: MailSource | null = SOURCE) {
  return render(
    <MailBody
      className="mt-5"
      html={html ?? undefined}
      paragraphs={["Soldes du mois"]}
      source={source ?? undefined}
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

function measureWith(container: HTMLElement, scrollHeight: number) {
  const element = frame(container);
  Object.defineProperty(element, "contentDocument", {
    configurable: true,
    value: { documentElement: { scrollHeight }, body: null },
  });
  fireEvent.load(element);
}

beforeEach(() => {
  htmlImages.mockReset();
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--accent");
});

describe("isolation du HTML", () => {
  it("rend le corps dans une iframe srcdoc, jamais dans le DOM de l'app", () => {
    const { container } = renderBody();

    expect(srcDoc(container)).toContain("<body><p>Soldes du mois</p></body>");
    expect(container.querySelector("p")).toBeNull();
    expect(container.firstElementChild?.className).toBe("mt-5");
  });

  it("sandboxe l'iframe sans allow-scripts", () => {
    const { container } = renderBody();

    const sandbox = frame(container).getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-scripts");
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
