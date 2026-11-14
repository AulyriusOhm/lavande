import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";
import { buildQuotedHtml, textToHtml } from "@/lib/rich-text";

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    mailAccounts: [{ id: "perso", label: "Perso", email: "roman@lavande.mail" }],
  }),
}));

const signatureMock = vi.hoisted(() => ({ html: null as string | null }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ signatures: [], llm: { endpoint: "", apiKey: "", model: "" } }),
  activeSignature: () => signatureMock.html,
}));

const { ComposeScreen } = await import("@/screens/compose-screen");

function Harness({
  onChange,
  quoted,
  body,
}: {
  onChange?: (draft: ComposeDraft) => void;
  quoted?: string;
  body?: string;
}) {
  const [draft, setDraft] = useState<ComposeDraft>({ ...baseDraft("perso", false, false), quoted, body: body ?? "" });
  return (
    <ComposeScreen
      draft={draft}
      onDraftChange={(next) => {
        setDraft(next);
        onChange?.(next);
      }}
      onClose={() => {}}
    />
  );
}

function pick(input: HTMLElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  signatureMock.html = null;
});

describe("pièces jointes de la composition", () => {
  it("ajoute le fichier choisi au brouillon et affiche une puce", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(draft) => drafts.push(draft)} />);

    pick(screen.getByTestId("compose-attach-input"), new File(["hello"], "facture.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(screen.getByText("facture.pdf")).toBeTruthy());
    expect(screen.getByText("5 o")).toBeTruthy();
    expect(drafts.at(-1)?.attachments).toEqual([
      { filename: "facture.pdf", mime: "application/pdf", data_base64: "aGVsbG8=", size: 5 },
    ]);
  });

  it("devine le type MIME quand le système ne le renseigne pas", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(draft) => drafts.push(draft)} />);

    pick(screen.getByTestId("compose-attach-input"), new File(["aGVsbG8="], "notes.md"));

    await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());
    expect(drafts.at(-1)?.attachments?.[0].mime).toBe("text/markdown");
  });

  it("retire la pièce jointe depuis la puce", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(draft) => drafts.push(draft)} />);

    pick(screen.getByTestId("compose-attach-input"), new File(["hello"], "facture.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(screen.getByText("facture.pdf")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Retirer facture.pdf"));

    await waitFor(() => expect(screen.queryByText("facture.pdf")).toBeNull());
    expect(drafts.at(-1)?.attachments).toEqual([]);
  });

  it("refuse un fichier au-delà de la limite et le dit", async () => {
    const drafts: ComposeDraft[] = [];
    render(<Harness onChange={(draft) => drafts.push(draft)} />);

    const heavy = new File(["x"], "enorme.zip", { type: "application/zip" });
    Object.defineProperty(heavy, "size", { value: 30 * 1024 * 1024 });
    pick(screen.getByTestId("compose-attach-input"), heavy);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("est trop lourd"));
    expect(screen.queryByText("enorme.zip")).toBeNull();
    expect(drafts.at(-1)?.attachments).toBeUndefined();
  });
});

describe("aperçu de la signature", () => {
  it("affiche la signature dans le corps quand elle est activée", () => {
    signatureMock.html = "<p>Cordialement,<br>Roman</p>";
    render(<Harness />);
    const preview = screen.getByTestId("signature-preview");
    expect(preview.textContent).toContain("Cordialement");
    expect(preview.textContent).toContain("Roman");
  });

  it("masque l'aperçu quand la signature est retirée du message", () => {
    signatureMock.html = "<p>Cordialement</p>";
    render(<Harness />);
    fireEvent.click(screen.getByText("Signature activée"));
    expect(screen.queryByTestId("signature-preview")).toBeNull();
  });
});

