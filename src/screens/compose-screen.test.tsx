import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    accounts: [{ id: "perso", label: "Perso", email: "roman@lavande.mail" }],
  }),
}));

const signatureMock = vi.hoisted(() => ({ html: null as string | null }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ signatures: [], llm: { endpoint: "", apiKey: "", model: "" } }),
  activeSignature: () => signatureMock.html,
}));

const { ComposeScreen } = await import("@/screens/compose-screen");

function Harness({ onChange }: { onChange?: (draft: ComposeDraft) => void }) {
  const [draft, setDraft] = useState<ComposeDraft>(baseDraft("perso", false, false));
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
