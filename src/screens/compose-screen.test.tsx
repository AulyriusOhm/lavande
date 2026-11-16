import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ComposeDraft } from "@/lib/draft";
import { baseDraft } from "@/lib/draft";
import { buildQuotedHtml, textToHtml } from "@/lib/rich-text";
import { sendInputOf } from "@/lib/mail-backend";

const storeMock = vi.hoisted(() => ({ mode: "demo" as "api" | "demo" }));

vi.mock("@/lib/store", () => ({
  useMailStore: () => ({
    mailAccounts: [{ id: "perso", label: "Perso", email: "roman@lavande.mail" }],
    mode: storeMock.mode,
    folderRecords: [],
  }),
}));

const signatureMock = vi.hoisted(() => ({ html: null as string | null }));
const prefsMock = vi.hoisted(() => ({ threadView: "tidy" as "tidy" | "inline" }));
vi.mock("@/lib/prefs", () => ({
  usePrefs: () => ({ signatures: [], llm: { endpoint: "", apiKey: "", model: "" }, threadView: prefsMock.threadView }),
  activeSignature: () => signatureMock.html,
}));

const { ComposeScreen } = await import("@/screens/compose-screen");

function Harness({
  onChange,
  onSend,
  quoted,
  body,
  threadId,
  to,
  subject,
}: {
  onChange?: (draft: ComposeDraft) => void;
  onSend?: (draft: ComposeDraft) => void;
  quoted?: string;
  body?: string;
  threadId?: string;
  to?: string;
  subject?: string;
}) {
  const [draft, setDraft] = useState<ComposeDraft>({
    ...baseDraft("perso", false, false, threadId),
    quoted,
    body: body ?? "",
    to: to ?? "",
    subject: subject ?? "",
  });
  return (
    <ComposeScreen
      draft={draft}
      onDraftChange={(next) => {
        setDraft(next);
        onChange?.(next);
      }}
      onSend={onSend}
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
  prefsMock.threadView = "tidy";
  storeMock.mode = "demo";
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

describe("envoi · verrou et retours visuels", () => {
  const ready = (): ComposeDraft => ({
    ...baseDraft("perso", false, false),
    to: "camille@lavande.mail",
    subject: "Bonjour",
    body: "<p>Texte</p>",
  });

  function SendHarness({
    onSend,
    sending,
    sent,
    sendError,
  }: {
    onSend?: () => void;
    sending?: boolean;
    sent?: boolean;
    sendError?: string | null;
  }) {
    const [draft, setDraft] = useState<ComposeDraft>(ready);
    return (
      <ComposeScreen
        draft={draft}
        onDraftChange={setDraft}
        onClose={() => {}}
        onSend={() => onSend?.()}
        sending={sending}
        sent={sent}
        sendError={sendError}
      />
    );
  }

  function StoreLikeHarness({ onSend }: { onSend: () => void }) {
    const [draft, setDraft] = useState<ComposeDraft>(ready);
    const [sending, setSending] = useState(false);
    return (
      <ComposeScreen
        draft={draft}
        onDraftChange={setDraft}
        onClose={() => {}}
        sending={sending}
        onSend={() => {
          setSending(true);
          onSend();
        }}
      />
    );
  }

  const sendButton = () => screen.getByLabelText("Envoyer le message") as HTMLButtonElement;

  it("verrouille le bouton et affiche « Envoi… » pendant l'envoi", () => {
    const onSend = vi.fn();
    render(<SendHarness sending onSend={onSend} />);

    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toContain("Envoi…");
    fireEvent.click(sendButton());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("affiche « Envoyé » une fois le message parti", () => {
    render(<SendHarness sent />);

    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toContain("Envoyé");
  });

  it("réactive le bouton et montre l'erreur quand l'envoi échoue", () => {
    render(<SendHarness sendError="Envoi impossible · smtp · relais refusé" />);

    expect(screen.getByRole("alert").textContent).toContain("Envoi impossible");
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent).toContain("Envoyer");
  });

  it("n'envoie qu'une fois malgré des clics répétés", () => {
    const onSend = vi.fn();
    render(<StoreLikeHarness onSend={onSend} />);

    fireEvent.click(sendButton());
    for (let index = 0; index < 35; index += 1) fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(sendButton().disabled).toBe(true);
  });
});

describe("conversation dans la rédaction", () => {
  const QUOTED = buildQuotedHtml("Le 9 novembre, Support a écrit :", textToHtml("Bonjour\nSuite du fil"));

  it("range le fil dans un panneau repliable et masque la citation", async () => {
    render(<Harness quoted={QUOTED} threadId="t-maquettes" />);

    expect(await screen.findByRole("button", { name: "Voir la conversation · 4 messages" })).toBeTruthy();
    expect(screen.getByTestId("conversation-panel")).toBeTruthy();
    expect(screen.queryByTestId("compose-quoted-block")).toBeNull();
    expect(screen.queryByRole("button", { name: "Voir la conversation précédente" })).toBeNull();
  });

  it("place le panneau après l'aperçu de signature", async () => {
    signatureMock.html = "<p>Cordialement</p>";
    render(<Harness quoted={QUOTED} threadId="t-maquettes" />);

    const preview = screen.getByTestId("signature-preview");
    const panel = await screen.findByTestId("conversation-panel");
    expect(preview.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("garde la citation classique en mode « tout dans le même mail »", () => {
    prefsMock.threadView = "inline";
    render(<Harness quoted={QUOTED} threadId="t-maquettes" />);

    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Voir la conversation précédente" }));
    expect(screen.getByTestId("compose-quoted").textContent).toContain("Suite du fil");
  });

  it("retombe sur la citation quand le fil manque", () => {
    render(<Harness quoted={QUOTED} />);

    expect(screen.getByTestId("compose-quoted-block")).toBeTruthy();
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
  });

  it("n'ajoute rien au payload d'envoi, dans les deux modes", async () => {
    const sent: ComposeDraft[] = [];
    const props = {
      quoted: QUOTED,
      threadId: "t-maquettes",
      to: "camille@lavande.mail",
      subject: "Re: Maquettes",
      body: "<p>Merci</p>",
      onSend: (draft: ComposeDraft) => sent.push(draft),
    };

    const tidy = render(<Harness {...props} />);
    expect(await screen.findByTestId("conversation-panel")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Envoyer le message"));
    await waitFor(() => expect(sent).toHaveLength(1));
    tidy.unmount();

    prefsMock.threadView = "inline";
    render(<Harness {...props} />);
    fireEvent.click(screen.getByLabelText("Envoyer le message"));
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[0].quoted).toBe(QUOTED);
    expect(sent[1].quoted).toBe(QUOTED);
    for (const draft of sent) {
      const input = sendInputOf(draft);
      expect(input.html).toContain("Suite du fil");
      expect(input.text).toContain("Suite du fil");
      expect(input.to).toEqual([{ name: null, email: "camille@lavande.mail" }]);
    }
  });
});