describe("historique cité replié", () => {
  const QUOTED = buildQuotedHtml("Le 9 novembre, Support a écrit :", textToHtml("Bonjour\nSuite du fil"));

  it("reste replié par défaut puis se déroule et se replie au clic", () => {
    render(<Harness quoted={QUOTED} />);

    const toggle = screen.getByRole("button", { name: "Voir la conversation précédente" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.className).toContain("min-h-11");
    expect(screen.queryByTestId("compose-quoted")).toBeNull();

    fireEvent.click(toggle);

    const opened = screen.getByRole("button", { name: "Masquer la conversation précédente" });
    expect(opened.getAttribute("aria-expanded")).toBe("true");
    const quoted = screen.getByTestId("compose-quoted");
    expect(quoted.textContent).toContain("Support a écrit");
    expect(quoted.textContent).toContain("Suite du fil");

    fireEvent.click(opened);
    expect(screen.queryByTestId("compose-quoted")).toBeNull();
  });

  it("rend l'historique en lecture seule, sans éditeur ni interaction", () => {
    render(<Harness quoted={QUOTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Voir la conversation précédente" }));

    const quoted = screen.getByTestId("compose-quoted");
    expect(quoted.getAttribute("contenteditable")).toBeNull();
    expect(quoted.querySelector("[contenteditable]")).toBeNull();
    expect(quoted.querySelector("input, textarea, button")).toBeNull();
    expect(quoted.innerHTML).not.toContain("contenteditable=");
    expect(quoted.className).toContain("pointer-events-none");
    expect(quoted.className).toContain("text-ink-soft");
    expect(quoted.className).toContain("bg-surface-2");
    expect(quoted.className).toContain("rounded-2xl");
  });

  it("place l'aperçu de la signature avant le bloc citation", () => {
    signatureMock.html = "<p>Cordialement</p>";
    render(<Harness quoted={QUOTED} />);

    const preview = screen.getByTestId("signature-preview");
    const block = screen.getByTestId("compose-quoted-block");
    expect(preview.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("n'affiche aucun bloc citation sans historique", () => {
    render(<Harness />);
    expect(screen.queryByTestId("compose-quoted-block")).toBeNull();
    expect(screen.queryByRole("button", { name: "Voir la conversation précédente" })).toBeNull();
  });
});

describe("réécriture sans perte d'image inline", () => {
  const IMAGE = '<img src="data:image/png;base64,iVBORw==">';

  it("garde l'image du corps après une correction locale", async () => {
    const drafts: ComposeDraft[] = [];
    render(
      <Harness body={`<p>bonjour  ,le monde</p>${IMAGE}<p>merci</p>`} onChange={(draft) => drafts.push(draft)} />,
    );

    fireEvent.click(screen.getByLabelText("Corriger ou reformuler le message"));
    fireEvent.click(await screen.findByRole("radio", { name: /Correction/ }));
    fireEvent.click(screen.getByText("Appliquer"));

    await waitFor(() => expect(drafts.at(-1)?.body).toContain(IMAGE));
    const result = drafts.at(-1)?.body ?? "";
    expect(result).toContain("Bonjour, le monde");
    expect(result).toContain("<p>merci.</p>");
    expect(result).not.toContain("⟦img-");
    expect(result).not.toContain("[image]");
  });
});

describe("confirmations de rédaction · cibles tactiles", () => {
  it("donne 44 px de haut aux boutons de la confirmation d'envoi", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText("destinataire@mail.com"), {
      target: { value: "camille@lavande.mail" },
    });
    fireEvent.click(screen.getByLabelText("Envoyer le message"));

    const dialog = await screen.findByRole("alertdialog", { name: "Confirmer l'envoi sans objet ou sans message" });
    const buttons = Array.from(dialog.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) expect(button.className).toContain("min-h-11");
  });

  it("donne 44 px de haut au bouton « Supprimer » du brouillon, en rose conforme", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText("Objet du message"), { target: { value: "Brouillon" } });
    fireEvent.click(screen.getByLabelText("Fermer"));

    const dialog = await screen.findByRole("alertdialog", { name: "Enregistrer ou supprimer le brouillon" });
    const remove = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Supprimer");
    expect(remove?.className).toContain("min-h-11");
    expect(remove?.className).toContain("text-rose-700");
    expect(remove?.className).toContain("dark:text-rose-300");
  });

  it("libelle les champs de rédaction avec une couleur de placeholder conforme", () => {
    render(<Harness />);
    for (const placeholder of ["destinataire@mail.com", "Objet du message"]) {
      const field = screen.getByPlaceholderText(placeholder);
      expect(field.className).toContain("placeholder:text-ink-soft");
      expect(field.className).not.toContain("placeholder:text-ink-muted/70");
    }
  });
});
