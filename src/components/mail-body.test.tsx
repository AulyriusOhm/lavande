import { beforeEach, describe, expect, it, vi } from "vitest";
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
    <MailBody html={html ?? undefined} paragraphs={["Soldes du mois"]} source={source ?? undefined} />,
  );
}

beforeEach(() => {
  htmlImages.mockReset();
});

describe("images distantes", () => {
  it("reste masquées tant que le lecteur ne clique pas", () => {
    renderBody();

    expect(screen.getByText("Images masquées")).toBeTruthy();
    expect(screen.getByLabelText("Afficher les images de ce message")).toBeTruthy();
    expect(htmlImages).not.toHaveBeenCalled();
    expect(document.querySelector("img")).toBeNull();
  });

  it("relit le corps sur le service au clic et rend les images", async () => {
    htmlImages.mockResolvedValue({ html: WITH_IMAGES });
    const { container } = renderBody();

    fireEvent.click(screen.getByLabelText("Afficher les images de ce message"));

    await waitFor(() => expect(htmlImages).toHaveBeenCalledWith("perso", "INBOX", 12));
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://pix.example/solde.png"),
    );
    expect(screen.queryByText("Images masquées")).toBeNull();
  });

  it("montre le chargement puis l'erreur du service, corps intact", async () => {
    let fail: (error: Error) => void = () => {};
    htmlImages.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    renderBody();

    fireEvent.click(screen.getByLabelText("Afficher les images de ce message"));
    expect(await screen.findByText("Chargement…")).toBeTruthy();
    expect(screen.getByText("Soldes du mois")).toBeTruthy();

    fail(new Error("message 12 introuvable"));
    expect(await screen.findByText("Réessayer")).toBeTruthy();
    expect(screen.getByText(/Images non affichées · message 12 introuvable/)).toBeTruthy();
    expect(screen.getByText("Soldes du mois")).toBeTruthy();
  });

  it("n'affiche aucun bandeau pour un message sans HTML", () => {
    renderBody(null);

    expect(screen.queryByText("Images masquées")).toBeNull();
    expect(screen.getByText("Soldes du mois")).toBeTruthy();
  });

  it("n'affiche aucun bandeau pour un message de la maquette", () => {
    renderBody(STORED, null);

    expect(screen.queryByText("Images masquées")).toBeNull();
    expect(screen.getByText("Soldes du mois")).toBeTruthy();
  });
});
