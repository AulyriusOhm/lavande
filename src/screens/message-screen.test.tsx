import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrefsProvider } from "@/lib/prefs";
import type { Mail } from "@/lib/mail";
import type { Thread } from "@/lib/threads";

const { attachment, saveBlob } = vi.hoisted(() => ({
  attachment: vi.fn(),
  saveBlob: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  mailApi: { attachment },
  errorText: (error: unknown) => (error instanceof Error ? error.message : "erreur inconnue"),
}));

vi.mock("@/lib/download", () => ({ saveBlob }));

const { MessageScreen } = await import("@/screens/message-screen");

const MAIL: Mail = {
  id: "perso:INBOX:12",
  account: "perso",
  folder: "inbox",
  source: { accountId: "perso", folderPath: "INBOX", uid: 12 },
  name: "Camille Rousseau",
  email: "camille@studio-lilas.fr",
  subject: "Factures de mars",
  preview: "Les factures du mois.",
  body: ["Les factures du mois."],
  time: "09:41",
  unread: false,
  starred: false,
  pgp: "none",
  attachments: [
    { name: "facture.pdf", size: "5 o", mime: "application/pdf", index: 0 },
    { name: "capture.png", size: "9 o", mime: "image/png", index: 1 },
  ],
  tone: 0,
};

const THREAD: Thread = {
  id: "t-factures",
  messages: [MAIL],
  primary: MAIL,
  count: 1,
  unread: 0,
  starred: false,
  encrypted: 0,
  attachments: 2,
  participants: ["Camille Rousseau"],
  subject: MAIL.subject,
  preview: MAIL.preview,
  time: "09:41",
  order: 0,
};

function renderScreen(mail: Mail = MAIL, onOpenPgp?: () => void) {
  const thread: Thread = { ...THREAD, messages: [mail], primary: mail };
  render(
    <PrefsProvider>
      <MessageScreen
        thread={thread}
        onClose={() => {}}
        onToggleStar={() => {}}
        onReply={() => {}}
        onOpenPgp={onOpenPgp}
      />
    </PrefsProvider>,
  );
}

const BANNER = "Message chiffré · PGP désactivé pour ce compte";

function disablePgp(accountId = "perso") {
  window.localStorage.setItem(
    "lavande.prefs",
    JSON.stringify({ pgpAccounts: { [accountId]: { enabled: false, encrypt: true, sign: true } } }),
  );
}

beforeEach(() => {
  attachment.mockReset();
  saveBlob.mockReset();
  window.localStorage.clear();
});

describe("bandeau PGP coupé", () => {
  it("explique pourquoi le corps chiffré reste vide", () => {
    disablePgp();
    renderScreen({ ...MAIL, pgp: "encrypted" });

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(
      screen.getByText("Active PGP pour ce compte dans les réglages pour le déchiffrer."),
    ).toBeTruthy();
  });

  it("disparaît quand le compte a PGP activé", () => {
    renderScreen({ ...MAIL, pgp: "encrypted" });

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("disparaît pour un message non chiffré", () => {
    disablePgp();
    renderScreen(MAIL);

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("disparaît une fois le corps chargé", () => {
    disablePgp();
    renderScreen({ ...MAIL, pgp: "encrypted", bodyFetched: true });

    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("ouvre les réglages depuis le bouton", () => {
    disablePgp();
    const onOpenPgp = vi.fn();
    renderScreen({ ...MAIL, pgp: "encrypted" }, onOpenPgp);

    fireEvent.click(screen.getByText("Ouvrir les réglages"));

    expect(onOpenPgp).toHaveBeenCalledTimes(1);
  });

  it("reste informatif sans bouton quand la navigation n'est pas câblée", () => {
    disablePgp();
    renderScreen({ ...MAIL, pgp: "encrypted" });

    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.queryByText("Ouvrir les réglages")).toBeNull();
  });
});

describe("téléchargement des pièces jointes", () => {
  it("récupère les octets du démon et enregistre le fichier", async () => {
    const blob = new Blob(["hello"], { type: "application/pdf" });
    attachment.mockResolvedValue(blob);
    renderScreen();

    fireEvent.click(screen.getByLabelText("Télécharger facture.pdf (5 o)"));

    await waitFor(() => expect(attachment).toHaveBeenCalledWith("perso", "INBOX", 12, 0));
    expect(saveBlob).toHaveBeenCalledWith(blob, "facture.pdf");
    expect(await screen.findByText("« facture.pdf » téléchargé")).toBeTruthy();
  });

  it("demande l'index de la pièce jointe cliquée", async () => {
    attachment.mockResolvedValue(new Blob(["x"]));
    renderScreen();

    fireEvent.click(screen.getByLabelText("Télécharger capture.png (9 o)"));

    await waitFor(() => expect(attachment).toHaveBeenCalledWith("perso", "INBOX", 12, 1));
  });

  it("affiche l'erreur du démon sans rien enregistrer", async () => {
    attachment.mockRejectedValue(new Error("serveur IMAP : connexion refusée"));
    renderScreen();

    fireEvent.click(screen.getByLabelText("Télécharger facture.pdf (5 o)"));

    expect(await screen.findByText("Téléchargement impossible · serveur IMAP : connexion refusée")).toBeTruthy();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("dit qu'une pièce jointe de la maquette n'a pas d'octets", async () => {
    renderScreen({
      ...MAIL,
      source: undefined,
      attachments: [{ name: "inbox-v3.fig", size: "4,2 Mo" }],
    });

    fireEvent.click(screen.getByLabelText("Télécharger inbox-v3.fig (4,2 Mo)"));

    expect(await screen.findByText(/vient de la maquette/)).toBeTruthy();
    expect(attachment).not.toHaveBeenCalled();
    expect(saveBlob).not.toHaveBeenCalled();
  });
});
